# Agent-steward

Agent-steward's standalone CLI routes tasks to a native Codex, Pi, or agy executable. `router start --dry-run` produces a route preview; a live `router start <task>` launches the selected native process in the foreground. `stop check` assesses a user-prepared stopped-agent observation but does not send input. `quota refresh` collects measured limits from existing Codex, Pi, and AGY logins into local snapshots; routing never fetches quota. The CLI does not create steward-managed sessions, inspect existing sessions, adjust effort, or use Herdr to launch agents. Configuration describes a local inventory only. The separate bundled Herdr adapter is opt-in; building this package does not install or activate it.

See the [release notes](RELEASE_NOTES.md) for unreleased changes and published alpha history.

## Install and run

The Nix flake provides the pinned Bun development shell, a packaged executable with its runtime dependencies, and the default app:

```sh
nix develop path:.
bun install --frozen-lockfile --ignore-scripts
bun run build
bun test
bun run typecheck
bun run lint
bun run format:check
nix build path:.#agent-steward --no-update-lock-file
nix run path:. --no-update-lock-file -- --help
nix flake check path:. --no-update-lock-file
```

`bun run lint` runs Oxlint on `src` and `tests`; `bun run format:check` checks those files with Oxfmt. Run `bun run format` to apply formatting. TypeScript validation remains in `bun run typecheck`.

The package installs `result/bin/agent-steward` and `result/bin/agent-steward-herdr-adapter`, bundles the skill at `share/agent-steward/skills/agent-steward/SKILL.md`, and ships the disabled Herdr plugins at `share/agent-steward/herdr-plugins/`. Both wrappers use the package-local Bun runtime. The TypeScript sources compile to `lib/agent-steward/dist/src/**/*.js`; the wrappers run that JavaScript with Bun. Source and emitted files retain Bun-compatible `node:` API imports, so a separate Node executable is not required. Offline checks do not need credentials, agent executables, user configuration, or live Jev access.

### Unreleased platform support

This development flake exports packages, the default app, a development shell,
and build/installed checks for `x86_64-linux`, `aarch64-linux`
and `aarch64-darwin`. Release `v0.1.0-alpha.8` is validated for x86_64-linux only;
aarch64-linux and Darwin native validation remain outstanding. The published
`v0.1.0-alpha.3` tag is unchanged. Portable packaging is unreleased and is not a
cross-platform runtime claim for either alpha.

Export/evaluation is not native validation. The native CI matrix checks the
runner architecture and runs the complete frozen Bun and Nix gates on each
platform. Three-platform validation is established only when all three native
jobs for the reviewed revision pass; unavailable builders or failed native
observations remain verification gaps. Packaging tests use synthetic inputs and
fake native/Herdr boundaries; they do not certify live Herdr supervision or
real Codex/agy launches. Installing the bundled adapter does not activate it.

The standalone skill is [`skills/agent-steward/SKILL.md`](skills/agent-steward/SKILL.md). If a harness supports skills, a user may manually copy or link it into a skills directory selected for that harness. For example, after choosing a destination, set `SKILLS_DIR` to that user-selected directory and run:

```sh
mkdir -p "$SKILLS_DIR/agent-steward"
cp skills/agent-steward/SKILL.md "$SKILLS_DIR/agent-steward/SKILL.md"
```

These are optional manual instructions only. Agent-steward does not install skills, edit harness configuration, or activate integrations.

## Commands and result shapes

```sh
agent-steward --help
agent-steward --config ./config.json doctor
agent-steward --config ./config.json doctor --json
agent-steward --config ./config.json router start "Review the parser"
agent-steward --config ./config.json router start "Review the parser" --dry-run --json
agent-steward --config ./config.json router start --dry-run -- "--help"
agent-steward router list
agent-steward router list --json
agent-steward router show "generated-id" --json
agent-steward --config ./config.json quota refresh --json
agent-steward --config ./config.json stop check < stopped-state.json
agent-steward stop list
agent-steward stop list --json
agent-steward stop show "generated-id" --json
```

The first `router start` command launches the selected native agent in the foreground; the next returns a JSON route preview without launching. The `--` separator ends option parsing. The `router start --dry-run --` command previews the literal task `--help`; text after the separator is never treated as a CLI option. For doctor, start, stop, quota refresh, and quota show, `--config <path>` can appear before or after command tokens, before the separator. Router and stop list and show reject `--config`. Each route task is exactly one argument; quote multiword tasks. `stop check` reads one user-prepared version-2 observation from stdin and always writes JSON. It does not discover the stopped agent or create the input file; [`examples/stop.json`](examples/stop.json) shows the input shape.

### Local installation checks

Run `agent-steward doctor` to check config readability, JSON/schema validity, enabled candidate syntax, PATH safety, required native executables, and the selected evaluator's API-key presence. It checks only enabled tools referenced by candidates. All PATH entries must be nonempty and absolute, matching live-launch requirements.

Human output marks checks with ✅ (pass), ❌ (fail), or ⏭️ (skipped), with suggested fixes indented on separate lines. JSON retains `pass`, `fail`, and `skipped` status strings. Independent checks continue after a failure; checks needing valid config or a safe PATH are skipped. Exit status is 0 when all required checks pass and 1 otherwise. `--json` returns `{ "schema_version": 1, "ok": true|false, "checks": [...] }`; each check includes `id`, `status`, and `message`, with `fix` on failures. Config failures also include `kind` (`read`, `json`, or `schema`) and may include credential-checked field names, never values or raw errors.

