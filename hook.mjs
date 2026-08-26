#!/usr/bin/env node
/**
 * Agentic Control Plane hook for Google Antigravity (agy — CLI, IDE, and app).
 *
 * Antigravity hooks are one-shot shell commands: the harness invokes the
 * command per lifecycle event with a camelCase JSON payload on stdin and
 * reads a decision from stdout. The payload does NOT name its event, so the
 * registration in hooks/acp.json passes it as the first CLI argument:
 *
 *   hook.mjs pre_tool_use   -> POST {ACP_GOVERN}/govern/tool-use
 *   hook.mjs post_tool_use  -> POST {ACP_GOVERN}/govern/tool-output (audit)
 *   hook.mjs stop           -> session receipt (gatewaystack-connect#606)
 *
 * OUTPUT CONTRACT (official docs antigravity.google/docs/hooks/ + binary
 * strings of agy 1.1.21, 2026-08-26):
 *   - PreToolUse parses top-level `decision`: "allow" | "deny" | "ask" |
 *     "force_ask" | "deny_unless_prior_grant" (+ optional `reason`,
 *     `permissionOverrides`). Unknown values are an "unknown pre-tool hook
 *     decision" error; empty decisions are tolerated (changelog 1.1.x).
 *   - There is NO exit-code deny channel. A failing hook (crash, timeout,
 *     non-zero exit) is an error path — "pre-tool hook failed" — and blocks
 *     the call (fail-closed by the harness). This hook therefore ALWAYS
 *     exits 0 and encodes every outcome, including its own crash handling,
 *     as JSON on stdout.
 *   - Stop parses `decision`: "continue" re-enters the loop; anything else
 *     allows the stop. We emit {"decision":"stop"} — a receipt must never
 *     hold an agent hostage.
 *
 * ASK MAPPING: Antigravity is the first harness we integrate with a native
 * ask in the hook vocabulary. An ACP `ask` verdict maps to `force_ask` —
 * it prompts the human and deliberately ignores cached "Always Allow"
 * grants, so a local allow rule cannot outrank an ACP ask (the caveat we
 * document on Grok Build does not exist here). In headless mode (`-p`),
 * Antigravity soft-denies unobtainable approvals itself — the empty chair
 * resolves to deny natively, with a stderr notice.
 *
 * PostToolUse carries `toolCall` + `error` but NOT the tool's output, so the
 * post-hoc call is an audit/completion record, not a content scan. (The
 * transcript file named in the payload has the full exchange; reading it
 * from the hook is a possible future enhancement.)
 *
 * Unreachability posture (gatewaystack-connect#385, never-brick): interactive
 * sessions fail OPEN with a loud UNGOVERNED warning and a ~/.acp/lapse.log
 * entry; unattended tiers fail CLOSED — nobody is watching, so the block is
 * the safety net. Antigravity runs hooks with a sanitized environment, so
 * unattended fleets should pin `agent_tier` in ~/.acp/config.json rather
 * than rely on env vars reaching the hook.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOOK_VERSION = '0.1.0'

/** 200 KB ceiling on payload content sent for post-hoc audit (matches the backend). */
const POST_HOOK_PAYLOAD_CEILING = 200 * 1024

/** Hook decision budget: control-plane calls answer fast or get out of the way.
 * Keep well under the registered hook timeout (30s in hooks/acp.json) so our
 * fail posture decides the outcome, not the harness's fail-closed error path. */
const CHECK_TIMEOUT_MS = 4000

const ACP_DIR = join(homedir(), '.acp')

function acpDir(env = process.env) {
  return env.HOME ? join(env.HOME, '.acp') : ACP_DIR
}

function readToken(env = process.env) {
  if (env.ACP_BEARER_TOKEN) return env.ACP_BEARER_TOKEN
  // Same order as the other harness plugins' credential lookup — keep in sync.
  for (const file of ['credentials', 'proxy-key']) {
    try {
      const value = readFileSync(join(acpDir(env), file), 'utf8').trim()
      if (value) return value
    } catch { /* absent or unreadable — try the next path */ }
  }
  return null
}

