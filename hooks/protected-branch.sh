#!/bin/sh
# Hands the PreToolUse payload to the Node implementation; no node means nothing to decide with,
# so the call goes ahead.
command -v node >/dev/null 2>&1 || exit 0
exec node "${0%.sh}.js" "$@"