Doctor runs offline without a terminal. It does not launch executables, read native auth stores or quota snapshots, contact providers, write history, or repair files. Executable versions, login state, and key validity remain unverified. Missing evaluator keys fail the readiness check even though commands such as local history inspection do not need them. A separate Node executable is not required by the packaged CLI.

### Local route history

To diagnose a failed route, run `agent-steward router show <request-id> --json`. New failure records retain the CLI's `reason_code` and a `diagnostics` object with the failure stage. Config diagnostics distinguish file-read, JSON, and schema failures; schema errors include up to 16 credential-checked field names, never their values. Jev failures include HTTP status when available and elapsed milliseconds. Transport failures distinguish HTTP, network, and timeout errors. Response failures use fixed `diagnostics.kind` categories: `json`, `schema`, `size_limit`, `depth_limit`, `answer_ids`, `answer_type`, `choice_options`, or `choice_mismatch`. Keys, task text, request payloads, raw response bodies, and upstream error messages are not logged. Older records remain readable but cannot recover details that were never recorded.

New evaluator failures also include an optional `diagnostics.details` map. It holds at most 16 metrics with lowercase identifier names (up to 64 characters) and finite-number, boolean, or null values. Metric names are generated by the CLI, not copied from response keys. Option and question labels are not logged. New metrics fit the same schema rather than adding failure-specific fields.

| Check | Detail meanings |
| --- | --- |
| `probability_sum` (historical records only) | `expected` is 1; `actual` is the total; `deviation` is total minus 1; `tolerance` was the allowed absolute deviation; `option_count` is the distribution size. |
| `choice_mismatch` | `expected` is the maximum probability; `actual` is the returned choice's probability, or null when absent; `choice_present` distinguishes absence; `maximum_count` counts tied maxima; `option_count` is the distribution size. |
| `answer_ids`, `choice_options` | `expected` and `actual` count keys; `missing_count` and `extra_count` reveal mismatches even when those counts are equal. |
| `answer_type` | `expected` and `actual` indicate whether the requested and returned types are choice (`true`) or Noul (`false`). |

`evaluation_index` counts HTTP attempts within the CLI request, starting at 0. For routing, 0 is pair selection and 1 is effort selection, if needed. `question_index`, when available, is the zero-based position in the submitted question-key order. Whole-response failures may have only an evaluation index. Local failures before an HTTP attempt do not advance it. The same details appear in launcher failure logs.

Routing and stop assessment follow the returned choice label. Scores need not sum to one and are not normalized. Each score must be finite and within `[0,1]`, all requested options must be present, and at least one score must be positive. All-zero scores report `schema` with `question_index` and `option_count`. A missing or unknown returned choice still reports `choice_mismatch` as `invalid_response`. A present label that is not a maximum is accepted: the label is used, stderr prints `agent-steward: choice_mismatch`, and the same diagnostic details are stored on the success ledger event (`dry-run` or `launched`). Stop checks print that stderr line and do not write the router ledger. Stop ties at the maximum still require manual review; confidence and risk checks are unchanged. Older `probability_sum` failures remain readable but are no longer generated.

`router list` shows the latest 20 recorded requests; `--limit <n>` changes the display without pruning history. `router show <request-id>` shows the folded decision fields, latest event, and exit code when recorded. Both commands support `--json` and read local history without loading config, requiring credentials, or calling Jev. A missing ledger gives an empty list; an unknown request ID exits 2 with `agent-steward: not_found` on stderr.

The ledger is `$XDG_STATE_HOME/agent-steward/router.jsonl`, or `$HOME/.local/state/agent-steward/router.jsonl` when XDG state is unset. Before an append would exceed 5 MiB, the current file replaces `router.jsonl.1`; only that one backup is retained. Normal retained history is at most 10 MiB. An existing oversized ledger is preserved as the backup until the following rotation. `router list/show` read both files and fold events across them; older discarded requests are no longer available. Its directory is `0700` and both files are `0600`. Events record selected tool/provider/model/thinking/`quota_bucket`, evaluator usage, and native exit code when known. They never store task/prompt text, keys, pane IDs, PIDs, or planned-command displays. Credential detection blocks writes.

History reads and writes share a local-filesystem lock (`router.jsonl.lock`) and wait up to five seconds for it. Normal errors release the lock, but a forcibly killed process can leave it behind. Remove the empty lock directory with `rmdir` only after confirming no history operation is still running; age alone does not prove a lock is stale.

Records fold by Jev's `request_id`, not a workflow or native session ID. Events are `dry-run`, `launched`, `launch-failed`, `evaluation_failed`, and `exited`. `exited` means the foreground native process returned, not that its assigned job succeeded.

### Local stop history

`stop list` and `stop show` read local stop history without config or Jev, never store pane/context, and are not delivery proof.

`stop list` shows the latest 20 recorded stop assessments; `--limit <n>` changes the display without pruning history. `stop show <request-id>` shows the folded decision fields and latest event. Both commands support `--json` and read local history without loading config, requiring credentials, or calling Jev. A missing ledger gives an empty list; an unknown request ID exits 2 with `agent-steward: not_found` on stderr.

The ledger is `$XDG_STATE_HOME/agent-steward/stop.jsonl`, or `$HOME/.local/state/agent-steward/stop.jsonl` when XDG state is unset. Retained history uses the same 5 MiB rotation rules as route history. Events record credential-checked assessment fields and evaluator usage, never pane IDs, session IDs, context, or instruction text.

