/**
 * The render tier settled without a browser: a fake page runner hands lintRender every answer a browser could give
 * (nothing, null, malformed JSON, a probe error, a warn on a blocking rule, a polish tell, a thrown page script,
 * a pixel pass that cannot be read) and lint() settles the result against the page's waivers. Every cell of the
 * state matrix the browser tests only reach with Chromium installed is pinned here on every lane.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RenderResult, RenderSpec } from '../lib/aside-render';
import { lint } from '../lib/design-lint/index';
import { lintRender, type Runner } from '../lib/design-lint/render';
import type { Finding } from '../lib/design-lint/report';
import { FLOOR_REFUSAL, OWN_RULE_REFUSAL } from '../lib/design-lint/waivers';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const PAGE = (lead = '') => lead + '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ledger</title><meta name="description" content="The ledger closes the month."><link rel="icon" href="data:,"><style>\n:root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --font-display: "Literata", serif; --font-body: "Source Serif 4", serif; }\nhtml, body { overflow-x: clip; }\na:focus-visible { outline: 2px solid var(--color-ink); }\na:active { opacity: .9; }\n</style></head><body><a href="#main">Skip to content</a><main id="main"><h1>The ledger</h1><p>The ledger closes the month with a hairline rule under every total.</p></main></body></html>';

function tmpPage(html: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-settle-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return { dir, file };
}

/** Step indices of one measuring pass: 0 installs the probes, 1 is setup, 2..13 the twelve measures (13 is the focus walk). */
const SETUP = 1, FIRST = 2, FOCUS = 13;

type Patch = (evals: Record<number, string>, spec: RenderSpec) => void;

/** A runner whose page answers every measure with nothing to report, then lets a test rewrite the answers; a pixel pass (the spec with a screenshot step) answers through the same patch. */
function runner(patch: Patch = () => {}, stdout = ''): Runner & { specs: RenderSpec[] } {
  const specs: RenderSpec[] = [];
  const run = (async (spec: RenderSpec): Promise<RenderResult> => {
    specs.push(spec);
    const evals: Record<number, string> = { [SETUP]: '{"lost":[]}' };
    for (let i = FIRST; i <= FOCUS; i++) evals[i] = '[]';
    patch(evals, spec);
    return { ok: true, engine: 'browse', outputs: [], evals, stdout };
  }) as Runner & { specs: RenderSpec[] };
  run.specs = specs;
  return run;
}

const renders = (f: Finding[]) => f.filter((x) => x.rule === 'render').map((x) => [x.grade, x.evidence]);
const byRule = (f: Finding[], rule: string) => f.filter((x) => x.rule === rule);

