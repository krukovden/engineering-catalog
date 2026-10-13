#!/usr/bin/env bash
set -eu
# Physical path: node reports it, and origin URLs must match the keys it writes.
cd "$(pwd -P)"

git config --global user.email "tester@example.com"
git config --global user.name "Tester"

# State lives in $HOME/.engineering-catalog; the workdir's .engineering-catalog links to it, so
# graders see what the skill really wrote.
mkdir -p "$HOME/.engineering-catalog" remotes seeds src
rm -f "$HOME/.engineering-catalog/workspace.json" "$HOME/.engineering-catalog/repos.json"
rm -rf "$PWD/.engineering-catalog"
ln -s "$HOME/.engineering-catalog" "$PWD/.engineering-catalog"

cat > "$PWD/.engineering-catalog/workspace.json" <<'JSON'
{
  "referenceRoot": "__ROOT__/reference",
  "fetchEveryMinutes": 10
}
JSON

make_repo() {
  name="$1"
  file="$2"
  body="$3"
  subject="$4"
  bare="$PWD/remotes/$name.git"
  seed="$PWD/seeds/$name"
  work="$PWD/src/$name"
  git init -q --bare -b main "$bare"
  git clone -q "$bare" "$seed"
  mkdir -p "$(dirname "$seed/$file")"
  cat > "$seed/$file" <<EOF
$body
EOF
  git -C "$seed" add -A
  git -C "$seed" commit -q -m "$subject"
  git -C "$seed" push -q origin HEAD:main
  if [ "${5:-}" != missing ]; then git clone -q "$bare" "$work"; fi
}

make_repo "Warehouse" "Arm/Calibrate.cs" $'if (readyCalibrationComplete) {\n  return true;\n}\n' "fix: gate ready calibration completion"
make_repo "Reports" "src/export/status.ts" $'export const readyCalibrationComplete = "ready";\n' "feat: surface ready calibration status"
make_repo "Sidecar" "pkg/device/calibration.go" $'const readyCalibrationComplete = "complete"\n' "chore: record ready calibration completion" missing

node - <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const repos = {};
for (const name of ['Warehouse', 'Reports']) {
  const remote = path.join(root, 'remotes', `${name}.git`);
  repos[remote] = {
    name,
    paths: [path.join(root, 'src', name)],
    reference: null,
    fetchedAt: '2026-10-13T12:00:00.000Z',
    fetchedPath: path.join(root, 'src', name),
  };
}
// Known, but not on this computer: searching it needs a yes to download it first.
repos[path.join(root, 'remotes', 'Sidecar.git')] = { name: 'Sidecar', paths: [], reference: null };
fs.writeFileSync(path.join(root, '.engineering-catalog', 'repos.json'), `${JSON.stringify(repos, null, 2)}\n`);
const workspacePath = path.join(root, '.engineering-catalog', 'workspace.json');
fs.writeFileSync(
  workspacePath,
  fs.readFileSync(workspacePath, 'utf8').replace('__ROOT__', root),
);
NODE
