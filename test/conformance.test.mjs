// L1 shared conformance corpus adapter for antigravity-acp-plugin.
// gatewaystack-connect#1344 — see test/fixtures/plugin-corpus.json (vendored
// byte-identical from davidcrowe/gatewaystack-connect:conformance/plugin-corpus.json).
//
// This drives the plugin's REAL entry point (a spawned `node hook.mjs <event>`
// child process, stdin JSON in, stdout/stderr captured) against a fake gateway,
// so it exercises the full runHook() -> decide() -> stdout/stderr contract —
// not just the decide() function in isolation like test/hook.test.mjs does.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK_PATH = join(__dirname, '..', 'hook.mjs') // this worktree's own hook.mjs
const CORPUS_PATH = join(__dirname, 'fixtures', 'plugin-corpus.json')
const PLUGIN_NAME = 'antigravity-acp-plugin'
const PINNED_FINGERPRINT = 'aa186d3fb3e7d18c'

// --- Fingerprint gate: hash the vendored copy's RAW BYTES, never a re-serialised object ---
const rawBytes = readFileSync(CORPUS_PATH) // Buffer — no encoding, so no re-serialisation
const fingerprint = createHash('sha256').update(rawBytes).digest('hex').slice(0, 16)

test('vendored corpus fingerprint matches the pinned value', () => {
  assert.equal(
    fingerprint,
    PINNED_FINGERPRINT,
    `test/fixtures/plugin-corpus.json has drifted from the canonical corpus `
    + `(got ${fingerprint}, pinned ${PINNED_FINGERPRINT}) — re-vendor a byte-identical copy `
    + `from davidcrowe/gatewaystack-connect:conformance/plugin-corpus.json`,
  )
})

const corpus = JSON.parse(rawBytes.toString('utf8'))
const MARKER = corpus.marker // 'ACPCONF7F3A'

function caseById(id) {
  const found = corpus.cases.find((c) => c.id === id)
  assert.ok(found, `corpus is missing case "${id}"`)
  return found
}

function rowFor(capability) {
  const found = corpus.harnesses.find((h) => h.plugin === PLUGIN_NAME && h.capability === capability)
  assert.ok(found, `corpus has no ${PLUGIN_NAME}/${capability} row`)
  return found
}

test('corpus declares antigravity notice + post-tool as supported', () => {
  assert.equal(rowFor('notice').status, 'supported')
  assert.equal(rowFor('post-tool').status, 'supported')
})

// --- Canonical mappings this adapter declares (kept in sync with hook.mjs) ---
// Native Antigravity tool name for a shell command, and the CANONICAL_TOOL
// mapping hook.mjs itself applies before the tool_name it sends to the gateway.
const NATIVE_SHELL_TOOL = 'run_command'
const CANONICAL_SHELL_TOOL = 'Bash' // hook.mjs: CANONICAL_TOOL.run_command === 'Bash'

// Antigravity's native PostToolUse payload has NO field carrying a
// successful command's stdout — hook.mjs's own header comment says so:
// "PostToolUse carries toolCall + error but NOT the tool's output, so the
// post-hoc call is an audit/completion record, not a content scan." The
// `error` string is the ONLY field that reaches tool_output
// (hook.mjs: `let outputStr = call.error || ''`). To drive the corpus's
// output content through the plugin's real pipe at all, this adapter maps
// corpus call.output -> native payload.error. This is a documented adapter
// choice, not a plugin source change.
function nativePostToolPayload(call) {
  return {
    conversationId: call.sessionId,
    workspacePaths: ['/tmp/acpconf-project'],
    toolCall: { name: NATIVE_SHELL_TOOL, args: { command: call.command } },
    error: call.output,
  }
}

function nativeNoopPostToolPayload(sessionId) {
  return {
    conversationId: sessionId,
    workspacePaths: ['/tmp/acpconf-project'],
    toolCall: { name: NATIVE_SHELL_TOOL, args: { command: 'echo hi' } },
  }
}