### Foreground native launch (alpha)

A live `router start <task>` requires terminal input and output, rejects `--json`, and stays attached to the selected Codex, Pi, or agy process until it exits. The native process inherits the caller's terminal and working directory. A zero exit status means only that the process exited zero; it does not prove that the task was accepted or completed. The CLI does not create a steward session ID or enable automatic approval.

The live route summary labels the selected provider, model, thinking level, and account as requested, not confirmed. Native flags request those settings; the CLI cannot verify the effective runtime model, effort, provider, or account. The executable is selected by its fixed tool name from `PATH`. Every PATH entry must be absolute and nonempty. Those entries are trusted caller configuration, not proof of executable identity. The package does not install native tools.

The task is sent as one native process argument, so it may be visible briefly in local process listings. Do not put secrets in task text. The child receives the caller's environment except `TYPESAFE_API_KEY`; native provider credentials are otherwise passed through. For a non-TTY caller, use `--dry-run --json` for a route preview, then have an already-authorized caller launch the selected tool and requested settings using its own safe argv construction. Do not execute `planned_command.display` as a shell command: a preview is not a launch.

A `--dry-run` route uses `schema_version: 1` when returned as JSON; stop results and stop errors use `schema_version: 2`. These JSON results include a `request_id`. The JSON form of a selected `--dry-run` result contains `decision: "selected"`, the chosen candidate, quota facts, the exact planned executable and argument array, and pair/effort evaluation metadata. Its request ID identifies the evaluation, not a session. A successful live foreground start emits no steward route-result JSON; the selected native process owns stdout, and `agent-steward` returns its exit status. When a stop observation has no meaningful context, the CLI returns this local result without calling Jev:

```json
{"schema_version":2,"request_id":"request-42","decision":"stop_decision","proposed_action":{"kind":"manual_review"},"reason_code":"insufficient_context","waiting_for":"other","waiting_confidence":null,"risk_probability":null,"evaluation":null}
```

Error envelopes have fixed messages and retain the command's schema version. For example, a route error is version 1 and a valid stop-command error is version 2. Malformed command-line arguments that do not select a command use the generic version-1 error.

A `router start --dry-run` route exits 0 for a complete selected preview and 1 for route errors. `stop check` exits 0 for an approval, recovery, or quota-wait proposal, 2 for `manual_review`, 3 for `no_action`, and 1 for errors. A successful live foreground start returns the native process exit status; a native exit status of 1 is not evidence of a steward route error or of task non-delivery, acceptance, or completion. Check `--dry-run` preview results and the `stop check` JSON result alongside their exit codes: no exit code authorizes delivery. `no_action` means no follow-up input should be sent, not that a person has no reason to respond. Errors never accompany a proposal or partial route.

Routing first selects a tool/model pair, then selects one of that pair's configured thinking levels. A single configured level skips the second evaluation. Each Jev request has its own 30-second deadline with no retries, so a route can involve two sequential requests and two separate deadlines. Evaluation token usage measures Jev usage, not remaining subscription quota.

Both routing evaluations receive `current_time` and quota windows with absolute `reset_at` plus numeric `seconds_until_reset`. The countdown uses the same captured clock as snapshot freshness checks, rounds up to whole seconds, and is zero when reset has passed. These fields are evaluator inputs only; saved snapshots and result quota facts are unchanged. Stale windows remain unknown with null remaining capacity.

Pair selection asks Jev to preserve access to the range of configured capabilities, without fixed model tiers. Among suitable candidates, prefer ample known quota that resets sooner when this preserves capability coverage; when quota is scarce, prefer lower relative cost to conserve availability. Account windows are shared within a quota bucket; pool windows are shared within that bucket and pool. Cost is a conservation hint, not measured quota consumption. This is evaluator guidance, not a deterministic allocation rule or a guarantee of future availability.

## Configuration

The default file is `$XDG_CONFIG_HOME/agent-steward/config.json`. If `XDG_CONFIG_HOME` is unset or empty, the CLI uses `~/.config/agent-steward/config.json`; a nonempty relative XDG path is invalid. `--config <path>` selects another file. Relative overrides resolve from the current directory. Snapshot paths are generated state, not configurable paths.

Start from [`examples/config.json`](examples/config.json). It shows GPT Astra through Codex (`openai`) and Pi (`openai-codex`) using separate `codex` and `pi_codex` credential buckets, plus a Gemini-through-`agy` candidate using `antigravity`. IDs ending in `-example` are placeholders, not claims about live availability. `default` as a thinking-level ID means omit the effort override; configure it only when omission is valid for that exact model selector. Credentials do not belong in this file. When an evaluation is needed, provide the selected provider's key separately through `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`.

Select the evaluator separately from the models being routed:

```json
"evaluator": {
  "type": "jev",
  "provider": "openrouter",
  "model": "~typesafe/jev-latest"
}
```

Only `type: "jev"` is supported today; the type selector leaves room for future decision-model adapters without treating them as Jev. Providers are `typesafe` and `openrouter`. An omitted model defaults to `jev-1.13.0` for TypeSafe and `~typesafe/jev-latest` for OpenRouter. Model IDs pass through unchanged; use `typesafe/jev-1.13` to pin OpenRouter's release family. OpenRouter uses its [System One endpoint](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request), not chat completions or `jev-router`. There is no credential or provider fallback.

