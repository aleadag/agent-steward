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

The package installs `result/bin/agent-steward` and `result/bin/agent-steward-herdr-adapter`, bundles the skill at `share/agent-steward/skills/agent-steward/SKILL.md`, and ships the disabled plugin assets at `share/agent-steward/herdr-plugin/`. Both wrappers use the package-local Bun runtime. The TypeScript sources compile to `lib/agent-steward/dist/src/**/*.js`; the wrappers run that JavaScript with Bun. Source and emitted files retain Bun-compatible `node:` API imports, so a separate Node executable is not required. Offline checks do not need credentials, agent executables, user configuration, or live Jev access.

### Unreleased platform support

This development flake exports packages, the default app, a development shell,
and build/installed checks for `x86_64-linux`, `aarch64-linux`
and `aarch64-darwin`. Published `v0.1.0-alpha.3` remains the Linux-only release;
its tag is unchanged. Portable packaging is unreleased and is not a new claim
about that published alpha.

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
agent-steward --config ./config.json router start "Review the parser"
agent-steward --config ./config.json router start "Review the parser" --dry-run --json
agent-steward --config ./config.json router start --dry-run -- "--help"
agent-steward router list
agent-steward router list --json
agent-steward router show "generated-id" --json
agent-steward --config ./config.json quota refresh --json
agent-steward --config ./config.json stop check < stopped-state.json
```

The first `router start` command launches the selected native agent in the foreground; the next returns a JSON route preview without launching. The `--` separator ends option parsing. The fourth command previews the literal task `--help`; text after the separator is never treated as a CLI option. For start, stop, and quota refresh, `--config <path>` can appear before or after command tokens, before the separator. List and show reject `--config`. Each route task is exactly one argument; quote multiword tasks. `stop check` reads one user-prepared version-2 observation from stdin and always writes JSON. It does not discover the stopped agent or create the input file; [`examples/stop.json`](examples/stop.json) shows the input shape.

### Local route history

`router list` shows the latest 20 recorded requests; `--limit <n>` changes the display without pruning history. `router show <request-id>` shows the folded decision fields, latest event, and exit code when recorded. Both commands support `--json` and read local history without loading config, requiring credentials, or calling Jev. A missing ledger gives an empty list; an unknown request ID exits 2 with `agent-steward: not_found` on stderr.

The ledger is `$XDG_STATE_HOME/agent-steward/router.jsonl`, or `$HOME/.local/state/agent-steward/router.jsonl` when XDG state is unset. Before an append would exceed 5 MiB, the current file replaces `router.jsonl.1`; only that one backup is retained. Normal retained history is at most 10 MiB. An existing oversized ledger is preserved as the backup until the following rotation. `router list/show` read both files and fold events across them; older discarded requests are no longer available. Its directory is `0700` and both files are `0600`. Events record selected tool/provider/model/thinking/`quota_bucket`, evaluator usage, and native exit code when known. They never store task/prompt text, keys, pane IDs, PIDs, or planned-command displays. Credential detection blocks writes.

History reads and writes share a local-filesystem lock (`router.jsonl.lock`) and wait up to five seconds for it. Normal errors release the lock, but a forcibly killed process can leave it behind. Remove the empty lock directory with `rmdir` only after confirming no history operation is still running; age alone does not prove a lock is stale.

Records fold by Jev's `request_id`, not a workflow or native session ID. Events are `dry-run`, `launched`, `launch-failed`, `evaluation_failed`, and `exited`. `exited` means the foreground native process returned, not that its assigned job succeeded.

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

## Configuration

The default file is `$XDG_CONFIG_HOME/agent-steward/config.json`. If `XDG_CONFIG_HOME` is unset or empty, the CLI uses `~/.config/agent-steward/config.json`; a nonempty relative XDG path is invalid. `--config <path>` selects another file. Relative overrides resolve from the current directory. Snapshot paths are generated state, not configurable paths.

Start from [`examples/config.json`](examples/config.json). It shows GPT Astra through Codex (`openai`) and Pi (`openai-codex`) using separate `codex` and `pi_codex` credential buckets, plus a Gemini-through-`agy` candidate using `antigravity`. IDs ending in `-example` are placeholders, not claims about live availability. `default` as a thinking-level ID means omit the effort override; configure it only when omission is valid for that exact model selector. Credentials do not belong in this file. When an evaluation is needed, provide the TypeSafe key separately through `TYPESAFE_API_KEY`.

For agy, configure one Gemini model with ordinary thinking levels, not a separate candidate per effort. Model IDs pass through unchanged: `gemini-3.8-flash` plus `medium` produces `--model=gemini-3.8-flash --effort=medium`. Non-default effort IDs must be `low`, `medium`, `high`, or `max`; `default` omits the effort flag. Jev, the selected result, and the native command retain the configured model and effort without model-suffix translation. Thinking levels contain only `id` and `description`, with no model overrides. AGY handles model-specific availability and effort restrictions; steward does not claim verified runtime selection.

`tools` lists enabled tool IDs. Candidates using a known but disabled tool remain configured and are not considered. Candidate IDs must be unique and unknown fields are rejected. Each candidate names a `quota_bucket`: `codex` allows only `codex`, `pi` allows `pi_codex` or `pi_xai`, and `agy` allows only `antigravity`. Native Codex and Pi Codex snapshots stay separate even when the logins match. Each candidate also has a required finite `cost` greater than zero: a relative ranking hint (for example Luna `1`, Sol `2`), not a bill or live price. `quota_pool` remains a candidate field; provider account IDs, `accounts`, `account_id`, and snapshot paths are not accepted in config. The default evaluator model is `jev-1.13.0`; missing `thresholds.risky` and `thresholds.choiceConfidence` default to `0.60` and `0.45` respectively. Both are finite probabilities in `[0,1]`.

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
| `pi_xai` | The same Pi file; `xai` OAuth (SuperGrok) | Grok CLI-proxy billing credits |
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

Both dry-run previews and live starts send the supplied task, configured candidate facts, applicable snapshot facts, and fixed evaluator questions to `https://api.typesafe.ai/v1/systemone`. `stop check` sends the supplied version-2 observation, including context and any structured action hints, with fixed classification questions when evaluation is needed. Send only the excerpt around the current stop. Routing and stop checks do not inspect terminal history, repository files, provider credentials, live account state, or Herdr, and do not persist request/response bodies. Only explicit `quota refresh` reads the documented auth stores and contacts quota endpoints; credentials never enter Jev state. If context is absent, blank, null, or empty, even action hints produce local manual review without a Jev call or API-key requirement. A meaningful context is required before Jev evaluation.

