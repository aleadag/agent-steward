#!/bin/sh
set -eu
case "${1-}" in
  event|scheduler) ;;
  *) exit 2 ;;
esac
if [ -z "${TYPESAFE_API_KEY:-}" ] && [ -n "${TYPESAFE_API_KEY_FILE:-}" ] && [ -r "$TYPESAFE_API_KEY_FILE" ]; then
  TYPESAFE_API_KEY=$(cat -- "$TYPESAFE_API_KEY_FILE")
  export TYPESAFE_API_KEY
fi
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
adapter="${AGENT_STEWARD_HERDR_ADAPTER:-$plugin_dir/agent-steward-herdr-adapter}"
exec "$adapter" "$1"
