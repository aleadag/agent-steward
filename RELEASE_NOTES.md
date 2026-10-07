# Unreleased

- Diagnose why automatic approval stopped with `stop show <request-or-attempt-id> --json`. New records include classification, confidence, risk, both approval assessments, the stopping gate, cleanup outcome, and duplicate-skip reason. Retained skips preserve their original diagnostic summary across rotation; no command, screen, or raw provider content is logged. Approval and retry rules are unchanged. See [local stop history](README.md#local-stop-history).

- The optional Herdr adapter now classifies fresh stops after earlier recovery handoffs. Fresh classified completion at `idle` or `done` lets later failures use a new bounded retry budget; screen changes alone do not reset it. Uncertain delivery, cancellation and attempted-snapshot protections remain in place; see the [recovery policy and limits](README.md#optional-herdr-adapter-not-activated).

- Added `stop list` and `stop show` commands for inspecting local stopped-agent assessment history. Stop list/show read local stop history without config or Jev, never store pane/context, and are not delivery proof.

- The optional Herdr recover plugin now runs from status and exit events with pause/resume metadata actions. There is no supervisor pane, startup worker, or menu polling. A recovery or quota proposal can promote the current event command into one temporary job (at most eight per Herdr server). Live plugin registry, config, and socket identity are checked at admission and again before later authorization. Old global supervisor state is retained and blocks migration while live or unverifiable. Socket reads now use a 2-second total/stream/held bound (64 KiB) rather than the previous 3-second idle timeout. This note does not claim live AGY verification.

- The optional Herdr adapter can check quota-blocked agents sooner when a configured model name appears in its screen excerpt and fresh cached quota supplies a reset time. These best-effort hints never delay deadline-driven quota rechecks or authorize input; see the [adapter assumptions and safeguards](README.md#optional-herdr-adapter-not-activated).

- The optional Herdr adapter now automatically reclaims unselected lease generations whose owners are proven dead, reducing retained scheduler history without deleting live or uncertain state. Cleanup runs during acquisition with processing budgets; unverifiable remnants still need [offline review](README.md#optional-herdr-adapter-not-activated).

# v0.1.0-alpha.8 — TypeScript Herdr pane launcher

Release notes for x86_64-linux dogfooding. Package and Nix metadata report `0.1.0-alpha.8`. Earlier alpha tags remain unchanged.

- `bin/steward-spawn` now ships with agent-steward. Pane layout selection, Herdr calls and private launch-file creation use TypeScript rather than Bash and embedded Python.
- The CLI preserves literal task argv, credential stripping before Herdr calls, private temporary-file permissions and largest-pane split geometry. It resolves the configured `agent-steward` command on PATH.
- The `steward-spawn` Nix package exposes only the helper, avoiding collisions with a configured `agent-steward` wrapper. Installed security/argv tests now live in this repository.
- Neither Herdr plugin is automatically installed or activated. Approvals stay human-only.

## Validation and release boundaries

The alpha.8 preparation passed 643 source tests (17 installed-only skips), typecheck, lint, format and x86_64-linux Nix build/help/flake gates, including installed spawn checks. aarch64-linux and Darwin native validation remain outstanding. Live plugin activation requires separate opt-in.

# v0.1.0-alpha.7 — Herdr recover and launcher plugins

Release notes for x86_64-linux dogfooding. Package and Nix metadata report `0.1.0-alpha.7`. Earlier alpha tags remain unchanged.

- Packaged Herdr plugins live under `share/agent-steward/herdr-plugins/`: `agent-steward-recover` (recovery continue and approval handoff) and `agent-steward-launcher` (pane spawn).
- `run.sh` reads `TYPESAFE_API_KEY_FILE` and `AGENT_STEWARD_HERDR_ADAPTER` so a Nix config can inject the key path and adapter command without rebuilding the plugin.
- Approvals stay human-only. The package still does not install or activate the plugins.

## Validation and release boundaries

The alpha.7 preparation passed 643 source tests (17 installed-only skips), typecheck, lint, format and x86_64-linux Nix build/help/flake gates. aarch64-linux and Darwin native validation remain outstanding. Enabling the plugins remains a separate opt-in. Automatic permission approval is not enabled.

# v0.1.0-alpha.6 — watch every Herdr agent by default

Release notes for x86_64-linux dogfooding. Package and Nix metadata report `0.1.0-alpha.6`. Earlier alpha tags remain unchanged.

- The optional Herdr adapter watches every pane Herdr reports as an agent (`agent_session`). Ordinary terminals are not watched. You do not need to list pane IDs. An optional `targets.json` `pane_ids` list still restricts watching if present and nonempty.
- Same agent-agnostic session identity and opaque pane IDs as alpha.5. Approvals stay human-only. The package still does not install or activate the plugin.

## Validation and release boundaries

The alpha.6 preparation passed 643 source tests (17 installed-only skips), typecheck, lint, format and x86_64-linux Nix build/help/flake gates. aarch64-linux and Darwin native validation remain outstanding. Enabling the plugin remains a separate opt-in. Automatic permission approval is not enabled.

# v0.1.0-alpha.5 — agent-agnostic Herdr stop adapter

Release notes for x86_64-linux dogfooding. Package and Nix metadata report `0.1.0-alpha.5`. Earlier alpha tags remain unchanged.

- The optional Herdr adapter watches explicitly configured pane IDs that Herdr reports as agents (a live `agent_session`), not only Pi or Codex. Ordinary terminals without a session are not watched.
- Opaque Herdr pane IDs such as `wG:p1` are accepted. The full session tuple (`agent`, `kind`, `source`, `value`) must stay unchanged before classify or recovery prompt.
- `stop check` `agent.tool` is any nonempty Herdr agent string. Routing's tool inventory remains `codex`, `pi`, and `agy`.
- Approvals stay human-only. The package still does not install or activate the plugin.

## Validation and release boundaries

The alpha.5 preparation passed 642 source tests (17 installed-only skips), 22 installed tests, build, typecheck, lint, format and x86_64-linux Nix build/help/flake gates. Installed regression tests use a fake native executable. Independent whole-branch review of the adapter change passed. aarch64-linux and Darwin native validation remain outstanding; this alpha makes no cross-platform runtime claim. Enabling the plugin in a normal session remains a separate opt-in. Automatic permission approval is not enabled.

# v0.1.0-alpha.4 — native AGY quota and bounded route history

Release notes for x86_64-linux dogfooding. Package and Nix metadata report `0.1.0-alpha.4`. Earlier alpha tags remain unchanged.

- Run `quota setup agy`, then explicitly trust the dedicated native working directory as described in the [README](README.md#one-time-agy-setup-and-service-operation). Setup preserves the previous statusLine renderer and never grants trust or logs in.
- `quota refresh [--json]` now collects Antigravity quota without a caller TTY or model turn. Native AGY may renew the existing consumer login; changed or unknown identity invalidates old quota. Routing remains offline. An enabled AGY bucket must refresh successfully for exit 0; it no longer succeeds as unsupported.
- Change AGY candidates from `quota_pool: "primary"` to `"gemini"` or `"third_party"`; both native limits are required per measured pool. Incomplete pools remain unknown.
- Configure AGY's native model and effort separately: `gemini-3.8-flash` with `medium` requests `--model=gemini-3.8-flash --effort=medium`, without suffix translation. Requested settings remain unverified.
- `router list` now displays aligned columns. History rotates at 5 MiB and retains one backup; list/show read both files. Normal retained size is at most 10 MiB. Older discarded history is unavailable; an existing oversized file can temporarily exceed that bound.

## Validation and release boundaries

The alpha.4 preparation passed 607 source tests (17 installed-only skips), 22 installed tests, build, typecheck, lint, format and x86_64-linux Nix build/help/flake gates. Installed regression tests use a fake native executable. A real installed AGY 1.2.12 refresh with closed stdin also passed, writing complete Gemini and third-party pools without a model turn. Setup accepts the existing empty renderer type and preserves its original shape and unrelated native settings.

AGY 1.2.12 `/usage` backend-refresh behavior is the freshness assumption, not independently traced network proof. Review was author self-review, not independent review. aarch64-linux and Darwin native validation remain outstanding; this alpha makes no cross-platform runtime claim. The optional Herdr adapter remains disabled, and automatic trust/login/permission approval is not enabled.

# v0.1.0-alpha.3 — quota refresh and relative cost

Approved release notes for `v0.1.0-alpha.3`. Package metadata reports `0.1.0-alpha.3`; remote publication requires separate authorization. Same features as the `v0.1.0-alpha.2` tag, plus Oxfmt on the cost-contract test so the Nix package check passes.

This alpha adds explicit `quota refresh` and relative candidate `cost`. Routing still does not fetch quota. Config is breaking versus `v0.1.0-alpha.1`.

## Breaking config

- Remove `accounts` and `candidates[].account_id`.
- Each candidate names `quota_bucket`: Codex tool → `codex`, Pi → `pi_codex` or `pi_xai`, agy → `antigravity`. Native Codex and Pi Codex stay separate.
- Each candidate requires finite `cost` greater than zero (relative ranking hint, not a bill). Example: Luna `1`, Sol `2`.
- Snapshots are generated at `$XDG_STATE_HOME/agent-steward/quota/<bucket>.json` (or `~/.local/state/agent-steward/quota/` when XDG state is unset). They are not config paths.

Copy [examples/config.json](examples/config.json) and replace illustrative models, buckets, and costs with your inventory.

## Try it

```sh
nix build path:.#agent-steward --no-update-lock-file
./result/bin/agent-steward --help
./result/bin/agent-steward --config ./config.json quota refresh --json
./result/bin/agent-steward --config ./config.json router start "Reply hello without using tools" --dry-run --json
./result/bin/agent-steward --config ./config.json router start "Reply hello without using tools"
```

Provide `TYPESAFE_API_KEY` before routing. Live start needs a terminal. Native tools must be on absolute, nonempty `PATH` entries.

## Available in this alpha

- `quota refresh [--json]` reads existing Codex (`~/.codex/auth.json`) and Pi (`~/.pi/agent/auth.json`) logins, fetches measured limits from pinned HTTPS endpoints, and writes secret-free snapshots. Antigravity is `unsupported`. No login, token refresh, CSRF scraping, or Jev.
- `router start --dry-run --json` previews the selected tool, model, thinking level, quota facts, relative cost in evaluation state, and literal launch arguments without starting an agent.
- `router start` launches native Codex, Pi, or agy in the foreground. Settings and account binding are requested, not independently verified.
- `router list` / `router show` read local request history. Legacy `account_id` rows keep tool/model/thinking; they do not invent a bucket.
- `stop check` assesses a user-prepared stopped-agent observation and returns JSON. It does not send input or authorize execution.

## Validation and limits

Offline `bun test` on this revision: 541 passed, 13 installed-only skips. Build and typecheck passed in development. Lint may still report pre-existing warnings.

The development flake lists `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`. This published tag remains the Linux-only release until three-platform native CI is established for the tagged revision.

The bundled Herdr adapter stays experimental and disabled. Automatic approval is not enabled.

## Privacy and feedback

Only `quota refresh` reads documented auth stores and quota hosts. Credentials, emails, and account IDs must not appear in snapshots, stdout, or Jev state. Routing still sends task text and configured candidate/quota facts (including `cost`) to TypeSafe. Credential detection is incomplete. Do not put secrets in a task.

For dogfooding, record the command form, requested tool/model/thinking, `quota_bucket`, `cost`, refresh statuses, exit status, and whether the agent received the task. Redact credentials and private context. See the [README](README.md) for schemas and safety boundaries.

# v0.1.0-alpha.1 — supervised CLI dogfooding

Approved release notes for `v0.1.0-alpha.1`. Commands used `session start`; current CLI uses `router start`. Quota was read-only snapshot input with no collector.
