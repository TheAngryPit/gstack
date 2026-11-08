import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const active = resolve(root, '.github/workflows');
const allowed = ['actionlint.yml', 'codex-native-parity.yml', 'free-tests.yml', 'quality-gate.yml'];

test('only downstream free validation workflows are active', () => {
  expect(readdirSync(active).sort()).toEqual(allowed);
  for (const file of allowed) {
    const source = readFileSync(resolve(active, file), 'utf8');
    const workflow = Bun.YAML.parse(source) as any;
    expect(workflow.on.schedule).toBeUndefined();
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(source).not.toMatch(/secrets\.|ubicloud-standard|test-paid|eval:bg|docker\/(?:login|build-push)-action/);
    for (const job of Object.values(workflow.jobs) as any[]) {
      expect(job['runs-on']).toBe('ubuntu-24.04');
      expect(job.permissions).toBeUndefined();
    }
  }
});

for (const file of ['evals.yml', 'evals-periodic.yml']) {
  test(`${file}: archived paid jobs retain their official-origin restriction`, () => {
    const source = readFileSync(resolve(root, '.github/upstream-workflows', file), 'utf8');
    const workflow = Bun.YAML.parse(source) as { jobs: Record<string, { if?: string }> };
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.if, name).toMatch(/^(?:github\.repository == 'garrytan\/gstack'|\$\{\{ github\.repository == 'garrytan\/gstack' && \([\s\S]+\) \}\})$/);
    }
  });
}

test('free regression fixtures have a non-personal Git identity', () => {
  const workflow = Bun.YAML.parse(readFileSync(resolve(active, 'free-tests.yml'), 'utf8')) as any;
  expect(workflow.jobs['free-suite'].env).toEqual({
    GIT_AUTHOR_NAME: 'Downstream CI Fixture',
    GIT_AUTHOR_EMAIL: 'downstream-ci@example.test',
    GIT_COMMITTER_NAME: 'Downstream CI Fixture',
    GIT_COMMITTER_EMAIL: 'downstream-ci@example.test',
  });
});