describe('design-lint render settled without a browser: what the page hands back', () => {
  test('a clean page measured by a quiet runner has no finding and status ran', async () => {
    const { dir, file } = tmpPage(PAGE());
    const r = await lintRender([file], { cwd: dir, run: runner() });
    expect(r.status).toBe('ran');
    expect(r.findings).toEqual([]);
  });

  test('a measure that came back missing, null, malformed or as a probe error is one blocking render finding naming the probe and the width', async () => {
    const { dir, file } = tmpPage(PAGE());
    const cases: Array<[string | undefined, RegExp]> = [
      [undefined, /^the layout measurement at 320px failed: no result came back$/],
      ['null', /^the layout measurement at 320px failed: empty result$/],
      ['abc', /^the layout measurement at 320px failed: .*JSON/],
      ['{"error":"probe lost the document"}', /^the layout measurement at 320px failed: probe lost the document$/],
    ];
    for (const [answer, want] of cases) {
      const r = await lintRender([file], { cwd: dir, run: runner((ev) => { if (answer === undefined) delete ev[FIRST]; else ev[FIRST] = answer; }) });
      expect(renders(r.findings)).toHaveLength(1);
      expect(renders(r.findings)[0][0]).toBe('blocks');
      expect(renders(r.findings)[0][1]).toMatch(want);
    }
  });

  test('a setup that failed blocks; fonts that did not load are suspected, so the finding sits at ask', async () => {
    const { dir, file } = tmpPage(PAGE());
    const failed = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[SETUP] = '{"error":"no document"}'; }) });
    expect(renders(failed.findings)).toEqual([['blocks', 'the page could not be prepared for measurement: no document']]);
    const lost = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[SETUP] = '{"lost":["Literata","/css/site.css"]}'; }) });
    expect(renders(lost.findings)).toEqual([['ask', 'fonts or stylesheets did not load (Literata, /css/site.css): the measurements show a fallback face']]);
  });

  test('a page script that threw on load is a blocking render finding carrying the first 90 characters of its message', async () => {
    const { dir, file } = tmpPage(PAGE());
    const r = await lintRender([file], { cwd: dir, run: runner(() => {}, 'PAGE_ERRORS=["uncaught: Error: boom at line 3"]\n') });
    expect(renders(r.findings)).toEqual([['blocks', 'a script threw on load: Error: boom at line 3']]);
    const long = await lintRender([file], { cwd: dir, run: runner(() => {}, 'PAGE_ERRORS=' + JSON.stringify(['uncaught: ' + 'x'.repeat(200)]) + '\n') });
    expect(renders(long.findings)[0][1]).toBe('a script threw on load: ' + 'x'.repeat(90));
  });

  test('a page that did not render, and a runner that threw, each land as one blocking render finding', async () => {
    const { dir, file } = tmpPage(PAGE());
    const dead = await lintRender([file], { cwd: dir, run: async () => ({ ok: false, outputs: [], evals: {}, stdout: '', error: 'browser gone' }) });
    expect(renders(dead.findings)).toEqual([['blocks', 'the page did not render: browser gone']]);
    const threw = await lintRender([file], { cwd: dir, run: async () => { throw new Error('socket closed'); } });
    expect(renders(threw.findings)).toEqual([['blocks', 'the page could not be measured: socket closed']]);
  });

  test('a warn on a blocking rule lands at ask with source render; a fail lands at blocks; a rule the lint does not know is tampering', async () => {
    const { dir, file } = tmpPage(PAGE());
    const r = await lintRender([file], { cwd: dir, run: runner((ev) => {
      ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'warn', evidence: 'the hero may overflow' }, { rule: 'horizontal-scroll', grade: 'fail', evidence: 'the hero overflows' }]);
      ev[FIRST + 1] = JSON.stringify([{ rule: 'nope', grade: 'fail', evidence: 'x' }, { rule: 'horizontal-scroll', grade: 'maybe', evidence: 'y' }]);
    }) });
    expect(byRule(r.findings, 'horizontal-scroll').map((f) => [f.grade, f.source, f.evidence])).toEqual([['blocks', 'render', '[320px] the hero overflows']]);
    const warns = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'warn', evidence: 'the hero may overflow' }]); }) });
    expect(byRule(warns.findings, 'horizontal-scroll').map((f) => [f.grade, f.source, f.evidence])).toEqual([['ask', 'render', '[320px] the hero may overflow']]);
    expect(renders(r.findings).map(([g, e]) => [g, e.replace(/\(.*?\)/, '(…)').replace(/with the pr.*$/, 'with the probes')])).toEqual([
      ['blocks', 'the page handed back a measurement the lint does not know (…); its scripts may be tampering with the probes'],
      ['blocks', 'the page handed back a measurement the lint does not know (…); its scripts may be tampering with the probes'],
    ]);
    expect(renders(r.findings).map(([, e]) => /\((.*?)\)/.exec(e)![1])).toEqual(['nope', 'horizontal-scroll']);
  });

  test('a contrast claim whose pixel pass cannot be read keeps its computed ratio', async () => {
    const { dir, file } = tmpPage(PAGE());
    const claim = { rule: 'low-contrast', grade: 'fail', evidence: 'computed contrast 2.50:1 under the 4.5:1 threshold on p.faint (2.50:1)', probe: { path: 'main>p', fg: [180, 180, 180], threshold: 4.5 } };
    for (const hide of ['{"error":"hide failed"}', 'null', undefined]) {
      const run = runner((ev, spec) => {
        if (spec.steps.some((s) => s.kind === 'screenshot')) { if (hide === undefined) delete ev[FIRST]; else ev[FIRST] = hide; return; }
        ev[FIRST + 5] = JSON.stringify([claim]);
      });
      const r = await lintRender([file], { cwd: dir, run });
      expect(run.specs).toHaveLength(2);
      expect(byRule(r.findings, 'low-contrast').map((f) => [f.grade, f.evidence])).toEqual([['blocks', '[1280px] computed contrast 2.50:1 under the 4.5:1 threshold on p.faint (2.50:1)']]);
    }
  });
});

