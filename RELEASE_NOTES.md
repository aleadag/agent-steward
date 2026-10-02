# Unreleased — native AGY quota

- Run `quota setup agy`, then explicitly trust the dedicated native working directory as described in the [README](README.md#one-time-agy-setup-and-service-operation). Setup preserves the previous statusLine renderer and never grants trust or logs in.
- `quota refresh [--json]` now collects Antigravity quota without a caller TTY or model turn. Native AGY may renew the existing consumer login; changed or unknown identity invalidates old quota. Routing remains offline.
- Change AGY candidates from `quota_pool: "primary"` to `"gemini"` or `"third_party"`; both native limits are required per measured pool. Incomplete pools remain unknown.

Linux source and installed checks pass. Darwin native validation remains outstanding. Package version and published alpha tags are unchanged; these changes are not a published release.

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