Existing `"jev": { "model": "jev-1.13.0" }` config remains accepted as Jev via TypeSafe. Omit both selectors to keep that default; supplying both `jev` and `evaluator` is invalid.

For agy, configure one Gemini model with ordinary thinking levels, not a separate candidate per effort. Model IDs pass through unchanged: `gemini-3.8-flash` plus `medium` produces `--model=gemini-3.8-flash --effort=medium`. Non-default effort IDs must be `low`, `medium`, `high`, or `max`; `default` omits the effort flag. Jev, the selected result, and the native command retain the configured model and effort without model-suffix translation. Thinking levels contain only `id` and `description`, with no model overrides. AGY handles model-specific availability and effort restrictions; steward does not claim verified runtime selection.

`tools` lists enabled tool IDs. Candidates using a known but disabled tool remain configured and are not considered. Candidate IDs must be unique and unknown fields are rejected. Each candidate names a `quota_bucket`: `codex` allows only `codex`, `pi` allows `pi_codex` or `pi_xai`, and `agy` allows only `antigravity`. Native Codex and Pi Codex snapshots stay separate even when the logins match. Each candidate also has a required finite `cost` greater than zero: a relative ranking hint (for example Luna `1`, Sol `2`), not a bill or live price. `quota_pool` remains a candidate field; provider account IDs, `accounts`, `account_id`, and snapshot paths are not accepted in config. The default TypeSafe evaluator model is `jev-1.13.0`; missing `thresholds.risky` and `thresholds.choiceConfidence` default to `0.60` and `0.45` respectively. Both are finite probabilities in `[0,1]`.

## Show captured quota

Run `agent-steward quota show` to inspect the latest saved snapshots for enabled, configured quota buckets without refreshing them. It reads local snapshots only: no provider calls, credential reads, or writes. The text display groups windows by provider, with 20-character remaining-percentage bars and percentages rounded to one decimal place. Capture and reset times are relative to the current time:

```text
codex · loaded
  primary   weekly  ████████░░░░░░░░░░░░    40%   resets in 1h

Captured remaining · all captured 30m ago
```

When capture timestamps differ, each row shows its own capture time instead of a shared footer. `--json` preserves full percentage precision.

Stale measurements are labeled `historical` with a reason, such as `expired` or `reset_passed`; they are not current availability. `--json` returns `decision: "quota_show"` and a `buckets` array with exact timestamps. Each window includes `captured_remaining_percent`; its usable `remaining_percent` is null when stale. Identity fingerprints are omitted. Missing, unreadable, malformed, or identity-mismatched snapshots are reported per bucket and exit 1. Successfully reading every snapshot exits 0, even if measurements are stale or the inventory is empty.

## Refresh quota snapshots

Run `agent-steward quota refresh` before routing when you want fresh measured limits. It refreshes each enabled, referenced credential bucket once, without a TTY, Jev, or a TypeSafe key. Human output is one line per bucket, such as `codex: written`. `--json` returns one object and a newline:

```json
{"schema_version":1,"request_id":"generated-id","decision":"quota_refresh","buckets":[{"bucket":"codex","status":"written"},{"bucket":"antigravity","status":"written"}]}
```

Statuses retain `written`, `unsupported`, `auth`, `fetch`, and `malformed`; Antigravity is now collectable, not unsupported. Exit 0 requires every enabled, referenced bucket to be written; an empty inventory also exits 0. Failures exit 1. Fixed diagnostics include `quota_auth`, `quota_fetch`, `quota_malformed`, `quota_agy_setup`, and `quota_agy_trust`; refresh output never includes upstream bodies, terminal/renderer output, or auth paths.

Collectors read existing logins only:

| Bucket | Auth store | Measured endpoint |
| --- | --- | --- |
| `codex` | `$CODEX_HOME/auth.json`, default `~/.codex/auth.json`; ChatGPT login | ChatGPT WHAM usage |
| `pi_codex` | `$PI_CODING_AGENT_DIR/auth.json`, default `~/.pi/agent/auth.json`; `openai-codex` OAuth | ChatGPT WHAM usage |
| `pi_xai` | The same Pi file; `xai` OAuth (SuperGrok) | Grok CLI-proxy billing credits; omitted `creditUsagePercent` with a usable reset is stored as 100% remaining |
| `antigravity` | `~/.gemini/antigravity-cli/antigravity-oauth-token`; consumer OAuth | Native AGY `/usage` and request-correlated statusLine quota |

Explicit `CODEX_HOME` and `PI_CODING_AGENT_DIR` values must be absolute and nonempty. Codex/Pi collectors do not renew tokens: missing, expired, or unusable credentials report `quota_auth`. Their pinned HTTPS requests have a 15-second deadline, no retries, and at most one same-host redirect. Steward never implements OAuth renewal, writes credentials, scans browsers/keyrings, scrapes CSRF tokens, or sends model prompts. AGY may renew its existing consumer login itself, provided the native principal remains unchanged.

Snapshots live at `$XDG_STATE_HOME/agent-steward/quota/<bucket>.json`, falling back to `~/.local/state/agent-steward/quota/<bucket>.json` when XDG state is unset or empty. The directory is `0700`; files are atomically replaced with mode `0600`. A same-identity failure preserves the original snapshot and timestamps. A detected login change invalidates old data; AGY also invalidates it when native identity becomes unknown.

### One-time AGY setup and service operation

Run as the user who owns the intended native AGY login:

