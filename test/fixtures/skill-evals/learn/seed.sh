#!/bin/sh
# Seeds a /learn eval work dir: a git repo plus a gstack state root at ./.gstack-home.
# Usage (from a task's setup, cwd = the run's work dir): sh "$SKILL_EVAL_FIXTURES/seed.sh" full|empty|cross
# Heredoc delivery guard: bash 5.2+ pipes heredoc bodies <=64KiB, and on
# macOS a starved 512-byte pipe hangs bodies >=512B at startup. Compat level
# 50 restores the tempfile path (test/heredoc-pipe-deadlock.test.ts).
BASH_COMPAT=50
set -eu
mode="${1:-full}"
git init -q -b main
git config user.email eval@example.com
git config user.name eval
mkdir -p app/models
printf 'class User < ApplicationRecord\n  def orders_total\n    orders.map { |o| o.items.sum(:price) }.sum\n  end\nend\n' > app/models/user.rb
git add -A
git commit -qm init
printf '.gstack-home/\n' >> .git/info/exclude
slug=$(basename "$PWD" | tr -cd 'a-zA-Z0-9._-')
dir=".gstack-home/projects/$slug"
mkdir -p "$dir"
[ "$mode" = empty ] && exit 0
cat > "$dir/learnings.jsonl" <<'EOF'
{"skill":"review","type":"pattern","key":"n-plus-one-queries","insight":"Associations in loops cause N+1 queries; preload them.","confidence":6,"source":"observed","ts":"2026-09-01T00:00:00.000Z","files":["app/models/user.rb"],"trusted":false}
{"skill":"review","type":"pattern","key":"n-plus-one-queries","insight":"ActiveRecord associations in loops cause N+1 queries. Always use includes or preload.","confidence":9,"source":"observed","ts":"2026-10-20T00:00:00.000Z","files":["app/models/user.rb"],"trusted":false}
{"skill":"investigate","type":"pitfall","key":"stale-cache-after-deploy","insight":"Redis cache is not invalidated on deploy, so data is stale for 5 minutes.","confidence":7,"source":"observed","ts":"2026-10-21T00:00:00.000Z","files":["config/redis.yml"],"trusted":false}
{"skill":"ship","type":"preference","key":"always-run-rubocop","insight":"Run rubocop before every commit, no exceptions.","confidence":10,"source":"user-stated","ts":"2026-10-22T00:00:00.000Z","trusted":true}
{"skill":"qa","type":"operational","key":"test-timeout-flag","insight":"bun test needs --timeout 30000 for E2E tests here.","confidence":9,"source":"observed","ts":"2026-10-23T00:00:00.000Z","trusted":false}
{"skill":"review","type":"pattern","key":"api-retry-count","insight":"Retry failed payment API calls 3 times with backoff.","confidence":7,"source":"observed","ts":"2026-10-24T00:00:00.000Z","trusted":false}
{"skill":"investigate","type":"pitfall","key":"api-retry-count","insight":"Never retry failed payment API calls; retries double-charge customers.","confidence":8,"source":"observed","ts":"2026-10-25T00:00:00.000Z","trusted":false}
EOF
[ "$mode" = cross ] || exit 0
other=".gstack-home/projects/other-service"
mkdir -p "$other"
cat > "$other/learnings.jsonl" <<'EOF'
{"skill":"ship","type":"pattern","key":"docker-layer-cache","insight":"Copy the lockfile before the source in Dockerfiles so the dependency layer stays cached.","confidence":9,"source":"user-stated","ts":"2026-10-10T00:00:00.000Z","trusted":true}
{"skill":"review","type":"pitfall","key":"docker-root-user","insight":"Containers run as root by default.","confidence":6,"source":"observed","ts":"2026-10-11T00:00:00.000Z","trusted":false}
EOF
