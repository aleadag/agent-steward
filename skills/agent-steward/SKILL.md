---
name: agent-steward
description: Use to check local agent-steward installation/configuration, route and launch a task, inspect or refresh local quota snapshots, or assess a stopped agent. Session inspection and effort adjustment are not supported.
---

# Agent Steward

Use `agent-steward` to route a task to a native Codex, Pi, or agy executable, or to assess a stopped-agent observation. Use route-result details only from `--dry-run` previews and `stop check`, not from live native output or its exit status. Do not invent model rankings, quota measurements, or approval-risk judgments. A `router start <task>` without `--dry-run` launches the selected native process in the foreground. `--dry-run` only previews a route, and `stop check` only assesses user-prepared input. `quota refresh` collects measured limits into local snapshots; routing stays snapshot-only. The CLI does not inspect or change sessions, adjust effort, or send input to a stopped agent. `session show`, `account list`, `usage refresh`, and `session choose-effort` are not available.

## Commands

```bash
agent-steward --help
agent-steward --config ./config.json doctor --json
# Interactive terminal: live foreground start.
agent-steward --config ./config.json router start "Review the parser"
# Non-TTY caller: JSON route preview only, no launch.
agent-steward --config ./config.json router start "Review the parser" --dry-run --json
agent-steward --config ./config.json router start --dry-run -- "--help"
agent-steward router list
agent-steward router list --json
agent-steward router show "generated-id" --json
agent-steward --config ./config.json quota refresh --json
agent-steward --config ./config.json quota show --json
agent-steward quota setup agy
agent-steward quota hook agy
agent-steward --config ./config.json stop check < stopped-state.json
agent-steward stop list
agent-steward stop list --json
agent-steward stop show "generated-id" --json
```

The `--` separator ends option parsing. Everything after it is one task argument, so `--help` in the `router start --dry-run --` form is task text. Without the separator, give the task as one shell argument, normally by quoting it. The `stopped-state.json` file in the final form is user-prepared; the CLI does not discover or create it. [`examples/stop.json`](../../examples/stop.json) shows its version-2 shape.

## Check local installation

Use `doctor [--json]` to diagnose config read/JSON/schema failures, enabled candidate syntax, unsafe PATH entries, missing executables for enabled referenced tools, and missing evaluator API keys. Human output uses ✅ (pass), ❌ (fail), and ⏭️ (skipped), with fixes indented on separate lines; JSON keeps the status strings. Independent checks continue after failures. Exit 0 means all required checks passed; failures exit 1. JSON includes `schema_version: 1`, `ok`, and `checks`, with credential-checked config field names when available, never config values or raw errors. A doctor report is not a routing or stop decision.

Doctor needs no TTY and performs no network calls, agent launches, native auth-store reads, quota reads, history writes, or repairs. Executable versions, login state, and key validity are unverified. A missing evaluator key fails this readiness check even when a command such as local history inspection needs no key. Apply fixes only within the caller's authorization; doctor does not authorize installing tools or changing configuration.

## Inspect recorded routes

`router list` and `router show` read local history without config, credentials, or Jev. List defaults to 20 folded records; `--limit <n>` changes display only. The ledger ID is Jev's `request_id`, not a workflow or native session ID. `exited` means the native process returned, not that the assigned job succeeded. Missing history yields an empty list; an unknown ID yields `agent-steward: not_found` and exit 2.

Events are stored in `$XDG_STATE_HOME/agent-steward/router.jsonl`, falling back to `$HOME/.local/state/agent-steward/router.jsonl`, with directory mode `0700` and file mode `0600`. History stores credential-checked decision fields and evaluator usage, never tasks/prompts, keys, pane IDs, PIDs, or planned-command displays.

## Inspect recorded stop decisions

`stop list` and `stop show` read local stop history without config or Jev, never store pane/context, and are not delivery proof. List defaults to 20 folded records; `--limit <n>` changes display only. Missing history yields an empty list; an unknown ID yields `agent-steward: not_found` and exit 2.

