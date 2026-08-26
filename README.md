# @agenticcontrolplane/antigravity

![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

[Agentic Control Plane](https://agenticcontrolplane.com) hook for **Google Antigravity** (`agy` — the CLI, the IDE, and the app share one hook registration). Every tool call is checked against your workspace policy before it runs, and ACP approvals surface as **native Antigravity prompt cards** via `force_ask` — the first harness whose hook vocabulary carries a first-class ask.

Before any tool runs, ACP is consulted via `/govern/tool-use`; after it runs, an audit/completion record goes to `/govern/tool-output`. Session end emits a receipt with a review link.

## Install

~~~bash
curl -fsSL https://agenticcontrolplane.com/install.sh | bash
~~~

The installer detects Antigravity, places the hook at `~/.acp/hooks/antigravity/hook.mjs`, and **merges** the registration into `~/.gemini/config/hooks.json` under its own `acp` key — the file is shared by the CLI, IDE, and app, so it is never overwritten. Manual install:

~~~bash
mkdir -p ~/.acp/hooks/antigravity ~/.gemini/config
curl -fsSL https://raw.githubusercontent.com/agentic-control-plane/antigravity-acp-plugin/main/hook.mjs \
  -o ~/.acp/hooks/antigravity/hook.mjs
curl -fsSL https://raw.githubusercontent.com/agentic-control-plane/antigravity-acp-plugin/main/hooks/acp.json \
  -o ~/.acp/hooks/antigravity/acp.json
node -e 'const fs=require("fs");const p=process.env.HOME+"/.gemini/config/hooks.json";let cur={};try{cur=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};const add=JSON.parse(fs.readFileSync(process.env.HOME+"/.acp/hooks/antigravity/acp.json","utf8"));fs.writeFileSync(p,JSON.stringify({...cur,...add},null,2))'
~~~

Credentials live at `~/.acp/credentials` (the installer provisions them; or paste a workspace key from [cloud.agenticcontrolplane.com](https://cloud.agenticcontrolplane.com)). Verify with `/hooks` inside Antigravity.

## What it does

| Antigravity event | ACP call | Effect |
|---|---|---|
| `PreToolUse` (matcher `*`) | `POST /govern/tool-use` | `deny` blocks; `ask` becomes native `force_ask`; `allow` proceeds |
| `PostToolUse` | `POST /govern/tool-output` | Audit/completion record — the payload carries the call and error status, **not the tool's output**, so this is not a content scan |
| `Stop` | — | Session receipt in the scrollback with a console review link |

**Tool-name mapping.** Antigravity's native names (`run_command`, `view_file`, `replace_file_content`, …) map to the canonical vocabulary before the policy check so content floors fire; the native name is preserved as `client_tool_name` in the audit record. Unknown and MCP tool names pass through.

## The ask decision

An ACP `ask` maps to Antigravity's **`force_ask`**: the human gets a native prompt card, and cached "Always Allow" grants deliberately do not pre-empt it. Headless (`-p`), Antigravity itself soft-denies unobtainable approvals (run continues, exit 0, stderr notice) — the correct unattended resolution, natively.

## Failure posture

Antigravity's hook core is **fail-closed**: a crashed, timed-out, or non-zero-exiting hook blocks the tool call. This hook therefore always answers in JSON with exit 0 — including its own crash handling — and carries its own posture for gateway trouble:

- **Interactive sessions**: gateway unreachable → fail **open**, loudly — `[ACP] ⚠ UNGOVERNED` on stderr and a durable line in `~/.acp/lapse.log`. An ACP outage must never brick your session.
- **Unattended tiers**: fail **closed** — nobody is watching, so the block is the safety net.
- One retry on transport failure; HTTP error statuses are the server answering — never retried.
- Internal 4s decision budget ≪ the registered 30s timeout, so the hook always answers before the harness's error path.

Antigravity runs hooks with a **sanitized environment** — configuration rides in `~/.acp/config.json` (snake_case keys), not env vars. Unattended fleets should pin `"agent_tier": "background"` there.

## Configuration

| Env (when it reaches the hook) | Config key | Default |
|---|---|---|
| `ACP_BEARER_TOKEN` | — | `~/.acp/credentials` |
| `ACP_GOVERN_BASE` | `govern_base` | `https://govern.agenticcontrolplane.com` |
| `ACP_CONSOLE_BASE` | `console_base` | `https://cloud.agenticcontrolplane.com` |
| `ACP_AGENT_TIER` | `agent_tier` | `interactive` |
| `ACP_CHECK_TIMEOUT_MS` | `check_timeout_ms` | `4000` |
| `ACP_SHADOW` | `shadow` | shadow-mode notices on |

## Verified vs. pending

The contract (decision vocabulary incl. `force_ask`, fail-closed hook errors, camelCase payload with no event name, sanitized env, output-less `PostToolUse`) is verified against the official docs and the `agy` 1.1.21 binary. Pending first live end-to-end: the exact `run_command` arg key (the hook normalizes every plausible spelling) and behavior under `--dangerously-skip-permissions`.

## Tests

~~~bash
node --test test/*.test.mjs
~~~

15 offline tests against a mock gateway: payload parsing, canonical mapping, deny/force_ask/allow, both fail postures, config-file tier resolution, retry discipline, PostToolUse noise filtering, receipts.

## License

MIT
