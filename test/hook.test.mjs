import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decide, buildReceiptMessage } from '../hook.mjs'

let server
let baseUrl
const seen = []

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      seen.push({ path: req.url, payload })
      const cmd = String(payload.tool_input?.command ?? '')
      res.setHeader('content-type', 'application/json')
      if (req.url === '/govern/tool-output') {
        if (String(payload.tool_output ?? '').includes('BOOM')) {
          return res.end(JSON.stringify({ action: 'block', reason: 'flagged output' }))
        }
        return res.end(JSON.stringify({ action: 'pass' }))
      }
      if (cmd.includes('rm -rf')) return res.end(JSON.stringify({ decision: 'deny', reason: 'hardline floor' }))
      if (cmd.includes('git push')) return res.end(JSON.stringify({ decision: 'ask', reason: 'outward-facing' }))
      if (cmd.includes('boom-500')) { res.statusCode = 500; return res.end('{}') }
      return res.end(JSON.stringify({ decision: 'allow' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

function makeEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-acp-test-'))
  mkdirSync(join(home, '.acp'), { recursive: true })
  writeFileSync(join(home, '.acp', 'credentials'), 'test-token')
  return { HOME: home, ACP_GOVERN_BASE: baseUrl, ...extra }
}

function agyPayload(command, extra = {}) {
  return {
    conversationId: 'conv-123',
    workspacePaths: ['/tmp/project'],
    transcriptPath: '/tmp/project/.transcript.jsonl',
    modelName: 'gemini-3-pro',
    stepIdx: 4,
    toolCall: { name: 'run_command', args: { command } },
    ...extra,
  }
}

test('camelCase toolCall parses; allow comes back in Antigravity vocabulary', async () => {
  const { out } = await decide(agyPayload('npm test'), 'pre_tool_use', makeEnv())
  assert.equal(out.decision, 'allow')
  const sent = seen.at(-1)
  assert.equal(sent.path, '/govern/tool-use')
  assert.equal(sent.payload.tool_name, 'Bash')
  assert.equal(sent.payload.client_tool_name, 'run_command')
  assert.equal(sent.payload.tool_input.command, 'npm test')
  assert.equal(sent.payload.hook_event_name, 'PreToolUse')
  assert.equal(sent.payload.session_id, 'conv-123')
  assert.equal(sent.payload.cwd, '/tmp/project')
})

test('run_command arg-key spellings normalize to {command}', async () => {
  await decide(agyPayload('x', { toolCall: { name: 'run_command', args: { CommandLine: 'npm run build' } } }), 'pre_tool_use', makeEnv())
  const sent = seen.at(-1)
  assert.equal(sent.payload.tool_input.command, 'npm run build')
  assert.equal(sent.payload.tool_input.CommandLine, 'npm run build')
})

test('file tools map to canonical; unknown and MCP names pass through', async () => {
  await decide(agyPayload('x', { toolCall: { name: 'view_file', args: { AbsolutePath: '/etc/hosts' } } }), 'pre_tool_use', makeEnv())
  assert.equal(seen.at(-1).payload.tool_name, 'Read')
  await decide(agyPayload('x', { toolCall: { name: 'some_mcp_server_tool', args: {} } }), 'pre_tool_use', makeEnv())
  assert.equal(seen.at(-1).payload.tool_name, 'some_mcp_server_tool')
})

test('policy deny emits decision:"deny" with reason — no exit-code channel', async () => {
  const { out, deny } = await decide(agyPayload('rm -rf /'), 'pre_tool_use', makeEnv())
  assert.equal(deny, true)
  assert.equal(out.decision, 'deny')
  assert.match(out.reason, /Denied by policy: hardline floor/)
})

test('policy ask maps to native force_ask', async () => {
  const { out } = await decide(agyPayload('git push origin main'), 'pre_tool_use', makeEnv())
  assert.equal(out.decision, 'force_ask')
  assert.match(out.reason, /Approval required/)
})

test('gateway unreachable: interactive fails OPEN and loud', async () => {
  const env = makeEnv({ ACP_GOVERN_BASE: 'http://127.0.0.1:9', ACP_CHECK_TIMEOUT_MS: '300' })
  const { out, warn } = await decide(agyPayload('npm test'), 'pre_tool_use', env)
  assert.equal(out.decision, 'allow')
  assert.match(warn, /UNGOVERNED/)
})

test('gateway unreachable: background tier fails CLOSED (env)', async () => {
  const env = makeEnv({ ACP_GOVERN_BASE: 'http://127.0.0.1:9', ACP_CHECK_TIMEOUT_MS: '300', ACP_AGENT_TIER: 'background' })
  const { out, deny } = await decide(agyPayload('npm test'), 'pre_tool_use', env)
  assert.equal(deny, true)
  assert.equal(out.decision, 'deny')
  assert.match(out.reason, /fail-closed/)
})

test('agent_tier from ~/.acp/config.json applies (sanitized-env path)', async () => {
  const env = makeEnv({ ACP_GOVERN_BASE: 'http://127.0.0.1:9', ACP_CHECK_TIMEOUT_MS: '300' })
  writeFileSync(join(env.HOME, '.acp', 'config.json'), JSON.stringify({ agent_tier: 'background' }))
  const { out } = await decide(agyPayload('npm test'), 'pre_tool_use', env)
  assert.equal(out.decision, 'deny')
})

test('HTTP 500 is the server answering — no retry storm', async () => {
  const before500 = seen.length
  const { out } = await decide(agyPayload('boom-500'), 'pre_tool_use', makeEnv())
  assert.equal(out.decision, 'allow')
  assert.equal(seen.length - before500, 1)
})

test('missing credential allows loudly instead of deciding silently', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-acp-nocred-'))
  const { out, warn } = await decide(agyPayload('npm test'), 'pre_tool_use', { HOME: home, ACP_GOVERN_BASE: baseUrl })
  assert.equal(out.decision, 'allow')
  assert.match(warn, /UNGOVERNED: no credential/)
  rmSync(home, { recursive: true, force: true })
})

test('PostToolUse with null toolCall is noise — filtered', async () => {
  const before = seen.length
  const { out, warn } = await decide(agyPayload('x', { toolCall: null }), 'post_tool_use', makeEnv())
  assert.deepEqual(out, {})
  assert.equal(warn, undefined)
  assert.equal(seen.length, before)
})

test('PostToolUse posts audit record; block degrades to a loud line', async () => {
  const { out, warn } = await decide(agyPayload('echo hi', { error: 'BOOM: something broke' }), 'post_tool_use', makeEnv())
  assert.deepEqual(out, {})
  assert.match(warn, /Flagged after the fact/)
  const sent = seen.at(-1)
  assert.equal(sent.path, '/govern/tool-output')
  assert.equal(sent.payload.tool_errored, true)
})

test('PostToolUse pass emits nothing', async () => {
  const { out, warn } = await decide(agyPayload('echo hi'), 'post_tool_use', makeEnv())
  assert.deepEqual(out, {})
  assert.equal(warn, undefined)
})

test('Stop answers {"decision":"stop"} — never "continue"', async () => {
  const { out } = await decide({ conversationId: 'no-stats-conv' }, 'stop', makeEnv())
  assert.deepEqual(out, { decision: 'stop' })
})

test('receipt message formats counts and console link', () => {
  const line = buildReceiptMessage({ calls: 3, denied: 1, asked: 0, notices: 0 }, 'c-9')
  assert.match(line, /3 tool calls governed · 1 denied/)
  assert.match(line, /sessions\/c-9/)
})
