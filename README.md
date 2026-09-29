# Agent-steward

Agent-steward is a standalone decision CLI for task-routing previews and stopped-agent assessments. This release implements `session start --dry-run` and `approval check`; it does not launch an agent, create a session, inspect existing sessions, adjust effort, collect quota, or send approval input. Configuration describes a local inventory only. It does not install tools, change authentication, or activate an integration.

## Install and run

The Nix flake provides a Node.js 22 development shell, a packaged executable with its runtime dependencies, and the default app:

```sh
nix develop path:.
npm ci --ignore-scripts
npm test
npm run typecheck
npm run lint
npm run format:check
nix build path:.#agent-steward --no-update-lock-file
nix run path:. --no-update-lock-file -- --help
nix flake check path:. --no-update-lock-file
```

`npm run lint` runs Oxlint on `src` and `tests`; `npm run format:check` checks those files with Oxfmt. Run `npm run format` to apply formatting. TypeScript validation remains in `npm run typecheck`.

The package installs the executable as `result/bin/agent-steward` and bundles the skill at `share/agent-steward/skills/agent-steward/SKILL.md`. `nix run` and the installed executable use the packaged Node.js runtime. Offline checks do not need credentials, agent executables, user configuration, or live Jev access.

The standalone skill is [`skills/agent-steward/SKILL.md`](skills/agent-steward/SKILL.md). If a harness supports skills, a user may manually copy or link it into a skills directory selected for that harness. For example, after choosing a destination, set `SKILLS_DIR` to that user-selected directory and run:

```sh
mkdir -p "$SKILLS_DIR/agent-steward"
cp skills/agent-steward/SKILL.md "$SKILLS_DIR/agent-steward/SKILL.md"
```

These are optional manual instructions only. Agent-steward does not install skills, edit harness configuration, or activate integrations.

## Commands and result shapes

```sh
agent-steward --help
agent-steward --config ./config.json session start "Review the parser" --dry-run --json
agent-steward --config ./config.json session start --dry-run -- "--help"
agent-steward --config ./config.json approval check < stopped-state.json
```

The `--` separator ends option parsing. The third command routes the literal task `--help`; text after the separator is never treated as a CLI option. Before the separator, `--config <path>` is global and can appear before or after command tokens. Each route task must be exactly one argument; quote a multiword task rather than relying on the CLI to join or discard extra arguments. The final command reads user-prepared stopped-state JSON from stdin; it does not discover or create that file. Approval output is always JSON.

JSON results use `schema_version: 1` and a `request_id`. A successful route contains `decision: "selected"`, the chosen candidate, quota facts, the exact planned executable and argument array, and pair/effort evaluation metadata. Its request ID identifies the evaluation, not a session. A local no-evidence approval result has this shape:

```json
{"schema_version":1,"request_id":"request-42","decision":"manual_review","reason_code":"insufficient_context","waiting_for":null,"waiting_confidence":null,"risk_probability":null,"evaluation":null}
```

Errors also use one structured envelope, for example:

```json
{"schema_version":1,"request_id":null,"decision":"error","reason_code":"missing_credentials","message":"Required credentials are missing."}
```

Routing exits 0 for a complete selected result and 1 for errors. Approval exits 0 for `approve`, 2 for `manual_review`, 3 for `no_action`, and 1 for errors. Check the structured result as well as its exit code; exit 0 is not authorization. `no_action` means no automatic approval input should be sent, not that a person has no reason to respond. Errors never accompany an approval or partial route.

Routing first selects a tool/model pair, then selects one of that pair's configured thinking levels. A single configured level skips the second evaluation. Each Jev request has its own 30-second deadline with no retries, so a route can involve two sequential requests and two separate deadlines. Evaluation token usage measures Jev usage, not remaining subscription quota.

## Configuration

The default file is `$XDG_CONFIG_HOME/agent-steward/config.json`. If `XDG_CONFIG_HOME` is unset or empty, the CLI uses `~/.config/agent-steward/config.json`; a nonempty relative XDG path is invalid. `--config <path>` selects another file. Relative overrides resolve from the current directory, while relative account snapshot paths resolve from the selected config file's directory.

Start from [`examples/config.json`](examples/config.json). It shows GPT Astra through Codex (`openai`) and Pi (`openai-codex`) using an illustrative Codex account and pool, plus a Gemini-through-`agy` candidate with a separate Antigravity account. IDs ending in `-example` are placeholders, not claims about live availability. `default` as a thinking-level ID means omit the effort override; configure it only when omission is valid for that exact model selector. Credentials do not belong in this file. When an evaluation is needed, provide the TypeSafe key separately through `TYPESAFE_API_KEY`.