function lapseLine(fields) {
  try {
    mkdirSync(ACP_DIR, { recursive: true })
    appendFileSync(
      join(ACP_DIR, 'lapse.log'),
      JSON.stringify({ at: new Date().toISOString(), client: 'antigravity-hook', ...fields }) + '\n',
    )
  } catch { /* the lapse log is best-effort — never block a call on it */ }
}

/**
 * Tier resolution, in trust order: explicit env, config file, CI markers.
 * Antigravity's payload has no permission-mode field and its hook env is
 * sanitized, so unattended fleets pin agent_tier in ~/.acp/config.json.
 * Default is interactive (fail-open-loud posture).
 */
function resolveTier(env = process.env, config = {}) {
  if (env.ACP_AGENT_TIER) return env.ACP_AGENT_TIER
  if (config.agent_tier) return config.agent_tier
  if (env.CI) return 'background'
  return 'interactive'
}

/**
 * Antigravity-native -> canonical tool names. The gateway's content floors
 * key on the canonical vocabulary (gatewaystack-connect#750) — the canonical
 * name goes in `tool_name` and the native name rides along as
 * `client_tool_name` for audit fidelity. Unknown names (including MCP
 * tools) pass through unchanged.
 */
const CANONICAL_TOOL = {
  run_command: 'Bash',
  view_file: 'Read',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  list_dir: 'Glob',
  search_web: 'WebSearch',
  read_url_content: 'WebFetch',
  invoke_subagent: 'Task',
}

/**
 * Normalize run_command argument spellings to the canonical {command} shape
 * the floors expect. The exact arg key in agy's payload is unverified until
 * the live e2e — every plausible spelling maps, and the original args are
 * always preserved alongside.
 */
function canonicalInput(nativeName, args) {
  if (nativeName === 'run_command' && args && typeof args === 'object' && !args.command) {
    const cmd = args.CommandLine ?? args.commandLine ?? args.cmd ?? args.Command
    if (typeof cmd === 'string') return { ...args, command: cmd }
  }
  return args ?? {}
}

/** Canonicalize the event argument: "pre_tool_use" / "PreToolUse" / "preToolUse". */
function canonEvent(value) {
  const flat = String(value ?? '').replace(/[_-]/g, '').toLowerCase()
  const map = {
    pretooluse: 'PreToolUse',
    posttooluse: 'PostToolUse',
    preinvocation: 'PreInvocation',
    postinvocation: 'PostInvocation',
    stop: 'Stop',
  }
  return map[flat] ?? 'PreToolUse'
}

function normalize(payload, event) {
  const toolCall = payload?.toolCall ?? null
  return {
    event,
    toolCall,
    toolName: toolCall?.name ?? 'unknown',
    toolArgs: toolCall?.args ?? {},
    error: typeof payload?.error === 'string' ? payload.error : '',
    sessionId: payload?.conversationId,
    cwd: Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : undefined,
    modelName: payload?.modelName,
    stepIdx: payload?.stepIdx,
  }
}

const ALLOW = { decision: 'allow' }
/** Stop output: anything other than "continue" allows the stop. */
const ALLOW_STOP = { decision: 'stop' }

function encodeDeny(reason) {
  return { decision: 'deny', reason }
}

function encodeAsk(reason) {
  // force_ask: prompt the human, ignoring cached "Always Allow" grants —
  // an ACP ask must reach a person, not a remembered local rule. Headless
  // runs soft-deny this natively (the empty chair resolves to deny).
  return { decision: 'force_ask', reason }
}

/**
 * Operational overrides live in ~/.acp/config.json (govern_base, console_base,
 * agent_tier, shadow, check_timeout_ms). Env wins when present, but note the
 * sanitized hook environment — the config file is the reliable channel.
 */
function readConfig(env = process.env) {
  try {
    return JSON.parse(readFileSync(join(acpDir(env), 'config.json'), 'utf8'))
  } catch { return {} }
}

