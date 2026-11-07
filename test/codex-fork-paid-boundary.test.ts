import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const file of ['evals.yml', 'evals-periodic.yml']) {
  test(`${file}: every paid workflow job is restricted to the official repository`, () => {
    const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '..', '.github/workflows', file), 'utf8')) as { jobs: Record<string, { if?: string }> };
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.if, name).toMatch(/^(?:github\.repository == 'garrytan\/gstack'|\$\{\{ github\.repository == 'garrytan\/gstack' && \([\s\S]+\) \}\})$/);
    }
  });
}