```sh
agent-steward quota setup agy
cd "${XDG_STATE_HOME:-$HOME/.local/state}/agent-steward/agy-quota-workdir"
agy
```

Explicitly trust that directory in native AGY if prompted, then exit without a model prompt. Setup creates the directory but never grants trust or performs login. `HOME` and a nonempty `XDG_STATE_HOME` must be absolute. The collector always uses this dedicated directory, not the caller's repository or service cwd, and rejects a symlinked workdir. Give the service the same HOME/state environment and a PATH containing the intended `agy` executable. Scheduling, service units and deployment pins remain separate work.

Setup preserves unrelated native settings and statusLine options. It saves the original renderer privately in `$XDG_STATE_HOME/agent-steward/agy/statusline.json` (default `~/.local/state/agent-steward/agy/statusline.json`) and installs `quota hook agy`. Ordinary native sessions still render the original admitted stdin unchanged and never refresh snapshots. A previously disabled or absent renderer stays disabled or absent. Renderer execution is limited to two seconds and 1 MiB of stdout; capture failures do not suppress the old display. Re-run setup after package upgrades; it refuses unexpected user edits rather than overwriting them. To restore manually, copy the manifest's `previousStatusLine` into the native settings `statusLine` field, or remove that field when the saved value is null. Preserve unrelated settings and stop active refreshes before restoring.

On-demand refresh uses a private Bun PTY even with closed caller stdin. It starts AGY without a task, confirms `/usage` is a recognized built-in before submitting Enter, then requires a refreshed `Models & Quota` panel and a correlated hook observation. Startup cache alone is not accepted. AGY 1.2.12's native `/usage` backend-refresh behavior is the freshness assumption, not an independently traced backend request. Changed/unrecognized UI fails closed. Native invocation has a 45-second deadline plus five seconds for process cleanup; terminal and hook input are bounded to 1 MiB. Automatic CLI updates are disabled for that invocation. Trust/login/settings dialogs are never approved; cloud/ADC/gateway and inherited external language-server/auth overrides are unsupported. Native identity is re-read after shutdown; changed or unknown principal invalidates prior data. Decoded local ID-token claims are an identity source, not independent serving-account proof.

Migrate AGY candidates from `quota_pool: "primary"` to `"gemini"` or `"third_party"`. Native `gemini-5h`/`gemini-weekly` map to `gemini`; `3p-5h`/`3p-weekly` map to `third_party`. Both limits are required for a measured pool. An incomplete pool is omitted, an invalid present measurement rejects refresh, and unmatched pools remain unknown. No pool aliases or terminal-percentage scraping are used. Linux PTY/service behavior is tested; Darwin needs its native check run before a portability claim.

### Snapshot contract

[`examples/quota.json`](examples/quota.json) illustrates collector-shaped data, not live measurements. A snapshot has `schema_version: 1`, a `source` (`codex`, `pi_codex`, `pi_xai`, or `antigravity`), a 64-character lowercase SHA-256 `identity_fingerprint`, and `windows`. The fingerprint hashes the bucket prefix and provider identity; raw account IDs, emails, and tokens are never stored. Each window has a scope (`{"type":"account"}` or `{"type":"pool","pool_id":"primary"}`), `remaining_percent`, `observed_at`, `reset_at`, and `valid_until`. Optional `id` and `cadence` (`weekly` or `other`) preserve measured window labels. Times must be RFC 3339 with an offset; observation must precede reset and validity. Collectors cap validity at the earlier of reset and one hour after observation.

Routing reads snapshots once per enabled bucket and never reads auth stores. Route JSON and ledger selections use `selected.quota_bucket`; route quota facts use `quota.quota_bucket`. Account-scoped windows apply to every candidate on the bucket; a pool window applies only to the exact configured pool. Extra HTTP-provider limits stay account-scoped; AGY uses only the explicit native pool mapping above. All applicable facts are retained. Missing fingerprints, missing or unmatched pool windows, malformed/unreadable snapshots, expired validity, passed resets, and future observations make affected quota unknown, never full. Stale remaining percentages are withheld. A snapshot does not bind a launched agent to that login.

Config files, snapshots, stop stdin, quota responses, and Jev request/response bodies are each limited to 1,048,576 UTF-8 bytes and 64 nested object/array levels. Inputs over a limit are rejected rather than truncated.

## Decision and privacy boundaries

Both dry-run previews and live starts send the supplied task, configured candidate facts, applicable snapshot facts, and fixed evaluator questions to the configured provider: `https://api.typesafe.ai/v1/systemone` for TypeSafe or `https://openrouter.ai/api/v1/systemone` for OpenRouter. `stop check` sends the supplied version-2 observation, including context and any structured action hints, with fixed classification questions when evaluation is needed. Send only the excerpt around the current stop. Routing and stop checks do not inspect terminal history, repository files, provider credentials, live account state, or Herdr, and do not persist request/response bodies. Only explicit `quota refresh` reads the documented auth stores and contacts quota endpoints; credentials never enter Jev state. If context is absent, blank, null, or empty, even action hints produce local manual review without a Jev call or API-key requirement. A meaningful context is required before Jev evaluation.

Before sending, the CLI rejects either configured TypeSafe or OpenRouter key if it appears in outbound data and checks a limited set of recognizable credential patterns: private-key headers, common `sk-`/GitHub token prefixes, AWS `AKIA` keys, Bearer tokens, and values under credential-named fields. It also checks caller IDs and output for both configured keys. Detection is incomplete and may miss unfamiliar or encoded secrets, while rejecting token-like ordinary text. Do not rely on it to make sensitive input safe. The opt-in evaluation sends the supplied context through the configured provider to Jev.