Before sending, the CLI rejects the configured TypeSafe key if it appears in outbound data and checks a limited set of recognizable credential patterns: private-key headers, common `sk-`/GitHub token prefixes, AWS `AKIA` keys, Bearer tokens, and values under credential-named fields. It also checks caller IDs and output for the configured key. Detection is incomplete and may miss unfamiliar or encoded secrets, while rejecting token-like ordinary text. Do not rely on it to make sensitive input safe. The opt-in evaluation sends the supplied context to TypeSafe.

A stop observation identifies the agent and pane, current status and episode, and retry history. Those adapter-supplied fields are separate from untrusted context and action text. Approval proposals require a blocked agent, meaningful context, and a nonblank `pending_action.action`; they do not approve or execute anything. The assessment preserves the existing restriction and risk cutoff: ties, low confidence, unclear state, explicit caller restrictions, or risk at/above the threshold require `manual_review`. Jev's Noul value is not a calibrated probability of harm. `automatic_approval_forbidden: true` records a known restriction; `false` never grants permission.

Other stop proposals are a fixed recovery instruction for a classified recoverable API error, a wait deadline for a classified quota limit, `manual_review` for uncertain or non-actionable cases, and `no_action` only for a settled `done` state. The CLI neither waits nor sends the instruction. A caller must re-read the agent before recovery delivery; approval additionally requires proof of the exact current permission request and accepting control. It must preserve the tool's existing permission controls, never guess a UI key, and never treat a proposal as a capability. Asserted reset data and refreshed snapshots do not establish a live account or quota binding. Stop assessments do not launch, restart, or change another session.

### Optional Herdr adapter (not activated)

The bundled Herdr 0.9.1 adapter operates only on explicitly configured Pi/Codex pane targets while its visible supervisor pane owns the local lease. It forwards at most 12 returned detection lines (2,048 bytes) for classification; Herdr may mark the read truncated and its read revision is independent of `agent.get`. The excerpt can include earlier screen lines and may be sent to TypeSafe. It is not proof of a current permission request or error. For best-effort recovery, a fresh matching classification plus ready-state and same-session checks may trigger the fixed conditional instruction; an older error can cause an unnecessary prompt. Approval still requires separate proof of the exact current request and accepting control. The adapter does not install a plugin, start an agent, or restart a process.

After separate review and explicit authorization, an operator can link the **disabled** packaged plugin without a source checkout (replace `<package-path>` with the absolute Nix build output path):

```sh
herdr plugin link --disabled "<package-path>/share/agent-steward/herdr-plugin"
```

The package supplies `herdr-plugin.toml`, `run.sh` and a relative link to the package-local Bun adapter wrapper. Linking disabled is not activation: do not enable the plugin or open its `supervisor` pane in a normal Herdr session without a separate opt-in. Before a future opt-in, configure only intended Pi/Codex pane IDs in the plugin's `targets.json` as `{"pane_ids":["w1:p1"]}` (find its directory using `herdr plugin config-dir agent-steward`), then independently review that pane's bounded text disclosure and retry behavior. Packaging tests use an isolated fake Herdr socket and CLI; they do not establish safe live activation.

