#!/bin/sh
set -eu
case "${1-}" in
  event|scheduler) ;;
  *) exit 2 ;;
esac
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$plugin_dir/agent-steward-herdr-adapter" "$1"
