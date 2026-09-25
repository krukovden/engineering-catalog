#!/usr/bin/env bash
# A project with an installed engineering-catalog receipt pointing at a local "remote"
# that has a newer tag than the installed version, so check-freshness.sh has something
# real to report instead of staying quiet.
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"
echo "sample project" > README.md
git add -A
git commit -qm "init"

SRC_DIR="$(pwd)/.catalog-src"
git init -q "$SRC_DIR"
(
  cd "$SRC_DIR"
  git config user.email "tester@example.com"
  git config user.name "tester"
  echo "v1" > f.txt
  git add -A
  git commit -qm "v1"
  git tag v1.2.0
  echo "v2" > f.txt
  git add -A
  git commit -qm "v2"
  git tag v1.3.0
)

mkdir -p .engineering-catalog
cat > .engineering-catalog/receipt.json <<JSON
{
  "installs": [
    { "source": "$SRC_DIR", "catalogVersion": "1.2.0" }
  ]
}
JSON
