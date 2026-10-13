#!/usr/bin/env sh
# check.sh — preflight for Azure DevOps access (macOS/Linux/Git Bash).
# Usage: check.sh [--org URL] [--project NAME] [--require-az]
# Prints one JSON line {outcome, detail, steps[], missing?}; exits 0 ok / 3 absent / 4 expired / 1 error.
#
# Same contract as check.ps1. A PAT in AZURE_DEVOPS_EXT_PAT (or ADO_PAT) is the credential when
# set: it is proven with one REST call against the organization (--org, else ADO_ORG, else the az
# default), and a working PAT is `ok` unless the caller runs az and passes --require-az. The PAT
# never appears in any process's argv: curl reads it from a config on stdin, node from its env.
# Without a PAT the credential is the az login: "present" means az is installed, logged in,
# carries the azure-devops extension and has a default organization/project; "works" means the
# project can be read. A credential the organization now rejects is `expired`, never `absent`.
set -u
json() { printf '{"outcome":"%s","detail":"%s","steps":[%s]%s}\n' "$1" "$2" "$3" "${5:-}"; exit "$4"; }
# JSON string: escape backslashes first, then quotes (the other order would double the
# escape just added). Detail text comes from az error output and may hold either.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
q() { printf '"%s"' "$(esc "$1")"; }

org="${ADO_ORG:-}"; proj="${ADO_PROJECT:-}"; require_az=
while [ $# -gt 0 ]; do
  case "$1" in
    --org=*) org="${1#--org=}"; shift ;;
    --project=*) proj="${1#--project=}"; shift ;;
    --org|--project)
      [ $# -ge 2 ] || json error "$1 needs a value" "$(q 'Re-run with --org https://dev.azure.com/<ORG>')" 1
      if [ "$1" = --org ]; then org="$2"; else proj="$2"; fi
      shift 2 ;;
    --require-az) require_az=1; shift ;;
    *) json error "$(esc "unknown argument: $1")" "$(q 'Usage: check.sh [--org URL] [--project NAME] [--require-az]')" 1 ;;
  esac
done

az_default() { az devops configure --list 2>/dev/null | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p"; }

# Az readiness, same detail and steps text as check.ps1's Test-AzReady. Returns 1 with
# az_detail/az_steps set when az is not ready; sets az_org/az_proj when it is.
az_ready() {
  if ! command -v az >/dev/null 2>&1; then
    az_detail="az CLI not installed"
    az_steps="$(q 'Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli'),$(q 'Then run: az login'),$(q 'Then run: az extension add --name azure-devops')"; return 1
  fi
  if ! az account show -o none >/dev/null 2>&1; then
    az_detail="not logged in to az"
    az_steps="$(q 'Run: az login  (or: az login --use-device-code)'),$(q 'Then re-run this check')"; return 1
  fi
  if ! az extension show --name azure-devops -o none >/dev/null 2>&1; then
    az_detail="azure-devops extension missing"
    az_steps="$(q 'Run: az extension add --name azure-devops'),$(q 'Then re-run this check')"; return 1
  fi
  az_org="$(az_default organization)"; az_proj="$(az_default project)"
  if [ -z "$az_org" ] || [ -z "$az_proj" ]; then
    az_detail="no default organization/project"
    az_steps="$(q 'Run: az devops configure --defaults organization=https://dev.azure.com/<ORG> project=<PROJECT>')"; return 1
  fi
  return 0
}

pat="${AZURE_DEVOPS_EXT_PAT:-}"; pat_var=AZURE_DEVOPS_EXT_PAT
[ -n "$pat" ] || { pat="${ADO_PAT:-}"; pat_var=ADO_PAT; }

# --- No PAT: the az login is the credential. ---------------------------------------------
if [ -z "$pat" ]; then
  az_ready || json absent "$az_detail" "$az_steps" 3
  org="$az_org"; proj="$az_proj"
  out="$(az devops project show --project "$proj" --org "$org" -o none 2>&1)" && json ok "$(esc "sign-in works for $org / $proj; permissions are checked when a skill first uses them")" "" 0
  case "$out" in
    *401*|*TF400813*|*expired*|*AADSTS*) json expired "$(esc "az session rejected by $org")" "$(q 'Run: az login  (the cached token expired)'),$(q 'Then re-run this check')" 4 ;;
    *) json error "$(esc "$(printf '%s' "$out" | head -1)")" "$(q 'Check network access and the organization URL, then re-run')" 1 ;;
  esac
fi

# --- A PAT: prove it against the organization. -------------------------------------------
if [ -z "$org" ] && command -v az >/dev/null 2>&1; then org="$(az_default organization)"; fi
[ -n "$org" ] || json absent "no organization to check the PAT against" "$(q 'Re-run with --org https://dev.azure.com/<ORG>')" 3
case "$org" in
  http://*|https://*|HTTP://*|HTTPS://*) ;;
  *) org="https://dev.azure.com/$org" ;;
