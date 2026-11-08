import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { parseNDJSON } from './helpers/session-runner';
import { fragmentRestoreVerdict } from './helpers/context-restore-fragment';

const MARKERS = { restored: 'FRAGMATCH_PAYMENTS_BUILD', others: ['FRAGMATCH_ALPHA_BUILD', 'FRAGMATCH_OMEGA_BUILD'] };
const BODIES: Record<string, string> = {
  '20260101-120000-alpha-feature.md': 'branch: feat/alpha\n## Working on: alpha feature\n### Summary\nAlpha content FRAGMATCH_ALPHA_BUILD\n',
  '20260202-120000-middle-payments.md': 'branch: feat/payments\n## Working on: middle payments\n### Summary\nPayments content FRAGMATCH_PAYMENTS_BUILD\n',
  '20260303-120000-omega-release.md': 'branch: feat/omega\n## Working on: omega release\n### Summary\nOmega content FRAGMATCH_OMEGA_BUILD\n',
};
const ALL_FILES = Object.keys(BODIES);

const captures: { sessions: Array<{ session_id: string; ndjson: string[] }> } = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'context-restore-fragment-match-captures.json'), 'utf8'),
);

function replay(lines: string[]) {
  const parsed = parseNDJSON(lines);
  return { ...parsed, output: parsed.resultLine?.result || '' };
}

function toolOutput(run: ReturnType<typeof replay>): string {
  return run.toolCalls.map((call) => call.output).join('\n');
}

function isReportLine(line: string): boolean {
  const event = JSON.parse(line);
  return event.type === 'result'
    || (event.type === 'assistant' && event.message.content.some((block: any) => block.type === 'text'));
}

function rewriteReport(lines: string[], rewrite: (line: string) => string): string[] {
  return lines.map((line) => (isReportLine(line) ? rewrite(line) : line));
}

function synthetic(files: string[], report: string): string[] {
  const lines: string[] = [
    JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'skill', name: 'Skill', input: { skill: 'context-restore', args: 'payments' } }] } }),
    JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'skill', content: 'Launching skill: context-restore' }] } }),
  ];
  files.forEach((file, i) => {
    lines.push(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `read-${i}`, name: 'Read', input: { file_path: `.gstack-home/projects/p/checkpoints/${file}` } }] } }));
    lines.push(JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: `read-${i}`, content: BODIES[file] }] } }));
  });
  if (report) {
    lines.push(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: report }] } }));
  }
  lines.push(JSON.stringify({ type: 'result', subtype: report ? 'success' : 'error_max_turns', result: report }));
  return lines;
}

function resumeReport(file: string, ...summaries: string[]): string {
  return `I loaded \`${file}\`.\n\nRESUMING CONTEXT\n### Summary\n${summaries.join('\n')}\n`;
}

describe('context-restore-fragment-match verdict', () => {
  test('captured runs hold three sessions that each printed another checkpoint body', () => {
    expect(captures.sessions).toHaveLength(3);
    for (const session of captures.sessions) {
      const run = replay(session.ndjson);
      expect(run.toolCalls.map((call) => call.tool)).toContain('Skill');
      expect(toolOutput(run)).toContain('FRAGMATCH_PAYMENTS_BUILD');
      expect(MARKERS.others.some((marker) => toolOutput(run).includes(marker))).toBe(true);
    }
  });

  test.each(captures.sessions.map((s) => [s.session_id, s.ndjson] as const))(
    'captured run %s: inspected every checkpoint, restored payments -> pass',
    (_id, ndjson) => {
      expect(fragmentRestoreVerdict(replay(ndjson), MARKERS)).toEqual({ loadedTarget: true, didNotLoadOthers: true });
    },
  );

  test('synthetic: prints every checkpoint, reports payments -> pass', () => {
    const run = replay(synthetic(ALL_FILES, resumeReport(ALL_FILES[1], 'Payments content FRAGMATCH_PAYMENTS_BUILD')));
    expect(fragmentRestoreVerdict(run, MARKERS)).toEqual({ loadedTarget: true, didNotLoadOthers: true });
  });

  test.each([
    ['alpha', 'FRAGMATCH_ALPHA_BUILD'],
    ['omega', 'FRAGMATCH_OMEGA_BUILD'],
  ])('captured run rewritten to resume %s -> fail', (_name, marker) => {
    for (const session of captures.sessions) {
      const run = replay(rewriteReport(session.ndjson, (line) => line.replaceAll('FRAGMATCH_PAYMENTS_BUILD', marker)));
      expect(toolOutput(run)).toContain('FRAGMATCH_PAYMENTS_BUILD');
      expect(fragmentRestoreVerdict(run, MARKERS)).toEqual({ loadedTarget: false, didNotLoadOthers: false });
    }
  });

  test.each([
    ['alpha', ALL_FILES[0], 'Alpha content FRAGMATCH_ALPHA_BUILD'],
    ['omega', ALL_FILES[2], 'Omega content FRAGMATCH_OMEGA_BUILD'],
  ])('synthetic: reads only %s and resumes it -> fail', (_name, file, summary) => {
    const run = replay(synthetic([file], resumeReport(file, summary)));
    expect(fragmentRestoreVerdict(run, MARKERS)).toEqual({ loadedTarget: false, didNotLoadOthers: false });
  });

  test('captured run with omega content mixed into the resume summary -> fail', () => {
    for (const session of captures.sessions) {
      const mixed = rewriteReport(session.ndjson, (line) => line.replaceAll(
        'Payments content FRAGMATCH_PAYMENTS_BUILD', 'Payments content FRAGMATCH_PAYMENTS_BUILD\\nOmega content FRAGMATCH_OMEGA_BUILD'));
      expect(fragmentRestoreVerdict(replay(mixed), MARKERS)).toEqual({ loadedTarget: true, didNotLoadOthers: false });
    }
  });

  test('synthetic: resume summary mixes alpha and payments -> fail', () => {
    const run = replay(synthetic(ALL_FILES, resumeReport(ALL_FILES[1],
      'Payments content FRAGMATCH_PAYMENTS_BUILD', 'Alpha content FRAGMATCH_ALPHA_BUILD')));
    expect(fragmentRestoreVerdict(run, MARKERS)).toEqual({ loadedTarget: true, didNotLoadOthers: false });
  });

  test('payments body only in tool output, no report of it -> fail', () => {
    const noReport = replay(synthetic([ALL_FILES[1]], ''));
    expect(toolOutput(noReport)).toContain('FRAGMATCH_PAYMENTS_BUILD');
    expect(fragmentRestoreVerdict(noReport, MARKERS).loadedTarget).toBe(false);
    const nameOnly = replay(synthetic(ALL_FILES, `I loaded \`${ALL_FILES[1]}\`.`));
    expect(fragmentRestoreVerdict(nameOnly, MARKERS).loadedTarget).toBe(false);
  });
});
