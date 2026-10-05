/**
 * C4 (#2777): ship and plan-ceo-review are carved on every host, and no
 * generated SKILL.md exceeds 160,000 UTF-8 bytes on any host or model overlay
 * setup can select. Carved sections on external hosts are pointed at relative
 * to the installed skill directory: `$GSTACK_ROOT/<skill>/sections/...` does
 * not exist in external runtime roots (Codex's holds bin, lib, browse, review).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { ALL_MODEL_NAMES } from '../scripts/models';
import { runGeneration } from '../scripts/gen-skill-docs';
import { sectionPath, SKILL_BYTE_CEILING, usesLazySections } from '../scripts/resolvers/sections';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { prepareMethodology } from '../bin/gstack-autoplan-snapshot';

const ROOT = path.resolve(import.meta.dir, '..');
const EXTERNAL = ALL_HOST_CONFIGS.filter(c => c.name !== 'claude');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-external-carve-'));
const context = (host: string, skillName: string): TemplateContext => ({ host, skillName, tmplPath: '', paths: HOST_PATHS[host] });
const skillDir = (host: (typeof ALL_HOST_CONFIGS)[number], out: string, skill: string) =>
  host.name === 'claude' ? path.join(out, skill) : path.join(out, host.hostSubdir, 'skills', `gstack-${skill}`);

function skillFiles(out: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(path.join(dir, e.name)); }
      else if (e.name === 'SKILL.md') files.push(path.join(dir, e.name));
    }
  };
  walk(out);
  return files;
}

const renders: Record<string, string> = {};
beforeAll(async () => {
  renders.all = path.join(tmp, 'all');
  const all = await runGeneration({ host: 'all', outputRoot: renders.all });
  expect(all.diagnostics.filter(d => d.kind === 'error' || d.kind === 'warning').map(d => d.message)).toEqual([]);
  for (const model of ALL_MODEL_NAMES) {
    renders[model] = path.join(tmp, `codex-${model}`);
    const r = await runGeneration({ host: 'codex', model, outputRoot: renders[model] });
    expect(r.diagnostics.filter(d => d.kind === 'error').map(d => d.message)).toEqual([]);
  }
}, 120_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('C4: external section pointers', () => {
  for (const config of EXTERNAL) {
    test(`${config.name}: ship and plan-ceo-review point to sections in the installed layout`, () => {
      const ship = sectionPath(context(config.name, 'ship'), 'ship', 'tests');
      const plan = sectionPath(context(config.name, 'plan-ceo-review'), 'plan-ceo-review', 'review-sections');
      expect(ship).toBe('`sections/tests.md` relative to the installed `gstack-ship` SKILL.md directory');
      expect(plan).toBe('`sections/review-sections.md` relative to the installed `gstack-plan-ceo-review` SKILL.md directory');
      expect(ship).not.toContain('$GSTACK_ROOT');
      expect(plan).not.toContain('$GSTACK_ROOT');
    });
  }

  test('claude keeps its global-root pointer (bytes unchanged)', () => {
    expect(sectionPath(context('claude', 'ship'), 'ship', 'tests')).toBe('`~/.claude/skills/gstack/ship/sections/tests.md`');
  });
});

describe('C4: ship and plan-ceo-review are carved on every external host', () => {
  for (const config of EXTERNAL) {
    test(`${config.name}: every pointer in the carved skill resolves to a generated section file`, () => {
      for (const skill of ['ship', 'plan-ceo-review']) {
        expect(usesLazySections(config.name, skill)).toBe(true);
        const dir = skillDir(config, renders.all, skill);
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, skill, 'sections', 'manifest.json'), 'utf8')) as { sections: Array<{ file: string }> };
        const text = [fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'),
          ...manifest.sections.map(s => fs.readFileSync(path.join(dir, 'sections', s.file), 'utf8'))].join('\n');
        expect(text).not.toMatch(new RegExp(`\\$GSTACK_ROOT/${skill}/sections/`));
        const relativePointers = [...text.matchAll(new RegExp(`\`sections/([\\w.-]+)\` relative to the installed \`gstack-${skill}\` SKILL\\.md directory`, 'g'))].map(m => m[1]);
        const rootedPointer = new RegExp(`\\$GSTACK_ROOT/(?:\\.agents/skills/)?gstack-${skill}/sections/[\\w.-]+`);
        expect(text).not.toMatch(rootedPointer);
        expect(relativePointers.length).toBeGreaterThan(0);
        for (const file of relativePointers) expect(fs.existsSync(path.join(dir, 'sections', file)), `${skill}/sections/${file}`).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('## Section index');
      }
    });
  }

  test('non-Codex external renders do not point at <root>/<skill>/sections/ (runtime roots have no section trees)', () => {
    const offenders: string[] = [];
    for (const config of EXTERNAL) {
      if (config.name === 'codex') continue;
      for (const file of skillFiles(path.join(renders.all, config.hostSubdir))) {
        const hits = fs.readFileSync(file, 'utf8').match(/(?:\$GSTACK_ROOT|~\/[\w./-]*skills\/gstack)\/[a-z0-9-]+\/sections\/[\w.-]+/g) ?? [];
        offenders.push(...hits.map(hit => `${path.relative(renders.all, file)}: ${hit}`));
      }
    }
    expect(offenders).toEqual([]);
    const codex = ALL_HOST_CONFIGS.find(c => c.name === 'codex')!;
    const engDir = skillDir(codex, renders.all, 'plan-eng-review');
    expect(fs.readFileSync(path.join(engDir, 'SKILL.md'), 'utf8'))
      .toContain('`sections/review-sections.md` relative to the installed `gstack-plan-eng-review` SKILL.md directory');
    expect(fs.existsSync(path.join(engDir, 'sections', 'review-sections.md'))).toBe(true);
    const htmlDir = skillDir(codex, renders.all, 'design-html');
    const html = fs.readFileSync(path.join(htmlDir, 'SKILL.md'), 'utf8');
    expect(html).toContain('`sections/detector-install-offer.md` relative to the installed `gstack-design-html` SKILL.md directory');
    expect(fs.existsSync(path.join(htmlDir, 'sections', 'detector-install-offer.md'))).toBe(true);
    expect(fs.readFileSync(path.join(htmlDir, 'sections', 'detector-install-offer.md'), 'utf8'))
      .toContain('the user has never answered this. Ask now');
  });

  test('codex: the autoplan methodology loader accepts the carved plan-ceo-review install', () => {
    const codex = ALL_HOST_CONFIGS.find(c => c.name === 'codex')!;
    const restore = path.join(tmp, 'restore.md');
    fs.writeFileSync(restore, '# plan\n');
    const prepared = prepareMethodology('ceo', path.join(skillDir(codex, renders.all, 'plan-ceo-review'), 'SKILL.md'), restore);
    const methodology = fs.readFileSync(prepared.methodologyPath, 'utf8');
    expect(methodology).toContain('sections/review-sections.md');
    expect(methodology).toContain('## Review Sections');

    const autoplanDir = skillDir(codex, renders.all, 'autoplan');
    const ceoPhase = fs.readFileSync(path.join(autoplanDir, 'sections', 'ceo-phase.md'), 'utf8');
    expect(ceoPhase).toContain('`sections/phase-close.md` relative to the installed `gstack-autoplan` SKILL.md directory');
    expect(ceoPhase).not.toContain('$GSTACK_ROOT/.agents/skills/gstack-autoplan/sections/phase-close.md');
    const closePath = path.join(autoplanDir, 'sections', 'phase-close.md');
    expect(fs.existsSync(closePath)).toBe(true);
    const close = fs.readFileSync(closePath, 'utf8').replace(/\s+/g, ' ');
    const closeStages = [
      '1. **Finish and save the review.**', '2. **Reconcile accepted requirements.**',
      "3. **Prepare this phase's close packet.**", '4. **Read the complete current packet.**',
      '5. **Verify the current implementation.**', '6. **Publish the parent report.**',
      '7. **Return to the driver.**',
    ];
    const positions = closeStages.map(stage => close.indexOf(stage));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(close).toContain('exact `offset` and `limit`');
    expect(close).toContain('through EOF');
    expect(close).toContain('Recheck step 1');
    expect(close).toContain('keep this phase open');
    expect(close).toContain('SEND the filled report below now');
    expect(close).toContain('in the same turn');
  });
});

describe('C4: UTF-8 byte gate (every host, every Codex model overlay)', () => {
  test(`no generated SKILL.md exceeds ${SKILL_BYTE_CEILING} bytes`, () => {
    const over: string[] = [];
    let checked = 0;
    for (const [name, out] of Object.entries(renders)) {
      for (const file of skillFiles(out)) {
        checked++;
        const bytes = fs.statSync(file).size;
        if (bytes > SKILL_BYTE_CEILING) over.push(`${name}: ${path.relative(out, file)} is ${bytes} bytes`);
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(over).toEqual([]);
  });

  test('the generator fails an oversized render in repo mode and only warns under --install-root', () => {
    const fixture = path.join(tmp, 'oversized');
    fs.mkdirSync(fixture);
    for (const entry of fs.readdirSync(ROOT)) {
      if (['scripts', 'retro', '.git'].includes(entry)) continue;
      fs.symlinkSync(path.join(ROOT, entry), path.join(fixture, entry));
    }
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(fixture, 'scripts'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'retro'), path.join(fixture, 'retro'), { recursive: true });
    const tmpl = path.join(fixture, 'retro', 'SKILL.md.tmpl');
    fs.appendFileSync(tmpl, `\n${`${'Padding for the oversized-render fixture. '.repeat(20)}\n`.repeat(250)}`);
    const gen = (...args: string[]) => spawnSync(process.execPath, ['scripts/gen-skill-docs.ts', '--host', 'codex', ...args],
      { cwd: fixture, encoding: 'utf8', timeout: 60_000 });
    const repo = gen('--out-dir', path.join(fixture, 'out-repo'));
    expect(repo.status).toBe(1);
    expect(repo.stderr).toMatch(/codex\/gstack-retro\/SKILL\.md is \d+ bytes, over the 160,000-byte limit\. Fix: carve sections with usesLazySections\(\) for this skill\./);
    const install = gen('--out-dir', path.join(fixture, 'out-install'), '--install-root', '/opt/gstack');
    expect(install.status, install.stderr).toBe(0);
    expect(install.stderr).toContain('over the 160,000-byte limit');
    expect(fs.existsSync(path.join(fixture, 'out-install', '.agents', 'skills', 'gstack-retro', 'SKILL.md'))).toBe(true);
  });
});
