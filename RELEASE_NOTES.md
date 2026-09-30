# v0.1.0-alpha.1 — supervised CLI dogfooding

Approved release notes for `v0.1.0-alpha.1`. Package metadata reports `0.1.0-alpha.1`; remote publication requires separate authorization.

Agent-steward routes a task through Jev to a configured native agent and launches it in the foreground. This first alpha is for supervised CLI use: keep native permission controls in place and leave the optional Herdr plugin disabled.

## Try it

The Nix package currently targets `x86_64-linux` and bundles its Bun runtime. Install your chosen native tool separately and configure its authentication.

```sh
nix build path:.#agent-steward --no-update-lock-file
./result/bin/agent-steward --help
./result/bin/agent-steward --config ./config.json session start "Reply hello without using tools" --dry-run --json
./result/bin/agent-steward --config ./config.json session start "Reply hello without using tools"
```

Create `config.json` from [examples/config.json](examples/config.json), replacing illustrative models and accounts with your local inventory. Provide `TYPESAFE_API_KEY` through the environment before either routing command. The live command requires a terminal; the native tool must be available through absolute, nonempty `PATH` entries.

## Available in this alpha

- `session start --dry-run --json` previews the selected tool, model, thinking level, and literal launch arguments without starting an agent.
- `session start` launches native Codex, Pi, or agy in the foreground. Settings and account binding are requested, not independently verified.
- `stop check` assesses a user-prepared stopped-agent observation and returns JSON. It does not send input or authorize execution.
- Quota snapshots are local, read-only inputs. Missing or stale quota remains unknown; there is no live quota collector.

## Validation and limits

Pre-release checks passed: 393 offline tests, with six installed-test skips covered by a separate packaged suite of 11 passing tests; build, typecheck, formatting, Nix build, and flake checks. Lint exited successfully with nine warnings.

One authorized live smoke exercised actual Jev routing and a real Pi launch. The route requested `openai-codex/gpt-6-luna` with `low` thinking. Pi returned the exact requested acknowledgement, used no tools, left the disposable working directory unchanged, and exited zero after `/quit`. This verifies that one Pi route received and answered its task, not task completion generally or effective runtime settings. Codex and agy live launches remain untested.

The bundled Herdr adapter is experimental and disabled. Genuine-error recovery, Codex handling, and human-visible notifications remain unproven. Automatic approval is not enabled; approval proposals require a human.

## Privacy and feedback

Routing sends task text and configured candidate/quota facts to TypeSafe; evaluated `stop check` requests send the supplied observation. Credential detection is incomplete. Submit only nonsensitive text, and never put secrets in a task: live task arguments can appear in local process listings. The launcher removes `TYPESAFE_API_KEY` from the native child environment, while other native credentials pass through.

For dogfooding feedback, record the command form, requested tool/model/thinking, exit status, and whether the agent received the task. Redact credentials and private task or stop context before sharing. See the [README](README.md) for configuration, result schemas, and safety boundaries.