`tools` lists enabled tool IDs. Candidates using a known but disabled tool remain configured and are not considered. Account/candidate IDs must be unique, references must resolve, and unknown fields are rejected. The default evaluator model is `jev-1.13.0`; missing `thresholds.risky` and `thresholds.choiceConfidence` default to `0.60` and `0.45` respectively. Both are finite probabilities in `[0,1]`.

## Quota snapshot contract

[`examples/quota.json`](examples/quota.json) is an illustrative hand-authored input, not output from a collector. A snapshot has `schema_version: 1`, a `source` (`codex` or `antigravity`), an `account_id`, and `windows`. Each window has a scope (`{"type":"account"}` or `{"type":"pool","pool_id":"primary"}`), `remaining_percent`, `observed_at`, `reset_at`, and `valid_until` timestamps. Times must be RFC 3339 with an offset; observation must precede reset and validity. Configured snapshots are read-only and loaded once per account per route invocation.

Account-wide windows apply to every candidate on that account; a pool window applies only to candidates using that exact configured pool. All applicable facts are retained. A missing or unmatched pool window, malformed/unreadable snapshot, expired validity time, passed reset, or future observation makes the affected quota unknown, never full. If any applicable window is stale, the summary is unknown and the stale remaining percentage is withheld. The CLI does not fetch or refresh live quota.

Config files, snapshots, approval stdin, and Jev request/response bodies are each limited to 1,048,576 UTF-8 bytes and 64 nested object/array levels. Inputs over a limit are rejected rather than truncated.

## Decision and privacy boundaries

A route preview sends the supplied task, configured candidate facts, applicable snapshot facts, and fixed evaluator questions to `https://api.typesafe.ai/v1/systemone`. Approval sends the supplied stopped-agent context and optional structured action hints. Send only the context needed. Agent-steward does not inspect terminal history, repository files, provider credentials, or live account state, and it does not persist request/response bodies. An absent context and action produce local manual review without a Jev call or API key requirement.

Before sending, the CLI rejects the configured TypeSafe key if it appears in outbound data and checks a limited set of recognizable credential patterns: private-key headers, common `sk-`/GitHub token prefixes, AWS `AKIA` keys, Bearer tokens, and values under credential-named fields. Detection is incomplete and may both miss unfamiliar/encoded secrets and reject token-like ordinary text. Do not rely on it to make sensitive input safe.

Approval results distinguish `approve`, `manual_review`, and `no_action`. The waiting classification must identify a current command/edit permission request before an approval assessment can return `approve`; ties, low confidence, `other`, explicit caller restrictions, or risk at/above the threshold require manual review. Jev's Noul value is not a calibrated probability of harm. Set `automatic_approval_forbidden: true` when the caller knows a restriction applies; `false` never grants permission. Existing permission checks remain binding, and the assessment does not execute an action or authorize changing another session. A future executor would have to verify the exact current pending request and preserve existing controls.

Stable error codes are `invalid_input`, `invalid_config`, `missing_credentials`, `credential_detected`, `invalid_response`, `evaluation_failed`, and `execution_unavailable`. Messages are fixed and do not contain paths, submitted data, credentials, or raw evaluator errors. Diagnostics use stderr; JSON stdout contains one result and a newline.

## Command preview references

Syntax baselines for this implementation are Codex 0.157.1, Pi 0.87.1, and `agy` 1.2.11. The Codex effort parser is available in the [0.157.1 version-pinned source](https://raw.githubusercontent.com/openai/codex/rust-v0.157.1/codex-rs/protocol/src/openai_models.rs); the Pi CLI reference is in the [0.87.1 source tag](https://github.com/badlogic/pi-mono/tree/v0.87.1). The agy baseline was checked against 1.2.11 CLI help/error contracts. These syntax references do not prove model availability or effective runtime effort. Pi documents that thinking levels can be clamped, and agy has model-specific effort restrictions; Codex accepts custom nonempty effort names.

A preview includes a safely quoted display command and a separate literal `args` array, but never runs that command or adds task-delivery input. Codex and Pi include explicit provider selectors; agy uses existing settings. Neither syntax nor configuration proves which account authenticates. The card and JSON result label runtime model/effort and authentication/account binding as unverified.

Tests use controlled fixtures and mock HTTP; they do not contact Jev or launch an agent. The bundled skill explains how to provide minimal, user-prepared input and interpret structured decisions without treating them as execution authority.
