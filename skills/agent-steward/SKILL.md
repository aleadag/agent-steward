---
name: agent-steward
description: Use to route a task with agent-steward or assess a stopped agent. Session inspection, effort adjustment, and quota inspection apply only when supported by a later installed CLI version.
---

# Agent Steward

Use `agent-steward` for a task-routing decision or an assessment of a stopped agent. Use the decision it returns; do not invent model rankings, quota measurements, or approval-risk judgments. The current standalone release only implements a routing preview and `approval check`. It does not launch agents, inspect or change sessions, adjust effort, collect quota, or send approval input. `session show`, `account list`, `usage refresh`, and `session choose-effort` are not available in this release.

## Commands

```bash
agent-steward --help
agent-steward --config ./config.json session start "Review the parser" --dry-run --json
agent-steward --config ./config.json session start --dry-run -- "--help"
agent-steward --config ./config.json approval check < stopped-state.json
```

The `--` separator ends option parsing. Everything after it is one task argument, so `--help` in the third form is task text. Without the separator, give the task as one shell argument, normally by quoting it. The `stopped-state.json` filename in the final form is a file the user prepared; it is not discovered or created by the CLI.

Configuration defaults to `$XDG_CONFIG_HOME/agent-steward/config.json`, or `~/.config/agent-steward/config.json` when XDG is unset or empty. A config file describes enabled tools, candidate pairs and efforts, quota accounts, and optional local snapshots. It does not install tools, prove a model is available, or establish which account will authenticate. Use only a configuration prepared for this decision.

A routing preview sends the task, configured candidate facts, applicable quota snapshot facts, and evaluator questions to TypeSafe Jev. It may incur evaluator usage, but it does not launch an agent, create a session, reserve quota, or persist request or response bodies. A `session` is a continuing work context created by a later launcher; this preview is one decision and its request ID is not a session ID.

`approval check` reads one stopped-state JSON object from stdin and always returns JSON. For example, prepare an input with the current, minimal terminal context and supply it to the command:

```json
{
  "schema_version": 1,
  "request_id": "stopped-request-42",
  "agent": { "id": "agent-7", "tool": "codex" },
  "status": "stopped",
  "context": "The stopped agent asks whether it may run the project's unit tests.",
  "pending_action": {
    "action": "Run the project's unit tests",
    "target": "The current checkout",
    "permissions": "Read and execute tests",
    "user_intent": "Validate the requested change",
    "environment": "Local development environment"
  },
  "automatic_approval_forbidden": false
}
```

This JSON is an example of user-prepared input, not an instruction to inspect a real terminal or another agent. `context` is the normal evidence source; `pending_action` is optional enrichment. If both are absent, blank, or empty, the CLI returns `manual_review` with `insufficient_context` locally and does not require the TypeSafe key. Nonempty context may still be stale, incomplete, irrelevant, or ambiguous.

## Interpreting results

For routing, inspect the structured `selected` candidate, `planned_command.args`, quota facts, pair/effort evaluations, and request ID. Human output shows the same facts. Unknown quota is possible when a snapshot is missing, expired, invalid, or lacks a matching pool window; unknown never means full. Evaluator token usage is separate from subscription quota. The preview labels runtime model/effort and authentication/account binding as unverified. Its quoted command is display-only and must not be run as permission to launch.

For approval, check the JSON `decision`, `reason_code`, waiting classification, risk value, and request ID together. Outcomes are `approve`, `manual_review`, and `no_action`; errors use `decision: "error"`. `no_action` means no automatic approval input should be sent, not that a person need not respond. `approve` is an assessment of this supplied request, not authorization, a reusable token, or permission to send arbitrary input. Match the assessed request to the current pending action and retain all existing permissions and safety controls. No assessment authorizes arbitrary input or changing another session. Set `automatic_approval_forbidden` to `true` when the caller knows a restriction applies; `false` is not permission. Free-form restrictions may not be recognized by the evaluator.

Approval exit status is 0 for `approve`, 2 for `manual_review`, 3 for `no_action`, and 1 for an error. Routing exits 0 for a complete `selected` result and 1 for an error. A zero exit status alone is never authorization. When consuming a result programmatically, parse its JSON and verify the expected schema version, decision, reason, request ID, and current request identity; never treat an error or nonzero status as approval.

## Privacy and limits

Except for help, commands that evaluate a decision require `TYPESAFE_API_KEY` and send the supplied task or stopped-agent context to TypeSafe. Supply only the context needed. Agent-steward reads the selected config and explicitly configured quota snapshots; it does not collect full terminal history, repository files, provider credentials, or live quota. JSON files, approval stdin, and Jev request/response bodies are limited to 1,048,576 UTF-8 bytes and 64 nested containers. Oversized or malformed input is rejected, not truncated.

Before sending, the CLI rejects the configured TypeSafe key if present and checks a small set of recognizable credential forms, including private-key headers, common token prefixes, Bearer tokens, and values under credential-named fields. Detection is incomplete: encoded, split, or unfamiliar secrets may be missed, while ordinary token-like text may be rejected. Do not rely on the detector to make sensitive context safe.

Errors have stable `reason_code` values: `invalid_input`, `invalid_config`, `missing_credentials`, `credential_detected`, `invalid_response`, `evaluation_failed`, and `execution_unavailable`. They contain safe fixed messages, never the submitted context, config path, credentials, raw response, or upstream error. Any evaluation failure is an error result, not a partial selection or approval. Manual review and errors must never be converted to a fallback action.

## Manual skill setup

The skill is bundled at `skills/agent-steward/SKILL.md`. If a harness supports skill files, a user may manually copy or link it into that harness's skills directory. Choose the destination for the harness in use; this release does not install or activate skills, edit agent configuration, or name one universal skills directory.
