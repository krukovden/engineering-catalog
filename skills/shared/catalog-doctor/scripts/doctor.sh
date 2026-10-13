#!/usr/bin/env sh
set -u
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
JSON=0
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
for arg in "$@"; do
  [ "$arg" = "--json" ] && JSON=1
done
if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT_DIR/doctor.js" "$@"
fi
if [ "$JSON" -eq 1 ]; then
  ROOT_JSON=$(esc "$(pwd)")
  HOME_JSON=$(esc "${HOME:-}")
  printf '{\n  "root": %s,\n  "home": %s,\n  "checks": [\n    {\n      "status": "fail",\n      "id": "node",\n      "detail": "node is not on PATH.",\n      "fix": "Install Node 20+ and re-run catalog-doctor."\n    },\n    {\n      "status": "warn",\n      "id": "doctor-core",\n      "detail": "catalog-doctor skipped the remaining checks because its core script needs node.",\n      "fix": "Install Node 20+ and re-run catalog-doctor."\n    }\n  ]\n}\n' \
    "\"$ROOT_JSON\"" \
    "\"$HOME_JSON\""
else
  printf 'fail\tnode\tnode is not on PATH.\tfix: Install Node 20+ and re-run catalog-doctor.\n'
  printf 'warn\tdoctor-core\tcatalog-doctor skipped the remaining checks because its core script needs node.\tfix: Install Node 20+ and re-run catalog-doctor.\n'
fi