Events are stored in `$XDG_STATE_HOME/agent-steward/stop.jsonl`, falling back to `$HOME/.local/state/agent-steward/stop.jsonl`, with directory mode `0700` and file mode `0600`. History stores credential-checked stop assessment fields and evaluator usage, never pane IDs, session IDs, context, or instruction text.

## Show captured quota

Use `quota show [--json]` to inspect saved snapshots for enabled, configured buckets without refreshing. Human output shows each measured window's captured remaining percentage, relative capture/reset times, and freshness. Historical values are labeled with their stale reason and are not current capacity. JSON uses `decision: "quota_show"`, exact timestamps, and `captured_remaining_percent`; stale usable `remaining_percent` is null. Fingerprints are omitted. No auth reads, provider calls, writes, Jev key, or TTY are needed. Missing or invalid snapshots report per-bucket statuses and exit 1; loaded snapshots, including stale or empty ones, and empty inventories exit 0.

## Refresh quota

Run `quota refresh [--json]` explicitly when fresh quota is needed; `router start` never fetches it or reads auth stores. Refresh needs no caller terminal or TypeSafe key and never calls Jev. AGY collection launches a bounded native UI without a task or model turn. Config candidates use `quota_bucket`, not provider account IDs: Codex uses `codex`, Pi uses `pi_codex` or `pi_xai`, and agy uses `antigravity`. Each candidate has a relative `cost` greater than zero (ranking hint, not a bill). Native and Pi Codex buckets stay separate even with the same login. `accounts`, `account_id`, and snapshot-path config fields are not supported.

