set positional-arguments

# List available commands.
default:
    @just --list

# Run any agent-steward CLI command.
run *args:
    nix run path:. --no-update-lock-file -- "$@"

# List recent routing decisions (accepts --limit and --json).
router-list *args:
    nix run path:. --no-update-lock-file -- router list "$@"

# Inspect a routing decision (accepts --json).
router-show request_id *args:
    nix run path:. --no-update-lock-file -- router show "$@"

# Inspect saved quota snapshots.
quota-show *args:
    nix run path:. --no-update-lock-file -- quota show "$@"

# Refresh quota snapshots from existing logins.
quota-refresh *args:
    nix run path:. --no-update-lock-file -- quota refresh "$@"

# Build the Nix package.
build:
    nix build path:.#agent-steward --no-update-lock-file

# Build TypeScript and run the test suite in the pinned development shell.
test:
    nix develop path:. --no-update-lock-file --command bun run test

# Run type, lint, and formatting checks in the pinned development shell.
check:
    nix develop path:. --no-update-lock-file --command bash -c 'bun run typecheck && bun run lint && bun run format:check'