// --- Fake gateway: 127.0.0.1, port 0. /govern/tool-output replies with the
// case's gatewayReply; every other path replies {"decision":"allow"}. ---
let server
let baseUrl
let requests
let nextReply

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let parsed = {}
      try { parsed = JSON.parse(body || '{}') } catch { /* non-JSON body — record as-is */ }
      requests.push({ method: req.method, path: req.url, body: parsed })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/govern/tool-output') {
        res.end(JSON.stringify(nextReply))
      } else {
        res.end(JSON.stringify({ decision: 'allow' }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

// Spawns the REAL entry point: `node hook.mjs <event>` with JSON on stdin.
// HOME is a fresh temp dir per call — isolates state (~/.acp/config.json,
// lapse.log, per-session stats) so nothing here can touch, or be suppressed
// by, the developer machine's real ACP state. The env object is built from
// scratch (only PATH + explicit values) rather than inheriting process.env,
// so any ACP_SHADOW set in the outer shell is never accidentally forwarded —
// each case.env is layered on top explicitly instead.
function runHookProcess(eventArg, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'acpconf-agy-'))
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      ACP_GOVERN_BASE: baseUrl,
      ACP_BEARER_TOKEN: 'gsk_test_dummy0000000000000000', // dummy credential, never a real key
      ...extraEnv,
    }
    const child = spawn(process.execPath, [HOOK_PATH, eventArg], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => {
      rmSync(home, { recursive: true, force: true })
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

// Empty unless a real, evidenced failure was found for a case the corpus
// marks "supported" for this plugin. A NEW entry must ship with hard
// evidence in the PR/report; plugin source is never patched to clear one.
const EXPECTED_DIVERGENCES = []

test('case notice-shown: notice text reaches stderr (runHook\'s warn channel — process.stderr.write(result.warn))', async () => {
  const c = caseById('notice-shown')
  requests = []
  nextReply = c.gatewayReply
  const { code, stdout, stderr } = await runHookProcess(
    'post_tool_use',
    nativeNoopPostToolPayload('acpconf-notice-shown'),
    c.env,
  )
  assert.equal(code, 0, 'hook must always exit 0 (never-brick contract)')
  const personSees = stderr.includes(c.expect.contains)
  assert.equal(personSees, c.expect.personSees, `expected personSees=${c.expect.personSees}; stderr was: ${JSON.stringify(stderr)}`)
  // stdout carries only the machine decision JSON, never notice prose
  assert.equal(stdout.includes(c.expect.contains), false, `marker leaked into stdout: ${stdout}`)
})

test('case notice-shadow-off: ACP_SHADOW=off silences the notice on every captured channel (stdout + stderr)', async () => {
  const c = caseById('notice-shadow-off')
  requests = []
  nextReply = c.gatewayReply
  const { code, stdout, stderr } = await runHookProcess(
    'post_tool_use',
    nativeNoopPostToolPayload('acpconf-notice-shadow-off'),
    c.env,
  )
  assert.equal(code, 0)
  assert.equal(c.expect.personSees, false)
  assert.equal(stdout.includes(c.expect.contains), false, `marker leaked into stdout: ${stdout}`)
  assert.equal(stderr.includes(c.expect.contains), false, `marker leaked into stderr: ${stderr}`)
})

test('case post-tool-fields: outgoing POST /govern/tool-output body carries the required fields', async () => {
  const c = caseById('post-tool-fields')
  requests = []
  nextReply = c.gatewayReply
  const { code } = await runHookProcess('post_tool_use', nativePostToolPayload(c.call), c.env)
  assert.equal(code, 0)

  const sent = requests.find((r) => r.path === '/govern/tool-output')
  assert.ok(sent, 'plugin never called /govern/tool-output')
  assert.equal(sent.method, 'POST')
  assert.equal(sent.path, '/govern/tool-output')
  assert.equal(sent.body.hook_event_name, 'PostToolUse')
  assert.equal(
    sent.body.tool_name,
    CANONICAL_SHELL_TOOL,
    `expected the declared canonical mapping ${NATIVE_SHELL_TOOL} -> ${CANONICAL_SHELL_TOOL}`,
  )
  assert.equal(typeof sent.body.tool_input, 'object')
  assert.ok(sent.body.tool_input !== null)
  assert.ok(JSON.stringify(sent.body.tool_input).includes(MARKER), 'tool_input does not carry the marker')
  assert.ok(JSON.stringify(sent.body.tool_output).includes(MARKER), 'tool_output does not carry the marker')
  assert.equal(typeof sent.body.session_id, 'string')
  assert.ok(sent.body.session_id.length > 0, 'session_id must be a non-empty string')
})

test('EXPECTED_DIVERGENCES matches reality exactly (empty: both corpus rows hold)', () => {
  assert.deepEqual(EXPECTED_DIVERGENCES, [])
})