A recovery proposal waits until its episode-anchored deadline, then re-observes and asks `stop check` again before using Herdr's `agent prompt` command with the fixed instruction. Only an unchanged, ready `idle` agent is eligible. This is best-effort babysitting, not proof that the error is still current: the instruction asks the agent to check prior success and do nothing if the failure is no longer current. Blocked dialogs, including error and permission UI, require a person: no Codex/Pi non-approval dismissal has been proven. `done` is not yet eligible because the current bounded observation path cannot verify a fresh recovery classification for that status. Approval proposals always hand off to a human and never send keys: Herdr 0.9.1's installed Pi lifecycle integration and Codex session hook expose no exact current permission-request identity, action or accepting control. The default verifier returns no proof, and neither a proposed `approve_request`, a detection digest, a blocked status nor a configured key grants authority. There is no approval-key configuration or sending path; if a future independently tested tool-specific verifier and sender are added, `1` is the requested default with optional per-tool override **only after** proof of the current request and accepting control. Quota exhaustion schedules bounded rechecks (5, 15, 45, 120 minutes, then up to six hours) and hands off at 24 hours; it cannot verify account-bound reset times. A prompt timeout, stall, or unknown write outcome is recorded as uncertain and is never automatically resent.

Human handoffs emit fixed, credential-free stderr text and, when Herdr supplies its executable path, call Herdr 0.9.1 `notification show` with a fixed title and body. A successful notification call does not prove that a person saw the toast. Socket device/inode is only a local server-instance proxy, not authenticated session identity. Disposable tests exercised live Jev classification on synthetic context and one adapter-originated conditional prompt to a ready Pi with a synthetic recovery decision; they did not prove genuine-error recovery or human notification visibility. Enabling the plugin in a normal session still needs separate review and explicit authorization.

The supervisor uses a version-2 generation lease with a 15-second heartbeat TTL. On stop it closes local admission immediately and independently publishes a generation revocation marker. On a responsive event loop, the scheduler reports a result within five seconds: `stopped` only after confirmed revocation, or `shutdown_incomplete` with a fixed **release unconfirmed** warning and nonzero exit status. This bounds the scheduler result, not Bun process exit or blocked filesystem calls. While release is unconfirmed, separate event hooks may still act under a live, selected, unrevoked lease. After confirmed release, fresh checks for that generation fail permanently; pre-admitted writes or commands may still finish, and uncertain deliveries are never automatically resent.

Lease storage requires a coherent local filesystem and common host/PID namespace. It does not provide network-filesystem fencing or power-loss durability guarantees. Released generations and generation tombstones remain on disk; storage grows per acquisition, not per heartbeat. Disk-full errors do not grant ownership, and failure to create a revocation marker is incomplete shutdown, not successful cleanup. Safe retention cleanup is separate work.

Legacy `scheduler-lease/owner.json` and stranded `takeover-guard` state require offline human review, not live conversion or age-based deletion. Disable the optional plugin, stop every supervisor and event-hook adapter process, and verify all are dead before removing only the stranded guard or old-format lease state as appropriate. Preserve episode records and all generation tombstones. Do not infer that a guard is safe to delete from lease expiry or the selected owner's death: another publisher may own it. Do not remove the version-2 lease directory to make a timeout appear successful. Enabling the plugin remains a separate explicit opt-in.

Stable error codes are `invalid_input`, `invalid_config`, `missing_credentials`, `credential_detected`, `invalid_response`, `evaluation_failed`, `interactive_terminal_required`, and `launch_failed`. Messages are fixed and do not contain paths, submitted data, credentials, or raw evaluator or process errors. Diagnostics use stderr; JSON stdout contains one result and a newline.

## Command preview references

Syntax baselines for this implementation are Codex 0.157.1, Pi 0.87.1, and `agy` 1.2.11. The Codex effort parser is available in the [0.157.1 version-pinned source](https://raw.githubusercontent.com/openai/codex/rust-v0.157.1/codex-rs/protocol/src/openai_models.rs); the Pi CLI reference is in the [0.87.1 source tag](https://github.com/badlogic/pi-mono/tree/v0.87.1). The agy baseline was checked against 1.2.11 CLI help/error contracts; separate model and effort flags were checked in a no-prompt 1.2.12 startup displaying Gemini 3.8 Flash (Medium) for `--model=gemini-3.8-flash --effort=medium`. These syntax references do not prove model availability or effective runtime effort. Pi documents that thinking levels can be clamped, and agy has model-specific effort restrictions; Codex accepts custom nonempty effort names.

A preview includes a safely quoted display command and a separate literal `args` array, but never runs that command or adds task-delivery input. Codex and Pi include explicit provider selectors; agy uses existing settings. Neither syntax nor configuration proves which account authenticates. The card and JSON result label runtime model/effort and authentication/account binding as unverified.

Offline tests use controlled fixtures and mock HTTP. A temporary fake native executable verifies the process boundary; tests do not contact Jev or launch real agents or models. The bundled skill distinguishes route previews from foreground starts and explains how to provide minimal, user-prepared stop input without treating a proposal as execution authority.