A stop observation identifies the agent and pane, current status and episode, and retry history. Those adapter-supplied fields are separate from untrusted context and action text. Approval proposals require a blocked agent, meaningful context, and a nonblank `pending_action.action`; they do not approve or execute anything. The assessment preserves the existing restriction and risk cutoff: ties, low confidence, unclear state, explicit caller restrictions, or risk at/above the threshold require `manual_review`. Jev's Noul value is not a calibrated probability of harm. `automatic_approval_forbidden: true` records a known restriction; `false` never grants permission.

Other stop proposals are a fixed recovery instruction for a classified recoverable API error, a wait deadline for a classified quota limit, `manual_review` for uncertain or non-actionable cases, and `no_action` for classified completion at ready `idle` or `done`. The CLI neither waits nor sends the instruction. A caller must re-read the agent before delivery and identify the permission request and its accepting control. The optional adapter's explicitly enabled best-effort approval mode uses repeated screen observations, not exact native request-binding proof. It must preserve the tool's existing permission controls, never guess a UI key, and never treat a proposal as a capability. Asserted reset data and refreshed snapshots do not establish a live account or quota binding. Stop assessments do not launch, restart, or change another session.

### Optional Herdr adapter (not activated)

The bundled Herdr 0.9.1 adapter watches Herdr panes that report a live `agent_session` when a status or exit event runs. There is no supervisor pane, startup worker, or menu polling. Ordinary terminals without a session are not watched. An optional `targets.json` `pane_ids` list restricts watching; omitted or empty `pane_ids` watches every agent pane. It normally reads 12 detection lines, expanding to 16 only when permission controls indicate a clipped menu header, and forwards at most 16 lines (2,048 bytes) for classification; Herdr may mark the read truncated and its read revision is independent of `agent.get`. The excerpt can include earlier screen lines and may be sent to TypeSafe. It is not proof of a current permission request or error. For best-effort recovery, a fresh matching classification plus ready-state and same-session checks may trigger the fixed conditional instruction; an older error can cause an unnecessary prompt. Approval is disabled by default. The adapter does not install a plugin, start an agent, or restart a process. Status events are triggers, not native request identity.

After separate review and explicit authorization, an operator can link the **disabled** packaged plugin without a source checkout (replace `<package-path>` with the absolute Nix build output path):

```sh
herdr plugin link --disabled "<package-path>/share/agent-steward/herdr-plugins/agent-steward-recover"
```

The package supplies `herdr-plugins/agent-steward-recover` (`herdr-plugin.toml`, `run.sh`, adapter link) and `herdr-plugins/agent-steward-launcher` (`herdr-plugin.toml`, `dispatch.sh`, `log-failure.sh`, renderer link). The TypeScript `bin/steward-spawn` helper opens a launcher pane with literal task argv, choosing the largest pane and split direction when direction is omitted. It finds the configured `agent-steward` command on PATH and strips `TYPESAFE_API_KEY` before calling Herdr. Its generated launch script has mode 0600 in a mode-0700 temporary directory. Nix exposes a `steward-spawn` package containing only this command so it can coexist with a configured CLI wrapper. Linking disabled is not activation: do not enable the plugin in a normal Herdr session without a separate opt-in. Independently review bounded text disclosure and retry behavior before opt-in. Packaging tests use an isolated fake Herdr socket and CLI; they do not establish safe live activation. Live AGY menu correlation is not claimed by this change.

With the updated packaged launcher plugin and CLI, failed launcher commands also appear in `herdr plugin log list --plugin agent-steward-launcher`. The CLI invokes the plugin's `log-failure` action with only the request ID, reason code, and credential-checked diagnostics; native-agent output, task text, keys, and raw API errors are never captured. Reporting is limited to launcher-managed Herdr panes and waits at most two seconds for acceptance. An unavailable logging action prints `launcher_log_unavailable` without replacing the original error or exit status. Herdr retains a session-scoped command log, so the persistent route ledger remains the durable record. Updating the package alone does not relink an already installed plugin. Link the launcher to the built package directory, not a raw source directory: the source directory does not contain the packaged logging helper. To update an already enabled launcher, run `herdr plugin link "<package-path>/share/agent-steward/herdr-plugins/agent-steward-launcher" --enabled`.

The adapter classifies fresh stopped observations even after an earlier recovery handoff. Changed screens, revisions, and idle transitions do not reset retry counters: unresolved failures share their original budget and timing. An explicit fresh `completed` classification at `idle` or `done` closes ordinary recovery history so a later failure can start a new budget. This is classification-based, not native success certification. Prior stop records and quarantine files remain retained; uncertain delivery, canceled provenance, corrupt state, and ambiguous association still require human review. An already attempted snapshot cannot be replayed after completion. Retained recovery records grow per stopped observation and are not automatically garbage-collected.

