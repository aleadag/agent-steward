#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  core)
    # Pure/injected-IO policy tests and bounded file/stream readers. Process,
    # socket, PTY, lease/contention and real-time integration stay in full.
    tests=(
      tests/agy-auth.test.ts
      tests/agy-hook.test.ts
      tests/agy-protocol.test.ts
      tests/agy-quota.test.ts
      tests/approval.test.ts
      tests/api-routing.test.ts
      tests/bun-cache.test.ts
      tests/commands.test.ts
      tests/config.test.ts
      tests/contracts.test.ts
      tests/evaluator-config.test.ts
      tests/herdr-quota-hint.test.ts
      tests/io.test.ts
      tests/jev.test.ts
      tests/limits.test.ts
      tests/native-route.test.ts
      tests/policy-check.test.ts
      tests/privacy.test.ts
      tests/quota.test.ts
      tests/response-details.test.ts
      tests/retry.test.ts
      tests/routing.test.ts
      tests/triage.test.ts
    )
    timing=0
    ;;
  full)
    # Discover new tests automatically; this is not a blacklist of CI failures.
    tests=(tests/*.test.ts)
    timing=1
    ;;
  *)
    printf '%s\n' 'usage: package-checks.sh core|full' >&2
    exit 2
    ;;
esac

AGENT_STEWARD_TEST_TIMING="$timing" bun test "${tests[@]}"
bun dist/src/main.js --help > /dev/null