async function post(base, headers, path, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
    })
    if (!res.ok) {
      // Tagged so the retry can tell "the server answered with a status" from
      // "the request never landed". Re-rolling a 429 would deepen the rate
      // limit it is reporting.
      const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
      err.httpStatus = res.status
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// --- Session receipt bookkeeping. Each hook invocation is a fresh process,
// so counts live in a per-session file; a stats failure must never affect a
// call, so every touch is wrapped. ---
function statsPath(sessionId) {
  return join(ACP_DIR, 'antigravity-sessions', `${String(sessionId).replace(/[^\w-]/g, '_')}.json`)
}

function bump(sessionId, field) {
  if (!sessionId) return
  try {
    mkdirSync(join(ACP_DIR, 'antigravity-sessions'), { recursive: true })
    const p = statsPath(sessionId)
    let s = { calls: 0, denied: 0, asked: 0, notices: 0 }
    try { s = JSON.parse(readFileSync(p, 'utf8')) } catch { /* first call this session */ }
    s[field] = (s[field] ?? 0) + 1
    writeFileSync(p, JSON.stringify(s))
  } catch { /* bookkeeping only */ }
}

export function buildReceiptMessage(stats, sessionId, consoleBase = 'https://cloud.agenticcontrolplane.com') {
  if (!stats || !(stats.calls > 0)) return null
  const parts = [`${stats.calls} tool call${stats.calls === 1 ? '' : 's'} governed`]
  if (stats.denied > 0) parts.push(`${stats.denied} denied`)
  if (stats.asked > 0) parts.push(`${stats.asked} held for approval`)
  if (stats.notices > 0) parts.push(`${stats.notices} shadow notice${stats.notices === 1 ? '' : 's'}`)
  const url = `${consoleBase}/sessions/${encodeURIComponent(String(sessionId))}`
  return `[ACP] Session receipt: ${parts.join(' · ')} — review this session: ${url}`
}

export async function decide(payload, event, env = process.env) {
  const call = normalize(payload, canonEvent(event))
  const config = readConfig(env)
  const tier = resolveTier(env, config)
  const token = readToken(env)

  if (call.event === 'Stop') {
    // Session end: emit the receipt to stderr (scrollback) and clear the
    // counter file. Never emit "continue" — a receipt must not be able to
    // keep the agent running.
    try {
      const p = statsPath(call.sessionId)
      const s = JSON.parse(readFileSync(p, 'utf8'))
      unlinkSync(p)
      const line = buildReceiptMessage(s, call.sessionId, env.ACP_CONSOLE_BASE ?? config.console_base)
      return line ? { out: ALLOW_STOP, warn: line } : { out: ALLOW_STOP }
    } catch { return { out: ALLOW_STOP } }
  }

  // PostToolUse fires on non-tool steps with a null toolCall (observed in
  // the field) — filter the noise before it reaches the audit trail.
  if (call.event === 'PostToolUse' && !call.toolCall) return { out: {} }

  if (!token) {
    // Loud, once per invocation, plus a durable lapse line — an uncredentialed
    // control plane must never be mistaken for a live one.
    lapseLine({ kind: 'UNGOVERNED', reason: 'no-credentials', tool: call.toolName, session: call.sessionId })
    const warn = '[ACP] ⚠ UNGOVERNED: no credential (ACP_BEARER_TOKEN or ~/.acp/credentials) — '
      + 'tool calls run WITHOUT policy checks and ACP has no record of them. '
      + 'Connect at https://cloud.agenticcontrolplane.com'
    return { out: call.event === 'PostToolUse' ? {} : ALLOW, warn }
  }

  const govern = (env.ACP_GOVERN_BASE ?? env.ACP_API_BASE ?? config.govern_base ?? 'https://govern.agenticcontrolplane.com').replace(/\/$/, '')
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GS-Client': `antigravity-hook/${HOOK_VERSION}`,
  }
  const timeoutMs = Number(env.ACP_CHECK_TIMEOUT_MS) || Number(config.check_timeout_ms) || CHECK_TIMEOUT_MS
  const base = {
    tool_name: CANONICAL_TOOL[call.toolName] ?? call.toolName,
    client_tool_name: call.toolName,
    tool_input: canonicalInput(call.toolName, call.toolArgs),
    session_id: call.sessionId,
    cwd: call.cwd,
    hook_event_name: call.event,
    agent_tier: tier,
  }

  if (call.event === 'PostToolUse') {
    // No tool output in the payload — this is an audit/completion record
    // (success or the error string), not a content scan.
    let outputStr = call.error || ''
    if (Buffer.byteLength(outputStr, 'utf8') > POST_HOOK_PAYLOAD_CEILING) {
      outputStr = outputStr.slice(0, POST_HOOK_PAYLOAD_CEILING)
    }
    let data
    try {
      data = await post(govern, headers, '/govern/tool-output', { ...base, tool_output: outputStr, tool_errored: Boolean(call.error) }, timeoutMs)
    } catch {
      // Post-hoc audit is observability: silent pass-through, the call
      // already ran. The pre-call check is where unreachability gets loud.
      return { out: {} }
    }
    if (data.action === 'block') {
      // PostToolUse output is {} by contract — a post-hoc block can't stop
      // anything here, so it degrades to a loud audit line. The gateway
      // still has the full record.
      bump(call.sessionId, 'denied')
      return { out: {}, warn: `[ACP] Flagged after the fact: ${data.reason ?? 'policy'} — recorded in the audit log.` }
    }
    if (typeof data.notice === 'string' && data.notice.trim() && !/^(off|0|false)$/i.test(env.ACP_SHADOW ?? config.shadow ?? '')) {
      // Shadow-mode counterfactual (#607): advisory, arrives with action "pass".
      bump(call.sessionId, 'notices')
      return { out: {}, warn: data.notice }
    }
    return { out: {} }
  }

  // PreToolUse resolves against the pre-call policy.
  let data
  try {
    try {
      data = await post(govern, headers, '/govern/tool-use', base, timeoutMs)
    } catch (first) {
      // Retry once before applying the fail posture (gatewaystack-connect#690):
      // slow answers are cold starts, so the retry lands on a warm instance.
      // Retry only a transport failure — an HTTP status is the server answering.
      if (first?.httpStatus !== undefined) throw first
      data = await post(govern, headers, '/govern/tool-use', base, timeoutMs)
    }
  } catch (error) {
    const detail = error?.name === 'AbortError' ? 'request timed out' : (error?.message ?? 'network error')
    if (tier === 'interactive') {
      lapseLine({ kind: 'UNGOVERNED', tool: call.toolName, tier, detail })
      const warn = `[ACP] ⚠ UNGOVERNED: gateway unreachable (${detail}) — ${call.toolName} proceeded WITHOUT policy check. Lapse logged to ~/.acp/lapse.log.`
      return { out: ALLOW, warn }
    }
    return {
      out: encodeDeny(
        `[ACP] Gateway unreachable (${detail}) — ${tier} tier stays blocked when policy can't be consulted (fail-closed for unattended agents; interactive sessions fail open).`),
      deny: true,
    }
  }

  bump(call.sessionId, 'calls')
  if (data.decision === 'deny') {
    bump(call.sessionId, 'denied')
    return { out: encodeDeny(`[ACP] Denied by policy: ${data.reason ?? 'policy did not return a reason'}`), deny: true }
  }
  if (data.decision === 'ask') {
    bump(call.sessionId, 'asked')
    // Native force_ask: the human answers at Antigravity's own prompt card,
    // cached "Always Allow" grants notwithstanding. Headless soft-denies.
    return { out: encodeAsk(`[ACP] Approval required: ${data.reason ?? 'approval required'}`) }
  }
  if (data.warning) return { out: ALLOW, warn: String(data.warning) }
  return { out: ALLOW }
}

export async function runHook(eventArg) {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let payload = {}
  try { payload = JSON.parse(raw) } catch { /* empty or non-JSON stdin — still answer */ }

  let result
  try {
    result = await decide(payload, eventArg)
  } catch (error) {
    // The harness treats a failing hook as fail-closed — a crash here would
    // block the call AND leave no record of why. Answer with an explicit
    // allow plus a loud trace instead of letting the error path decide.
    lapseLine({ kind: 'HOOK_ERROR', detail: error?.message })
    result = { out: ALLOW, warn: `[ACP] hook error (${error?.message ?? 'unknown'}) — call proceeded WITHOUT policy check` }
  }
  if (result.warn) process.stderr.write(result.warn + '\n')
  process.stdout.write(JSON.stringify(result.out) + '\n')
  // ALWAYS exit 0: Antigravity treats any non-zero exit as a hook failure
  // and blocks the call. Decisions travel in JSON only.
}

// Only run the CLI when invoked directly — tests import decide() without I/O.
if (import.meta.url === `file://${process.argv[1]}`) {
  runHook(process.argv[2])
}
