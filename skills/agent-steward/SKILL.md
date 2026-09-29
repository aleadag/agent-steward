---
name: agent-steward
description: Use to route and launch a task with agent-steward or assess a stopped agent. Session inspection, effort adjustment, and quota inspection apply only when supported by a later installed CLI version.
---

# Agent Steward

Use `agent-steward` to route a task to a native Codex, Pi, or agy executable, or to assess a stopped-agent observation. Use route-result details only from `--dry-run` previews and `stop check`, not from live native output or its exit status. Do not invent model rankings, quota measurements, or approval-risk judgments. A `session start <task>` without `--dry-run` launches the selected native process in the foreground. `--dry-run` only previews a route, and `stop check` only assesses user-prepared input. The CLI does not inspect or change sessions, adjust effort, collect live quota, or send input to a stopped agent. `session show`, `account list`, `usage refresh`, and `session choose-effort` are not available.

## Commands

```bash
agent-steward --help
# Interactive terminal: live foreground start.
agent-steward --config ./config.json session start "Review the parser"
# Non-TTY caller: JSON route preview only, no launch.
agent-steward --config ./config.json session start "Review the parser" --dry-run --json
agent-steward --config ./config.json session start --dry-run -- "--help"
agent-steward --config ./config.json stop check < stopped-state.json
```

The `--` separator ends option parsing. Everything after it is one task argument, so `--help` in the fourth form is task text. Without the separator, give the task as one shell argument, normally by quoting it. The `stopped-state.json` file in the final form is user-prepared; the CLI does not discover or create it. [`examples/stop.json`](../../examples/stop.json) shows its version-2 shape.

## Start a task

Run the live form from a caller that owns an interactive terminal. Both stdin and stdout must be TTYs; the selected native process stays attached to that terminal and inherits the caller's working directory. Live `--json` is rejected. The route summary labels provider, model, thinking level, and account as requested, not verified. A zero child exit status is only a process exit result; it does not prove task acceptance or completion. Agent-steward creates no session ID and does not enable automatic approval.

The selected executable name comes from the routed tool and is resolved using `PATH`. Every PATH entry must be absolute and nonempty. These entries are trusted caller configuration, not authenticated binary identity. The package does not install native executables. The task is one native process argument and may briefly appear in local process listings, so do not put secrets in it. The child inherits the caller's environment except `TYPESAFE_API_KEY`; native provider credentials are otherwise passed through.

A non-TTY subagent caller should use the `--dry-run --json` form above, parse the selected tool and requested model/thinking level, and return the preview to an already-authorized caller. That caller may use its own approved launcher and safe argv construction. Do not use `planned_command.display` as a shell command, and do not describe a preview as a successful launch. If live interaction is needed, a terminal-owning caller can run the live form instead.

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

For a `session start --dry-run` preview, inspect the selected candidate, planned command, quota facts, pair/effort evaluations, and request ID; JSON output is available with `--json` and includes `planned_command.args`. Unknown quota is possible when a snapshot is missing, expired, invalid, or lacks a matching pool window; unknown never means full. Evaluator token usage is separate from subscription quota. Runtime model/effort and authentication/account binding are unverified. The quoted command is display-only and must not be run as permission to launch.

A stop result has `schema_version: 2`, `decision: "stop_decision"`, a `proposed_action`, and a `reason_code`. It can propose `approve_request`, a fixed `send_recovery_instruction` with `not_before`, `wait_for_quota` with `not_before`, `manual_review`, or `no_action`. An approval assessment is not permission to send arbitrary input or an authorization token; it is only a proposal for the supplied request. Ties, low confidence, unclear state, explicit restrictions, and risk at or above the configured cutoff require human review. Jev's Noul value is not a calibrated probability of harm. `automatic_approval_forbidden: true` records a known restriction; `false` never grants permission.

A recovery proposal does not deliver its instruction or wait. Re-observe the agent and obtain a fresh decision after any wait. An asserted reset snapshot does not verify live account/pool binding, and agent-steward does not collect live quota. `no_action` is reserved for a settled `done` state. The caller must re-read the same agent, match the current request or failure, and preserve the tool's existing permission controls before any delivery. The optional, unactivated Herdr 0.9.1 adapter cannot bind Pi/Codex permission requests to a native current request ID, action, pane occupant and accepting UI control. It therefore hands off every `approve_request` and never sends approval keys. There is no approval-key configuration or sending path; `1` and any future per-tool override may be considered only after independently verified tool-specific request/control proof. Never guess a UI key or treat an exit status as authority.

Stop proposals exit 0, `manual_review` exits 2, `no_action` exits 3, and errors exit 1. A `session start --dry-run` route exits 0 for a selected preview and 1 for a route error. A successful live foreground start emits no steward route-result JSON: the native process owns stdout, and the CLI returns its process exit status. A native exit status of 1 does not identify a steward route error or establish task delivery, acceptance, or completion. Parse JSON for `session start --dry-run --json` and `stop check`; check the schema version, decision, reason, and request ID, and for stop proposals match the current request identity. An exit status alone never authorizes delivery. Stop errors use version 2, route errors version 1, and malformed command lines use the generic version-1 error. Errors never include a partial proposal.

## Privacy and limits

Configuration defaults to `$XDG_CONFIG_HOME/agent-steward/config.json`, or `~/.config/agent-steward/config.json` when XDG is unset or empty. Both a route preview and a live start send the supplied task, configured candidate facts, applicable quota snapshot facts, and evaluator questions to TypeSafe Jev. A stop assessment sends the supplied observation and fixed classification questions only when meaningful context is present. Supply only the context needed. Help and local insufficient-context checks need no API key; an evaluation needs `TYPESAFE_API_KEY`. The CLI does not inspect terminal history, repository files, provider credentials, live agent state, or Herdr, and does not persist request or response bodies.

Config files, snapshots, stop stdin, and Jev request/response bodies are limited to 1,048,576 UTF-8 bytes and 64 nested object/array levels. Oversized, too-deep, or malformed input is rejected, not truncated. Before sending, the CLI rejects the configured TypeSafe key if present and checks recognizable credential forms such as private-key headers, common token prefixes, Bearer tokens, and values under credential-named fields. Detection is incomplete: encoded, split, or unfamiliar secrets may be missed, while ordinary token-like text may be rejected. Do not rely on the detector to make sensitive context safe.

Stable error codes are `invalid_input`, `invalid_config`, `missing_credentials`, `credential_detected`, `invalid_response`, `evaluation_failed`, `interactive_terminal_required`, and `launch_failed`. Messages are fixed and do not reveal submitted context, config paths, credentials, or upstream error text. Diagnostics use stderr; JSON stdout contains one result and a newline.

## Manual skill setup

The skill is bundled at `skills/agent-steward/SKILL.md`. If a harness supports skill files, a user may manually copy or link it into that harness's skills directory. Choose the destination for the harness in use; this release does not install or activate skills, edit agent configuration, or name one universal skills directory. Separately, link the packaged Herdr plugin only manually and disabled using `herdr plugin link --disabled "<package-path>/share/agent-steward/herdr-plugin"` after authorization. Do not enable or open its supervisor pane: live Pi/Codex recovery, handoff visibility and tool-specific approval-request binding remain unproven. See the README's optional adapter section for target configuration and limitations.