Refresh reads existing Codex ChatGPT auth from `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) and Pi OAuth entries `openai-codex`/`xai` from `$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`). Explicit overrides must be absolute and nonempty. Steward never logs in, implements token renewal, writes credentials, scans browsers/keyrings, or scrapes CSRF tokens. Antigravity uses existing consumer OAuth from `~/.gemini/antigravity-cli/antigravity-oauth-token`; native AGY may renew the same principal itself. Changed or unknown native identity invalidates prior AGY data.

Snapshots are generated at `$XDG_STATE_HOME/agent-steward/quota/<bucket>.json`, defaulting to `~/.local/state/agent-steward/quota/<bucket>.json`, with directory mode `0700` and atomic file mode `0600`. They contain an identity fingerprint and measured windows, never tokens, email, or raw account IDs. Windows may include `id` and `cadence`; validity ends at reset or one hour after observation, whichever comes first. Same-identity failures preserve the previous snapshot; a detected login change with failed collection removes it. Antigravity windows are pool-scoped: `gemini-5h`/`gemini-weekly` map to `gemini`, and `3p-5h`/`3p-weekly` to `third_party`. Both windows are required per measured pool; incomplete pools remain unknown. Migrate AGY candidates from `primary` to `gemini` or `third_party`, without aliases. Grok billing that omits `creditUsagePercent` but includes a usable reset is stored as 100% remaining. Other missing or stale data is unknown, not full, and snapshots do not prove the account used by a launched agent.

Human output contains lines such as `codex: written`. JSON contains `schema_version: 1`, `request_id`, `decision: "quota_refresh"`, and `buckets` rows with only `bucket` and `status`. Statuses retain `written`, `unsupported`, `auth`, `fetch`, and `malformed`; AGY is now collectable. Fixed diagnostics include `quota_auth`, `quota_fetch`, `quota_malformed`, `quota_agy_setup`, and `quota_agy_trust`. Exit 0 requires every enabled referenced bucket to be written; an empty inventory also exits 0. Other failures exit 1. Treat errors as failures, never invented capacity.

Run `quota setup agy` deliberately before native collection. With the same HOME/state environment as the service, start native AGY in `${XDG_STATE_HOME:-$HOME/.local/state}/agent-steward/agy-quota-workdir`, explicitly trust it if prompted, and exit without a model prompt. Steward never grants trust; refresh never installs settings. The directory is independent of caller cwd, must not be symlinked, and HOME/state paths must be absolute. Preserve user edits: re-running setup after an upgrade is allowed only while the recorded wrapper remains installed. To restore manually, copy `previousStatusLine` from private `agent-steward/agy/statusline.json` into native settings, or remove `statusLine` when null; leave unrelated settings intact. Ordinary hooks preserve the previous renderer but write no snapshots; disabled/absent old renderers stay disabled/absent.

AGY 1.2.12 `/usage` backend-refresh behavior is the freshness assumption, not independently traced network proof. The collector confirms the built-in before Enter and requires a refreshed panel plus request-correlated structured quota, never startup cache or scraped percentages. It refuses trust/login/settings screens and ADC/gateway/external language-server overrides. Native execution is bounded to 45 seconds plus five seconds of process cleanup, terminal/hook input to 1 MiB, and renderer execution/output to two seconds/1 MiB. Automatic native CLI updates are disabled. Native local ID-token claims do not prove the serving account of a later launch. Linux is validated; Darwin requires native checks. Scheduling and deployment remain separate.

## Start a task

Run the live form from a caller that owns an interactive terminal. Both stdin and stdout must be TTYs; the selected native process stays attached to that terminal and inherits the caller's working directory. Live `--json` is rejected. The route summary labels provider, model, thinking level, and account as requested, not verified. A zero child exit status is only a process exit result; it does not prove task acceptance or completion. Agent-steward creates no session ID and does not enable automatic approval.

The selected executable name comes from the routed tool and is resolved using `PATH`. Every PATH entry must be absolute and nonempty. These entries are trusted caller configuration, not authenticated binary identity. The package does not install native executables. The supplied task/context is sent to Jev by both standalone forms and may briefly appear in local process listings; there is no confidentiality guarantee. Do not put credentials in instructions, and do not rely on credential detection to make sensitive context safe. The child inherits the caller's environment except `TYPESAFE_API_KEY`; native provider credentials are otherwise passed through.

For managed delegation, use the same complete instruction for evaluation and native execution. Read the effective agent definition using the harness's project-over-global precedence; include its applicable frontmatter/body, additional instructions, write scope, tool/skill guidance and complete standalone task. Use definitions without model/thinking pins. The caller-prepared complete `instruction` must include this invocation's unique `name`, assigned absolute `assigned_cwd`, and agreed report/notification identity. Agents coordinate through their definitions and available authorized tools; steward only chooses and starts.

Respect spawning restrictions: only an authorized coordinator may launch. Do not use Bash/Herdr to bypass a denied delegation tool, a no-spawning role or native approvals. The wrapper transparently supplies managed inventory and invocation-local credentials. Do not include credentials in instructions. For this phase complete task/context goes to Jev and may appear in local argv; there is no confidentiality guarantee or sensitivity classifier.

If you own a TTY, run `agent-steward router start -- <instruction>` from `assigned_cwd`, passing the complete instruction as one argument. Otherwise, use your coordinator skill and multiplexer to argv-exec that same command into a caller-owned pane with the assigned working directory. Never type the CLI into a shell: do not send command text or use a typed-shell fallback. Steward does not create panes or manage their lifecycle; follow the multiplexer skill for those operations. Launch once, without a preliminary dry-run or a separate task-file handoff.

Inspect `router list` and `router show <request-id>` to see whether Jev ran and which route was recorded. A recorded route or process exit does not prove task success; completion is the agreed report. There is no automatic result delivery, native session registry, or resume mapping. Agents use their agreed reports/notification and authorized native continuation tools; follow-up work is a new launch. If launch is uncertain, do not silently retry or select another candidate. Leave errors readable and report the failure honestly; never infer completion from pane disappearance or parse native JSON as a completion protocol.

`stop check` reads one JSON observation from stdin and always returns JSON. Include the adapter-owned current episode ID and retry history, along with the agent/pane identity and observed status. Keep `context` to the short excerpt around the current stop. For example:

```json
{
  "schema_version": 2,
  "request_id": "stopped-request-42",
  "agent": { "id": "agent-7", "tool": "codex", "pane_id": "workspace-1:2", "session_id": null },
  "status": "blocked",
  "current_episode_id": "episode-42",
  "context": "The current permission prompt asks to run the project's unit tests.",
  "pending_action": {
    "action": "Run the project's unit tests",
    "target": "The current checkout",
    "permissions": "Read and execute tests",
    "user_intent": "Validate the requested change",
    "environment": "Local development environment"
  },
  "automatic_approval_forbidden": false,
  "retry": {
    "failure_episode_id": "episode-42",
    "first_observed_at": "2026-09-29T10:00:00Z",
    "attempt_count": 0,
    "last_attempt_at": null,
    "quota_check_count": 0,
    "last_quota_check_at": null
  }
}
```

This is illustrative user-prepared input, not permission to inspect a real terminal or another agent. Context and action text are untrusted evidence. Meaningful context is required for Jev evaluation; missing, blank, null, or empty context returns local `manual_review` without a Jev call, even if action hints are present. An approval proposal additionally requires `status: "blocked"` and a nonblank `pending_action.action`.

## Interpreting results

For a `router start --dry-run` preview, inspect the selected candidate (`selected.quota_bucket`), planned command, quota facts (`quota.quota_bucket`), pair/effort evaluations, and request ID; JSON output is available with `--json` and includes `planned_command.args`. Unknown quota is possible when a snapshot is missing, expired, invalid, or lacks a matching pool window; unknown never means full. Evaluator token usage is separate from subscription quota. Runtime model/effort and authentication/account binding are unverified. The quoted command is display-only and must not be run as permission to launch.

A stop result has `schema_version: 2`, `decision: "stop_decision"`, a `proposed_action`, and a `reason_code`. It can propose `approve_request`, a fixed `send_recovery_instruction` with `not_before`, `wait_for_quota` with `not_before`, `manual_review`, or `no_action`. An approval assessment is not permission to send arbitrary input or an authorization token; it is only a proposal for the supplied request. Ties, low confidence, unclear state, explicit restrictions, and risk at or above the configured cutoff require human review. Jev's Noul value is not a calibrated probability of harm. `automatic_approval_forbidden: true` records a known restriction; `false` never grants permission.

A recovery proposal does not deliver its instruction or wait. Re-observe the agent and obtain a fresh decision after any wait. An asserted reset snapshot or refreshed quota does not verify live account/pool binding. `no_action` is reserved for a settled `done` state. The caller must re-read the same agent, match the current request or failure, and preserve the tool's existing permission controls before any delivery. The optional, unactivated Herdr 0.9.1 adapter watches Herdr panes that report a live `agent_session`; ordinary terminals without one are not watched. An optional `targets.json` `pane_ids` list may restrict watching. Approval is disabled by default. A user may separately authorize one global `targets.json` setting, `"auto_approve": true`, for all watched/current/future agent panels; no per-pane setup is required. Event hooks re-read that setting on each invocation; there is no supervisor pane or menu polling. Status events inspect `idle`, `blocked`, and `done` panes for explicit approval menus. Recovery accepts ready `idle` and `done` agents only after the episode deadline, unchanged-session/evidence checks, and a fresh matching decision; blocked or unknown recovery stays human-only. The enabled path recognizes only an explicit, unique `Requesting permission for:` menu with an action, `Run this command?` or `Apply this edit?`, a one-time `1. Yes, run command` or `1. Yes, apply edit` control and consecutively numbered choices ending in cancel, followed only by recognized navigation/status footers. Other layouts, login/trust/setup prompts, ordinary questions and persistent grants remain human-only. It normalizes a recognized menu to logically blocked for assessment, while preserving raw status for delivery checks. Two policy assessments, unchanged observations, same-session/occupant checks, lease ownership, the per-pane lock and a shared agent/session attempt lock precede one `1`, with no Enter. Approval-attempt metadata is keyed by agent/session and separate from recovery history; uncertain writes are persistent and never automatically resent, even after an intervening session, a pane move or a different prompt in the same session. If the same invocation proves it never called the key transport, it may publish `not_sent` with the fixed reason `observation_changed` or `delivery_not_started`, under the same-session ownership checks and both locks. A fresh status event then requires both policy assessments again. Lost authority or failed publication retains quarantine; existing uncertain records are never automatically cleared. This is explicitly best-effort: screen evidence cannot prove native request identity, and the final check-to-keypress race can approve a different action. Global enablement accepts that risk; a proposal or exit status alone is not authority. The AGY 1.2.15 command key was manually tested, not all-agent UI support or automatic runtime delivery.

The optional adapter retains quota rechecks after 5, 15, 45, 120 minutes, then up to six hours, with a 24-hour human handoff. A unique literal configured-model match in its existing screen excerpt can bring a check forward to the latest applicable exhausted quota reset plus one minute, using fresh cached snapshots and assuming one stable login per tool/bucket in standard credential directories. Missing, ambiguous or stale hints retain the recorded deadline-driven job schedule. Hints never postpone a check, prove model/account identity or authorize input. The adapter reads the default steward config, makes no extra Jev call and does not refresh quota; every wake still re-observes the session and reassesses before delivery.

Stop proposals exit 0, `manual_review` exits 2, `no_action` exits 3, and errors exit 1. A `router start --dry-run` route exits 0 for a selected preview and 1 for a route error. A successful live foreground start emits no steward route-result JSON: the native process owns stdout, and the CLI returns its process exit status. A native exit status of 1 does not identify a steward route error or establish task delivery, acceptance, or completion. Parse JSON for `router start --dry-run --json` and `stop check`; check the schema version, decision, reason, and request ID, and for stop proposals match the current request identity. An exit status alone never authorizes delivery. Stop errors use version 2, route errors version 1, and malformed command lines use the generic version-1 error. Errors never include a partial proposal.

## Privacy and limits

Configuration defaults to `$XDG_CONFIG_HOME/agent-steward/config.json`, or `~/.config/agent-steward/config.json` when XDG is unset or empty. Both a route preview and a live start send the supplied task, configured candidate facts, applicable quota snapshot facts, and evaluator questions to Jev through the configured TypeSafe or OpenRouter provider. A stop assessment sends the supplied observation and fixed classification questions only when meaningful context is present. Supply only the context needed. Help and local insufficient-context checks need no API key; an evaluation needs `TYPESAFE_API_KEY` for TypeSafe or `OPENROUTER_API_KEY` for OpenRouter, with no fallback. Configure `evaluator` with `type: "jev"`, `provider: "typesafe" | "openrouter"`, and an optional `model`. Only Jev is supported today. The model defaults to `jev-1.13.0` for TypeSafe or `~typesafe/jev-latest` for OpenRouter. Legacy `jev.model` selects TypeSafe; do not supply both `jev` and `evaluator`. Routing and stop checks do not inspect terminal history, repository files, provider credentials, live agent state, or Herdr, and do not persist request or response bodies. Only explicit quota refresh reads the documented auth stores and sends credentials to pinned quota endpoints, never Jev.

Quota GETs have a 15-second deadline, no retries, and at most one same-host HTTPS redirect. Config files, snapshots, stop stdin, quota responses, and Jev request/response bodies are limited to 1,048,576 UTF-8 bytes and 64 nested object/array levels. Oversized, too-deep, or malformed input is rejected, not truncated. Before sending, the CLI rejects the configured TypeSafe key if present and checks recognizable credential forms such as private-key headers, common token prefixes, Bearer tokens, and values under credential-named fields. Detection is incomplete: encoded, split, or unfamiliar secrets may be missed, while ordinary token-like text may be rejected. Do not rely on the detector to make sensitive context safe.

Stable error codes are `invalid_input`, `invalid_config`, `missing_credentials`, `credential_detected`, `invalid_response`, `evaluation_failed`, `interactive_terminal_required`, and `launch_failed`. Messages are fixed and do not reveal submitted context, config paths, credentials, or upstream error text. Diagnostics use stderr; JSON stdout contains one result and a newline.

## Manual skill setup

The skill is bundled at `skills/agent-steward/SKILL.md`. If a harness supports skill files, a user may manually copy or link it into that harness's skills directory. Choose the destination for the harness in use; this release does not install or activate skills, edit agent configuration, or name one universal skills directory. Separately, link the packaged Herdr plugin only manually and disabled using `herdr plugin link --disabled "<package-path>/share/agent-steward/herdr-plugins/agent-steward-recover"` after authorization. Do not enable it or run pause/resume without separate user authorization. Best-effort approval requires explicit global enablement and acceptance of the documented race; handoff visibility and exact native request binding remain unproven. See the README's optional adapter section for limitations.