A recovery proposal waits until its episode-anchored deadline, then re-observes and asks `stop check` again before using Herdr's `agent prompt` command with the fixed instruction. Only an unchanged, ready `idle` or `done` agent is eligible. This is best-effort babysitting, not proof that the error is still current: the instruction asks the agent to check prior success and do nothing if the failure is no longer current. Blocked dialogs, including error and permission UI, require a person: no Codex/Pi non-approval dismissal has been proven. With approval disabled, approval proposals hand off to a human and never send keys. Herdr's status/session interfaces do not prove an exact current permission request or accepting control; the native verifier still returns no proof. An explicitly enabled best-effort path is described below. Quota exhaustion schedules bounded rechecks (5, 15, 45, 120 minutes, then up to six hours) and hands off at 24 hours. A unique, literal configured-model match in the existing screen excerpt can bring a check forward to one minute after the latest applicable exhausted limit resets, using fresh cached quota. This is a best-effort hint under the assumption of one stable login per tool/bucket in standard credential directories, not verified model/account binding. Missing or ambiguous matches and stale or unavailable quota retain deadline-driven quota rechecks; hints never delay a check or authorize input. The adapter reads the default steward config and snapshots, makes no extra Jev call, and does not refresh quota. Rechecks still re-observe the same session and reassess before any delivery. A prompt timeout, stall, or unknown write outcome is recorded as uncertain and is never automatically resent.

#### Global best-effort approval

To authorize best-effort approval across all watched agent panels, including newly opened panels, set one global adapter option in the plugin's `targets.json`:

```json
{ "auto_approve": true }
```

No per-pane setup is required. `pane_ids` is optional for testing or restricting observation. Missing, malformed, or non-boolean enablement stays off. Event hooks re-read the setting, live plugin registry, config, and socket identity on each invocation and before later authorization. A changed target or approval setting invalidates captured work instead of extending it. Pause closes the server admission epoch without evaluator credentials or valid targets; resume opens a new epoch only while the plugin is enabled and does not start a worker or clear history. For durable stop, pause then disable the plugin. Reenabling does not implicitly resume paused work. Native plugin disable prevents new launches but does not kill an already running recovery job.

For explicit approval menus, the adapter checks `idle`, `blocked`, and `done` panes: AGY 1.2.15 was observed reporting `idle` and, after an approval, `done` at permission prompts. Recovery separately accepts `idle` and `done` only through its unchanged-session, fresh-classification, deadline, and at-most-once gates. There is no menu polling: an absent, partial, stale, or unsupported menu stays human-only. Only an explicit, unique menu beginning `Requesting permission for:`, naming an action, asking `Run this command?` or `Apply this edit?`, and offering `1. Yes, run command` or `1. Yes, apply edit` with consecutively numbered choices ending in cancel is eligible. Only recognized navigation/status footers may follow; extra questions or control rows make the menu ineligible. Other layouts, ordinary questions, login/trust/setup dialogs, conflicting menus, and persistent grants on key `1` remain human-only. All agents use the same Herdr transport; this does not establish support for every agent's UI. One manual AGY 1.2.15 command dialog accepted `1`; other agent/control mappings and the edit layout have no live validation.

A recognized permission menu is assessed as logically blocked even when Herdr reports `idle`; the raw status remains part of delivery rechecks. The action and bounded excerpt go through the existing `stop check` risk/confidence/restriction policy twice, with fresh matching observations between assessments. Delivery also requires the same session/occupant, unchanged snapshot, a live server-bound lease, the per-pane lock and an agent/session attempt lock shared across panes. The only input is one `1`, with no Enter, persistent grant, native hook, or permission-bypass flag.

**Enabling this option accepts a real race:** Herdr cannot atomically bind the final observation to the keypress. A dialog or occupant can change after the last check, and `1` could approve a different, dangerous action. Screen text can also be misleading. These are best-effort checks, not exact native proof or a guarantee of safe approval. No exit status or classifier result alone grants delivery authority.

Private approval-attempt files are keyed by agent/session, retaining only agent/pane/session identity, an action/control digest, time, delivery state and a fixed no-send reason, separately from recovery budgets. An intervening session or pane move cannot overwrite an older session's quarantine; retained records grow per agent/session. An unchanged menu is not approved again merely because the footer, revision or status sequence changes. A different menu can be assessed after a settled attempt. Before sending, the attempt is persisted as uncertain; a timeout, lost acknowledgment, shutdown or unknown outcome is never automatically retried, even after a restart or a different prompt in that session. An invocation that proves it never called the key transport may record `not_sent` with `observation_changed` or `delivery_not_started`, while it still owns the same session and both locks. A later status event may reassess that menu from scratch, including both policy checks. Lost authority, failed no-send publication and genuinely unknown delivery outcomes remain quarantined; existing uncertain records are not automatically cleared. Human review is required to resolve uncertain state. A successful Herdr write records submission, not command success or completion. Do not delete attempt records from a running adapter to force a retry.

Human handoffs emit fixed, credential-free stderr text and, when Herdr supplies its executable path, call Herdr 0.9.1 `notification show` with a fixed title and body. A successful notification call does not prove that a person saw the toast. Socket device/inode is only a local server-instance proxy, not authenticated session identity. Disposable tests demonstrated genuine Pi HTTP-503 recovery via installed hooks, manually triggered Codex HTTP-503 recovery, and native Codex HTTP-429 quota scheduling in `done`. A person confirmed seeing the direct fixed-title/body toast. Attached adapter-generated notification delivery, Pi quota behavior, and general blocked-dialog mappings remain unverified. Enabling the plugin in a normal session still needs separate review and explicit authorization.

