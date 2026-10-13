#!/usr/bin/env bash
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"
git remote add origin "https://dev.azure.com/acme/Orion/_git/api"
echo "sample project" > README.md
git add -A
git commit -qm "init"

mkdir -p .engineering-catalog .github
cat > .engineering-catalog/receipt.json <<'JSON'
{
  "installs": [
    { "source": "https://example/repo", "catalogVersion": "1.0.0" }
  ]
}
JSON

cat > CLAUDE.md <<'MD'
<!-- engineering-catalog:memory:start -->
old
<!-- engineering-catalog:memory:end -->
MD

cat > AGENTS.md <<'MD'
<!-- engineering-catalog:memory:start v=1 -->
current
<!-- engineering-catalog:memory:end -->
MD

cat > .github/copilot-instructions.md <<'MD'
<!-- engineering-catalog:memory:start v=1 -->
current
<!-- engineering-catalog:memory:end -->
MD

cat > .git/hooks/post-commit <<'HOOK'
#!/bin/sh
# engineering-catalog:memory:start
old
# engineering-catalog:memory:end
HOOK
chmod +x .git/hooks/post-commit
