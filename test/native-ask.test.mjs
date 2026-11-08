// gatewaystack-connect#1518: honest attended claim + native_ask on PreToolUse,
// and the gateway's branded ask reason reaching the force_ask card verbatim.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decide, askReason, resolveAttended, ACP_ASK_PREFIX } from '../hook.mjs'

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
      res.setHeader('content-type', 'application/json')
      if (req.url === '/govern/tool-output') return res.end(JSON.stringify({ action: 'pass' }))
      const cmd = String(payload.tool_input?.command ?? '')
      if (cmd.includes('git push')) {
        return res.end(JSON.stringify({ decision: 'ask', reason: `${ACP_ASK_PREFIX}Force-push main to origin\n  git push --force origin main · destructive floor · yes = run once` }))
      }
      return res.end(JSON.stringify({ decision: 'allow' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

function makeEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-acp-ask-'))
  mkdirSync(join(home, '.acp'), { recursive: true })
  writeFileSync(join(home, '.acp', 'credentials'), 'test-token')
  return { HOME: home, ACP_GOVERN_BASE: baseUrl, ...extra }
}

const payload = (command) => ({
  conversationId: 'conv-ask',
  workspacePaths: ['/tmp/project'],
  toolCall: { name: 'run_command', args: { CommandLine: command } },
})

test('PreToolUse carries attended {claim, source} and native_ask; PostToolUse carries neither', async () => {
  seen.length = 0
  await decide(payload('ls'), 'pre_tool_use', makeEnv())
  const pre = seen.find((s) => s.path === '/govern/tool-use').payload
  assert.deepEqual(pre.attended, { claim: true, source: 'config' })
  assert.deepEqual(pre.capabilities, ['native_ask'])
  assert.equal(pre.agent_tier, 'interactive')
  seen.length = 0
  await decide(payload('ls'), 'post_tool_use', makeEnv())
  const post = seen.find((s) => s.path === '/govern/tool-output').payload
  assert.equal('attended' in post, false)
  assert.equal('capabilities' in post, false)
})

test('a pinned background tier is a positive claim:false, and the source names where the tier came from', async () => {
  seen.length = 0
  const env = makeEnv()
  writeFileSync(join(env.HOME, '.acp', 'config.json'), JSON.stringify({ agent_tier: 'background' }))
  await decide(payload('ls'), 'pre_tool_use', env)
  assert.deepEqual(seen[0].payload.attended, { claim: false, source: 'config' })
  assert.equal(seen[0].payload.agent_tier, 'background')
  seen.length = 0
  await decide(payload('ls'), 'pre_tool_use', makeEnv({ ACP_AGENT_TIER: 'interactive' }))
  assert.deepEqual(seen[0].payload.attended, { claim: true, source: 'env' })
  seen.length = 0
  await decide(payload('ls'), 'pre_tool_use', makeEnv({ CI: '1' }))
  assert.deepEqual(seen[0].payload.attended, { claim: false, source: 'env' })
  assert.deepEqual(resolveAttended({}, {}), { tier: 'interactive', claim: true, source: 'config' })
})

test('an ACP ask reaches the force_ask card with the gateway reason verbatim (no second headline)', async () => {
  seen.length = 0
  const r = await decide(payload('git push --force origin main'), 'pre_tool_use', makeEnv())
  assert.equal(r.out.decision, 'force_ask')
  assert.ok(r.out.reason.startsWith(`${ACP_ASK_PREFIX}Force-push main to origin`), r.out.reason)
  assert.equal(r.out.reason.includes('[ACP] Approval required'), false)
})

test('askReason: branded reasons pass through, unbranded ones get our headline', () => {
  assert.equal(askReason(`${ACP_ASK_PREFIX}x`), `${ACP_ASK_PREFIX}x`)
  assert.equal(askReason('outward-facing'), '[ACP] Approval required: outward-facing')
  assert.equal(askReason(undefined), '[ACP] Approval required: approval required')
})
