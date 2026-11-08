#!/bin/sh
# Seeds a /write-skill eval work dir. Usage: sh "$SKILL_EVAL_FIXTURES/seed.sh" lesson|new
set -eu
mkdir -p deploy
cat > deploy/SKILL.md <<'EOF'
---
name: deploy
description: Deploy the web app to production.
---

# Deploy

1. Build the release image with `make release`.
2. Run database migrations before restarting the web servers.
3. Restart the web servers one at a time.
4. Check the health endpoint returns 200.
EOF
cat > CHANGELOG.md <<'EOF'
# Changelog

## Unreleased

- Fix login redirect loop.

## 1.2.0

- Add CSV export.
EOF
