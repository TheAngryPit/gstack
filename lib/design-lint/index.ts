/**
 * gstack's free design lint: the deterministic gates behind /design-html and
 * /design-review. The static tier reads HTML, CSS and component files and runs
 * in well under a second; the render tier (--render) measures the page in
 * gstack's own browser. One contract for both:
 *
 *   LINT: <blocks|ask|polish|waived> <rule-id> <file>:<line> <evidence> | fix: <fix>
 *   LINT_SUMMARY: blocks=N ask=N waived=N polish=N render=<ran|skipped: reason>
 *
 * Exit 2 when anything blocks, 1 when an ask is unanswered, 0 otherwise.
 * docs/design-lint.md is the user-facing contract.
 */
import { docKindOf } from './html';
import { lintRender, type RenderOptions } from './render';
import { exitCodeOf, finalize, formatFinding, formatSummary, oneLine, relPath, summarize, type Finding, type Summary } from './report';
import { lintStaticRaw, realDir, settleContext, type StaticOptions } from './static';

export interface LintOptions extends StaticOptions {
  render?: boolean;
  urls?: string[];
  /** Replaces the render engine choice (tests inject one). */
  engine?: RenderOptions['engine'];
  /** Replaces the render page runner (tests inject one). */
  run?: RenderOptions['run'];
}

export interface LintResult {
  files: string[];
  findings: Finding[];
  summary: Summary;
  exitCode: 0 | 1 | 2;
}

/**
 * Both tiers, then the page's waivers once over both: a waiver on a blocking
 * rule that only the render tier suspects is honoured, and one the render tier
 * measures for real is refused, because the page's findings are settled after
 * every measurement is in.
 */
export async function lint(paths: string[], opts: LintOptions = {}): Promise<LintResult> {
  const cwd = realDir(opts.cwd ?? process.cwd());
  const stat = lintStaticRaw(paths, opts);
  let render = 'skipped: not requested';
  const byPage = new Map<string, Finding[]>();
  if (opts.render || opts.urls?.length) {
    const pages = stat.files.filter((f) => docKindOf(f) === 'html');
    const r = await lintRender([...pages, ...(opts.urls ?? [])], { cwd, scope: opts.scope, engine: opts.engine, run: opts.run });
    render = r.status;
    for (const f of r.findings) byPage.set(f.file, [...(byPage.get(f.file) ?? []), f]);
  }
  const findings: Finding[] = [];
  stat.contexts.forEach((ctx, i) => {
    const page = ctx.docs.length === 1 && ctx.docs[0].kind === 'html' ? oneLine(relPath(ctx.key, cwd)) : null;
    const measured = page ? byPage.get(page) ?? [] : [];
    if (page) byPage.delete(page);
    findings.push(...settleContext(ctx, [...stat.raw[i], ...measured], cwd));
  });
  for (const rest of byPage.values()) findings.push(...rest);
  findings.push(...stat.skipped);
  const final = finalize(findings);
  const summary = summarize(final, render);
  return { files: stat.files, findings: final, summary, exitCode: exitCodeOf(summary) };
}

export function formatResult(result: LintResult): string {
  return [...result.findings.map(formatFinding), formatSummary(result.summary)].join('\n');
}

export { formatFinding, formatSummary, type Finding, type Summary } from './report';
