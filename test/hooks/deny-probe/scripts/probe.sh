#!/bin/sh
# Hands off to Node, the way a real deny hook would; with no `node` on PATH this exits 127.
exec node "${0%.sh}.js" "$@"
