#!/usr/bin/env sh
# check.sh — preflight for Azure DevOps access through the az CLI (macOS/Linux/Git Bash).
# Prints one JSON line {outcome, detail, steps[]}; exits 0 ok / 3 absent / 4 expired / 1 error.
#
# Same vocabulary as check.ps1. "Present" means az is installed, logged in, carries the
# azure-devops extension and has a default organization/project; "works" means the
# project can actually be read with the cached login. A cached session that the
# organization now rejects is `expired`, never `absent`.
set -u
json() { printf '{"outcome":"%s","detail":"%s","steps":[%s]}\n' "$1" "$2" "$3"; exit "$4"; }
# JSON string: escape backslashes first, then quotes (the other order would double the
# escape just added). Detail text comes from az error output and may hold either.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
q() { printf '"%s"' "$(esc "$1")"; }
command -v az >/dev/null 2>&1 || json absent "az CLI not installed" "$(q 'Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli'),$(q 'Then run: az login'),$(q 'Then run: az extension add --name azure-devops')" 3
az account show -o none >/dev/null 2>&1 || json absent "not logged in to az" "$(q 'Run: az login  (or: az login --use-device-code)'),$(q 'Then re-run this check')" 3
az extension show --name azure-devops -o none >/dev/null 2>&1 || json absent "azure-devops extension missing" "$(q 'Run: az extension add --name azure-devops'),$(q 'Then re-run this check')" 3
org="$(az devops configure --list 2>/dev/null | sed -n 's/^[[:space:]]*organization[[:space:]]*=[[:space:]]*//p')"
proj="$(az devops configure --list 2>/dev/null | sed -n 's/^[[:space:]]*project[[:space:]]*=[[:space:]]*//p')"
[ -n "$org" ] && [ -n "$proj" ] || json absent "no default organization/project" "$(q 'Run: az devops configure --defaults organization=https://dev.azure.com/<ORG> project=<PROJECT>')" 3
out="$(az devops project show --project "$proj" --org "$org" -o none 2>&1)" && json ok "$(esc "reached $org / $proj")" "" 0
case "$out" in
  *401*|*TF400813*|*expired*|*AADSTS*) json expired "$(esc "az session rejected by $org")" "$(q 'Run: az login  (the cached token expired)'),$(q 'Then re-run this check')" 4 ;;
  *) json error "$(esc "$(printf '%s' "$out" | head -1)")" "$(q 'Check network access and the organization URL, then re-run')" 1 ;;
esac