describe('design-lint render settled without a browser: waivers through lint()', () => {
  test('a render warn on a blocking rule is suspected, so the page claim answers it: waived, no refusal', async () => {
    const { dir } = tmpPage(PAGE('<!-- gstack-lint-disable horizontal-scroll: the ledger table scrolls sideways on purpose under its month headers -->\n'));
    const r = await lint([dir], { cwd: dir, render: true, warn: () => {}, run: runner((ev) => { ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'warn', evidence: 'the table may overflow' }]); }) });
    expect(byRule(r.findings, 'waiver')).toEqual([]);
    expect(byRule(r.findings, 'horizontal-scroll').map((f) => [f.grade, f.file, f.source])).toEqual([['waived', 'index.html', 'render']]);
    expect(r.summary.waived).toBe(1);
    expect(r.exitCode).toBe(0);
  });

  test('without the render tier nothing suspects the rule, so the same claim is refused as the Floor', async () => {
    const { dir } = tmpPage(PAGE('<!-- gstack-lint-disable horizontal-scroll: the ledger table scrolls sideways on purpose under its month headers -->\n'));
    const r = await lint([dir], { cwd: dir, warn: () => {} });
    expect(byRule(r.findings, 'waiver').map((f) => f.evidence)).toEqual([`waiver on horizontal-scroll refused: ${FLOOR_REFUSAL}`]);
    expect(byRule(r.findings, 'horizontal-scroll')).toEqual([]);
  });

  test('a short claim on a suspected rule is refused for its length, not as the Floor, and the render warn stays at ask', async () => {
    const { dir } = tmpPage(PAGE('<!-- gstack-lint-disable horizontal-scroll: table scrolls -->\n'));
    const r = await lint([dir], { cwd: dir, render: true, warn: () => {}, run: runner((ev) => { ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'warn', evidence: 'the table may overflow' }]); }) });
    expect(byRule(r.findings, 'waiver').map((f) => f.evidence)).toEqual(['waiver on horizontal-scroll refused: reason under 24 characters']);
    expect(byRule(r.findings, 'horizontal-scroll').map((f) => f.grade)).toEqual(['ask']);
    expect(r.exitCode).toBe(1);
  });

  test('a measured blocking render finding stays at blocks and a claim on the lint\'s own render rule is refused by name', async () => {
    const { dir } = tmpPage(PAGE('<!-- gstack-lint-disable render: the ledger page is measured by hand each month end -->\n<!-- gstack-lint-disable horizontal-scroll: the ledger table scrolls sideways on purpose under its month headers -->\n'));
    const r = await lint([dir], { cwd: dir, render: true, warn: () => {}, run: runner((ev) => { ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'fail', evidence: 'the table overflows' }]); ev[FIRST + 1] = JSON.stringify([{ rule: 'nope', grade: 'fail', evidence: 'x' }]); }) });
    expect(byRule(r.findings, 'waiver').map((f) => f.evidence).sort()).toEqual([`waiver on horizontal-scroll refused: ${FLOOR_REFUSAL}`, `waiver on render refused: ${OWN_RULE_REFUSAL}`]);
    expect(byRule(r.findings, 'horizontal-scroll').map((f) => f.grade)).toEqual(['blocks']);
    expect(renders(r.findings).map(([g]) => g)).toEqual(['blocks']);
    expect(r.summary.waived).toBe(0);
    expect(r.exitCode).toBe(2);
  });

  test('a polish render tell is settled by the page claim at waived', async () => {
    const { dir } = tmpPage(PAGE('<!-- gstack-lint-disable text-sliver: the ledger margin column is a sliver by design of the paper form -->\n'));
    const r = await lint([dir], { cwd: dir, render: true, warn: () => {}, run: runner((ev) => { ev[FIRST + 7] = JSON.stringify([{ rule: 'text-sliver', grade: 'fail', evidence: 'a 90px column' }]); }) });
    expect(byRule(r.findings, 'waiver')).toEqual([]);
    expect(byRule(r.findings, 'text-sliver').map((f) => [f.grade, f.source])).toEqual([['waived', 'render']]);
    expect(r.summary.polish).toBe(0);
    expect(r.summary.waived).toBe(1);
  });

  test('render findings of a URL target pass through unsettled, and a page with a whitespace run in its name still meets its own findings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-settle-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'my  page.html'), PAGE('<!-- gstack-lint-disable horizontal-scroll: the ledger table scrolls sideways on purpose under its month headers -->\n'));
    const r = await lint([dir], { cwd: dir, render: true, urls: ['http://127.0.0.1:1/x'], warn: () => {}, run: runner((ev) => { ev[FIRST] = JSON.stringify([{ rule: 'horizontal-scroll', grade: 'warn', evidence: 'the table may overflow' }]); }) });
    expect(byRule(r.findings, 'horizontal-scroll').map((f) => [f.grade, f.file])).toEqual([['waived', 'my page.html']]);
    expect(renders(r.findings).map(([g, e]) => [g, e.startsWith('could not reach http://127.0.0.1:1/x')])).toEqual([['blocks', true]]);
    expect(byRule(r.findings, 'render')[0].file).toBe('http://127.0.0.1:1/x');
  });
});
