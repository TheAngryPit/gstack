/**
 * #542: /office-hours in host plan mode leaves a plan-file copy of its design
 * doc. The doc stays the source of truth: office-hours writes plan-copy edits
 * through and records the pairing, and the discovery helper every plan review
 * runs names the copy and warns when it is newer than the doc.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const FIND = path.join(ROOT, 'bin', 'gstack-design-doc-find');

function fixture(run: (dirs: { root: string; home: string; cwd: string; project: string }) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-copy-'));
  try {
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'work');
    const project = path.join(home, '.gstack', 'projects', 'fixture');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(cwd);
    run({ root, home, cwd, project });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function write(file: string, body: string, secondsAgo: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, t, t);
}

function find(home: string, cwd: string): { stdout: string; stderr: string } {
  const r = spawnSync(FIND, ['fixture', 'main'], {
    cwd, env: { PATH: process.env.PATH!, HOME: home }, encoding: 'utf8', timeout: 10_000,
  });
  expect(r.status).toBe(0);
  return { stdout: r.stdout, stderr: r.stderr };
}

describe('gstack-design-doc-find names the host plan copy (#542)', () => {
  test('no recorded copy: stdout is the doc and stderr stays empty', () => fixture(({ home, cwd, project }) => {
    const doc = path.join(project, 'u-main-design-1.md');
    write(doc, '# Design\n', 60);
    expect(find(home, cwd)).toEqual({ stdout: `${doc}\n`, stderr: '' });
  }));

  test('a copy in sync is named with its write-through command and no warning', () => fixture(({ root, home, cwd, project }) => {
    const doc = path.join(project, 'u-main-design-1.md');
    const copy = path.join(root, 'plans', 'calm-otter.md');
    write(copy, '# Design\n', 120);
    write(doc, '# Design\n', 60);
    write(`${doc}.plan-copy`, `${copy}\n`, 60);
    const out = find(home, cwd);
    expect(out.stdout).toBe(`${doc}\n`);
    expect(out.stderr).toContain(`DESIGN_PLAN_COPY: ${copy} is the host plan-mode copy of ${doc}`);
    expect(out.stderr).toContain(`cp "${copy}" "${doc}"`);
    expect(out.stderr).not.toContain('STALE_DESIGN_DOC');
  }));

  test('a newer, edited copy warns; running the printed write-through clears it', () => fixture(({ root, home, cwd, project }) => {
    const doc = path.join(project, 'u-main-design-1.md');
    const copy = path.join(root, 'plans', 'calm-otter.md');
    write(doc, '# Design\nold approach\n', 120);
    write(`${doc}.plan-copy`, `${copy}\n`, 120);
    write(copy, '# Design\nrefined approach\n', 30);
    const stale = find(home, cwd);
    expect(stale.stdout).toBe(`${doc}\n`);
    const warning = stale.stderr.split('\n').find(line => line.startsWith('STALE_DESIGN_DOC: '));
    expect(warning).toBe(`STALE_DESIGN_DOC: the plan copy is newer than ${doc}. Write it through now, then read ${doc}: cp "${copy}" "${doc}"`);
    const cp = spawnSync('bash', ['-c', warning!.slice(warning!.indexOf(': cp ') + 2)], { encoding: 'utf8', timeout: 10_000 });
    expect(cp.status).toBe(0);
    expect(fs.readFileSync(doc, 'utf8')).toBe('# Design\nrefined approach\n');
    expect(find(home, cwd).stderr).not.toContain('STALE_DESIGN_DOC');
  }));

  test('a doc edited after the copy is not reported stale', () => fixture(({ root, home, cwd, project }) => {
    const doc = path.join(project, 'u-main-design-1.md');
    const copy = path.join(root, 'plans', 'calm-otter.md');
    write(copy, '# Design\nfirst draft\n', 120);
    write(doc, '# Design\nedited doc\n', 30);
    write(`${doc}.plan-copy`, `${copy}\n`, 30);
    const out = find(home, cwd);
    expect(out.stderr).toContain('DESIGN_PLAN_COPY: ');
    expect(out.stderr).not.toContain('STALE_DESIGN_DOC');
  }));

  test('a relative, non-markdown or missing recorded path is ignored', () => fixture(({ root, home, cwd, project }) => {
    const doc = path.join(project, 'u-main-design-1.md');
    write(doc, '# Design\n', 120);
    write(path.join(root, 'notes.txt'), 'x\n', 10);
    for (const recorded of ['plans/calm-otter.md', path.join(root, 'notes.txt'), path.join(root, 'plans', 'gone.md')]) {
      write(`${doc}.plan-copy`, `${recorded}\n`, 120);
      expect(find(home, cwd)).toEqual({ stdout: `${doc}\n`, stderr: '' });
    }
  }));

  test('when the repo copy wins discovery, the write-through still targets the state-root doc', () => fixture(({ root, home, cwd, project }) => {
    const init = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd, timeout: 30_000 });
    expect(init.status).toBe(0);
    const doc = path.join(project, 'u-main-design-1.md');
    const repoDoc = path.join(cwd, 'docs', 'designs', 'pricing.md');
    const copy = path.join(root, 'plans', 'calm-otter.md');
    write(doc, '# Pricing\n', 120);
    write(`${doc}.plan-copy`, `${copy}\n`, 120);
    write(repoDoc, '# Pricing\n', 100);
    write(copy, '# Pricing\nedited in plan mode\n', 30);
    const out = find(home, cwd);
    expect(fs.realpathSync(out.stdout.trim())).toBe(fs.realpathSync(repoDoc));
    expect(out.stderr).toContain(`Write it through now, then read ${doc}: cp "${copy}" "${doc}"`);
  }));
});

describe('/office-hours writes the plan copy through before telemetry (#542)', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'office-hours', 'SKILL.md'), 'utf8');
  const section = skill.slice(skill.indexOf("## Before telemetry: confirm this run's design doc"));
  const block = section.slice(section.indexOf('```bash\n') + 8, section.indexOf('\n```', section.indexOf('```bash\n') + 8));

  function confirm(home: string, doc: string, plan: string): string {
    const script = block.replaceAll('~/.claude/skills/gstack/bin/', `${ROOT}/bin/`)
      .replace('DESIGN_DOC_PATH', doc).replace('HOST_PLAN_PATH', plan);
    const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH!, HOME: home }, encoding: 'utf8', timeout: 10_000 });
    expect(r.status).toBe(0);
    return r.stdout;
  }

  test('plan-mode edits land in the doc and the pairing is recorded', () => fixture(({ root, home, project }) => {
    const doc = path.join(project, 'u-main-design-1.md');
    const plan = path.join(root, 'plans', 'calm-otter.md');
    write(doc, '# Design\nas approved\n', 120);
    write(plan, '# Design\nrevised in plan mode\n', 30);
    expect(confirm(home, doc, plan)).toBe('DESIGN_DOC: ok\nPLAN_COPY: written through\n');
    expect(fs.readFileSync(doc, 'utf8')).toBe('# Design\nrevised in plan mode\n');
    expect(fs.readFileSync(`${doc}.plan-copy`, 'utf8')).toBe(`${plan}\n`);
  }));

  test('an older plan file never overwrites the doc', () => fixture(({ root, home, project }) => {
    const doc = path.join(project, 'u-main-design-1.md');
    const plan = path.join(root, 'plans', 'calm-otter.md');
    write(plan, '# Design\nfirst draft\n', 120);
    write(doc, '# Design\nfinal\n', 30);
    expect(confirm(home, doc, plan)).toBe('DESIGN_DOC: ok\n');
    expect(fs.readFileSync(doc, 'utf8')).toBe('# Design\nfinal\n');
  }));

  test('outside plan mode nothing is recorded', () => fixture(({ home, project }) => {
    const doc = path.join(project, 'u-main-design-1.md');
    write(doc, '# Design\n', 30);
    expect(confirm(home, doc, '')).toBe('DESIGN_DOC: ok\n');
    expect(fs.existsSync(`${doc}.plan-copy`)).toBe(false);
  }));
});

describe('plan reviews act on the helper lines (#542)', () => {
  for (const skill of ['plan-ceo-review', 'plan-eng-review']) {
    test(`${skill} follows DESIGN_PLAN_COPY and STALE_DESIGN_DOC`, () => {
      const text = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf8');
      expect(text).toContain('DESIGN_PLAN_COPY');
      expect(text).toContain('STALE_DESIGN_DOC');
    });
  }
});
