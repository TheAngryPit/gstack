import { describe, expect, beforeAll, afterAll } from 'bun:test';
import { CAPTURE_MS, JUDGE_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, describeIfSelected, testConcurrentIfSelected, copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-write-skill');

const DEPLOY_SKILL = `---
name: deploy
description: Deploy the web app to production.
---

# Deploy

1. Build the release image with \`make release\`.
2. Run database migrations before restarting the web servers.
3. Restart the web servers one at a time.
4. Check the health endpoint returns 200.
`;

describeIfSelected('/write-skill E2E', ['write-skill-add-lesson'], () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-write-skill-'));
    copyDirSync(path.join(ROOT, 'write-skill'), path.join(workDir, 'write-skill'));
    fs.mkdirSync(path.join(workDir, 'deploy'));
    fs.writeFileSync(path.join(workDir, 'deploy', 'SKILL.md'), DEPLOY_SKILL);
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    finalizeEvalCollector(evalCollector);
  });

  testConcurrentIfSelected('write-skill-add-lesson', async () => {
    const result = await runSkillTest({
      prompt: `Read the file write-skill/SKILL.md for the /write-skill skill instructions.

Add this lesson to the deploy skill in ./deploy: "Last Tuesday we restarted the web servers while migrations were still running and the site returned 500s for ten minutes. Migrations must finish before any restart."

IMPORTANT:
- The gstack bin scripts are at ${ROOT}/bin/, not at ~/.claude/skills/gstack/bin/; use that path.
- ./deploy is a skill folder the user owns, not a git repository.
- Do NOT use AskUserQuestion. Edit the file, then report what you changed and its size before and after.`.replace('${ROOT}', ROOT),
      workingDirectory: workDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: JUDGE_MS,
      testName: 'write-skill-add-lesson',
      runId,
    });
    logCost('/write-skill add lesson', result);

    const after = fs.readFileSync(path.join(workDir, 'deploy', 'SKILL.md'), 'utf-8');
    const grewBy = after.trimEnd().split('\n').length - DEPLOY_SKILL.trimEnd().split('\n').length;
    const ruleLanded = /finish|complete|wait/i.test(after.split('\n').find(l => /migration/i.test(l)) ?? '');
    const storyKept = /tuesday|500s?|ten minutes/i.test(after);
    const reportedSize = /\d+\s*(B|bytes)?\s*(→|->|to)\s*\d+/i.test(result.output);
    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, '/write-skill', 'Add a lesson by editing the existing line', result, {
      passed: exitOk && grewBy <= 1 && ruleLanded && !storyKept && reportedSize,
    });
    expect(exitOk).toBe(true);
    expect(ruleLanded).toBe(true);
    expect(storyKept).toBe(false);
    expect(grewBy).toBeLessThanOrEqual(1);
    expect(reportedSize).toBe(true);
  }, CAPTURE_MS);
});