A qualifying recovery or quota proposal can promote the current event command into one temporary job for that Herdr server, agent, and session. Healthy agents create no recovery jobs. At most eight pending recovery jobs may exist per Herdr server; duplicates consume no extra slot. The job waits for its recorded deadline without holding pane locks or reading screens, then re-observes under current permission. API-error delays stay 30 seconds, 2 minutes, and 8 minutes; quota rechecks stay 5, 15, 45, and 120 minutes, then up to six hours, with a 24-hour cutoff from first observation.

Each workflow uses a version-2 generation lease with a 15-second heartbeat TTL under `$HERDR_PLUGIN_STATE_DIR/workflows/<scope-hash>/scheduler-lease/generations/<UUID>/`. Server control lives at `$HERDR_PLUGIN_STATE_DIR/automation/<server-hash>/control.json`. Capacity slots use the same lease layout under that server's `capacity/` directory. Old global `$HERDR_PLUGIN_STATE_DIR/scheduler-lease/` state is retained, not garbage-collected by this feature. A live, unknown, corrupt, stranded, or unconfirmed old global owner blocks new orchestration until offline repair. Confirmed released or expired-plus-proven-dead old ownership may pass without deleting retained artifacts. Package install and startup never restore pending jobs; only a later qualifying event may associate unambiguous legacy history inside its original budget.

On stop, the invocation closes local admission immediately and independently publishes a generation revocation marker. On a responsive event loop, the result is reported within five seconds: confirmed revocation, or `shutdown_incomplete` with a fixed **release unconfirmed** warning and nonzero exit status. Native pause/resume uses the same five-second result budget, including context lookup. A denied control prints a fixed **control denied; no change confirmed** warning and exits nonzero; it is not a confirmed stop or a timeout. This bounds the reported result, not Bun process exit or blocked filesystem calls. After confirmed pause or release, old epochs cannot authorize later callbacks. pre-admitted writes or commands may still finish, and uncertain deliveries are never automatically resent. Private diagnostics rotate at 1 MiB with one backup and must not log heartbeats, context, prompts, credentials, or model responses.

After publishing a new lease, the adapter automatically collects unselected generations under the publication guard, but only when valid private owner metadata matches the directory and the host PID probe proves the owner dead. The selected generation stays, including its release marker after shutdown. These generation tombstones also remain for released owners that are still alive. Released-but-living owners, reused PIDs, unknown liveness, unsafe paths and corrupt or ownerless generations remain untouched; age and a release marker alone never justify deletion. Collector budgets stay 128 inspected entries, 32 deleted generation directories, and 64 validated children per candidate.

Each cleanup pass inspects at most 128 entries, deletes at most 32 generation directories, and validates at most 64 children per candidate. Eligible dead-owner heartbeat temp files are removed with their generation. Iteration is best-effort, not guaranteed fair, and unverifiable remnants can still accumulate: these budgets are neither a global disk quota nor a filesystem-operation deadline. Lease storage requires a coherent local filesystem and common host/PID namespace; it does not provide network-filesystem fencing or power-loss durability guarantees. Disk-full errors do not grant ownership, and failure to create a revocation marker is incomplete shutdown, not successful cleanup.

Offline repair is required for corrupt or ownerless remnants, shared selector temp files, legacy `scheduler-lease/owner.json` and stranded `takeover-guard` state. Disable the plugin and prevent restart, stop every adapter process sharing the state root, and independently verify all are dead in the same host/PID namespace before reviewing and removing only identified obsolete state. Preserve selected generations and selectors, episode records, approval-attempt/quarantine records and unrelated files. Guard and legacy recovery remain deliberate offline operations: do not infer guard safety from lease expiry or the selected owner's death, since another publisher may own it. Do not remove the version-2 lease directory to make a timeout appear successful. Enabling the plugin remains a separate explicit opt-in.

Stable error codes are `invalid_input`, `invalid_config`, `missing_credentials`, `credential_detected`, `invalid_response`, `evaluation_failed`, `interactive_terminal_required`, and `launch_failed`. Messages are fixed and do not contain paths, submitted data, credentials, or raw evaluator or process errors. Diagnostics use stderr; JSON stdout contains one result and a newline.

## Command preview references

Syntax baselines for this implementation are Codex 0.157.1, Pi 0.87.1, and `agy` 1.2.11. The Codex effort parser is available in the [0.157.1 version-pinned source](https://raw.githubusercontent.com/openai/codex/rust-v0.157.1/codex-rs/protocol/src/openai_models.rs); the Pi CLI reference is in the [0.87.1 source tag](https://github.com/badlogic/pi-mono/tree/v0.87.1). The agy baseline was checked against 1.2.11 CLI help/error contracts; separate model and effort flags were checked in a no-prompt 1.2.12 startup displaying Gemini 3.8 Flash (Medium) for `--model=gemini-3.8-flash --effort=medium`. These syntax references do not prove model availability or effective runtime effort. Pi documents that thinking levels can be clamped, and agy has model-specific effort restrictions; Codex accepts custom nonempty effort names.

A preview includes a safely quoted display command and a separate literal `args` array, but never runs that command or adds task-delivery input. Codex and Pi include explicit provider selectors; agy uses existing settings. Neither syntax nor configuration proves which account authenticates. The card and JSON result label runtime model/effort and authentication/account binding as unverified.

Offline tests use controlled fixtures and mock HTTP. A temporary fake native executable verifies the process boundary; tests do not contact Jev or launch real agents or models. The bundled skill distinguishes route previews from foreground starts and explains how to provide minimal, user-prepared stop input without treating a proposal as execution authority.