esac
while :; do case "$org" in */) org="${org%/}" ;; *) break ;; esac; done
# The PAT only goes to https://dev.azure.com/<org>[/...] or https://<org>.visualstudio.com[/...].
org_lc="$(printf '%s' "$org" | sed 'y/ABCDEFGHIJKLMNOPQRSTUVWXYZ/abcdefghijklmnopqrstuvwxyz/')"
org_rest="${org_lc#https://}"
[ "$org_rest" != "$org_lc" ] || json error "not an Azure DevOps organization URL" "$(q 'Re-run with --org https://dev.azure.com/<ORG>')" 1
org_host="${org_rest%%/*}"
org_path="${org_rest#"$org_host"}"
case "$org_host" in
  dev.azure.com) case "$org_path" in /?*) ;; *) json error "not an Azure DevOps organization URL" "$(q 'Re-run with --org https://dev.azure.com/<ORG>')" 1 ;; esac ;;
  *[!a-z0-9.-]*|.*|*..*) json error "not an Azure DevOps organization URL" "$(q 'Re-run with --org https://dev.azure.com/<ORG>')" 1 ;;
  ?*.visualstudio.com) case "${org_host%.visualstudio.com}" in *.*) json error "not an Azure DevOps organization URL" "$(q 'Re-run with --org https://dev.azure.com/<ORG>')" 1 ;; esac ;;
  *) json error "not an Azure DevOps organization URL" "$(q 'Re-run with --org https://dev.azure.com/<ORG>')" 1 ;;
esac
url="$org/_apis/projects?\$top=1&api-version=7.1"

# Prints the response body, then the HTTP status on the last line. Exit status non-zero = no answer.
NODE_PROBE='const u=new URL(process.argv[1]);const m=require(u.protocol==="http:"?"http":"https");
const r=m.request(u,{headers:{Authorization:"Basic "+Buffer.from(":"+process.env.ADO_CHECK_PAT).toString("base64"),Accept:"application/json","X-TFS-FedAuthRedirect":"Suppress"},timeout:20000},res=>{let b="";res.setEncoding("utf8");res.on("data",d=>{if(b.length<65536)b+=d});res.on("end",()=>process.stdout.write(b+"\n"+res.statusCode+"\n"))});
r.on("timeout",()=>r.destroy(new Error("timed out after 20 s")));r.on("error",e=>{process.stderr.write(e.message+"\n");process.exit(1)});r.end();'
if command -v curl >/dev/null 2>&1; then
  out="$(printf 'user = ":%s"\n' "$(printf '%s' "$pat" | sed 's/\\/\\\\/g; s/"/\\"/g')" \
    | curl -sS -K - --max-time 20 -H 'Accept: application/json' -H 'X-TFS-FedAuthRedirect: Suppress' -w '\n%{http_code}\n' "$url" 2>&1)"
  rc=$?
elif command -v node >/dev/null 2>&1; then
  out="$(ADO_CHECK_PAT="$pat" node -e "$NODE_PROBE" "$url" 2>&1)"
  rc=$?
else
  json error "neither curl nor node is installed, so the PAT cannot be checked" "$(q 'Install curl (or Node.js), then re-run this check')" 1
fi
[ "$rc" -eq 0 ] || json error "$(esc "could not reach $org: $(printf '%s\n' "$out" | head -1)")" "$(q 'Check network access and the organization URL, then re-run this check')" 1
code="$(printf '%s\n' "$out" | sed '/^$/d' | sed -n '$p')"

expired_steps="$(q "Azure DevOps rejected the personal access token (PAT) in $pat_var: it expired, was revoked, or lacks a scope. A new one is needed."),$(q 'In Azure DevOps open User settings -> Personal access tokens -> New Token. Scopes: Code (Read) and Work Items (Read & write).'),$(q "Put the new token in $pat_var (never paste it into this chat), then re-run this check.")"
case "$code" in
  200)
    # A real answer is JSON with a count; a sign-in page also comes back 200.
    case "$out" in *'"count"'*) ;; *) json expired "$(esc "Azure DevOps answered $org with a sign-in page; the PAT was not accepted")" "$expired_steps" 4 ;; esac ;;
  203|302|401|403) json expired "$(esc "Azure DevOps rejected the PAT for $org (HTTP $code)")" "$expired_steps" 4 ;;
  404) json error "$(esc "no Azure DevOps organization at $org")" "$(q 'Check the organization URL, then re-run with --org https://dev.azure.com/<ORG>')" 1 ;;
  *) json error "$(esc "Azure DevOps answered $org with HTTP $code")" "$(q 'Check network access and the organization URL, then re-run this check')" 1 ;;
esac

[ -z "$require_az" ] && json ok "$(esc "sign-in works for $org; permissions are checked when a skill first uses them")" "" 0
az_ready || json absent "$(esc "PAT works for $org, but $az_detail")" "$az_steps" 3 ',"missing":"az"'
json ok "$(esc "sign-in works for $org; az is ready; permissions are checked when a skill first uses them")" "" 0
