import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { generateQAMethodology } from '../scripts/resolvers/utility';
import { HOST_PATHS } from '../scripts/resolvers/types';

const methodology = generateQAMethodology({
  skillName: 'qa', tmplPath: '', host: 'claude', paths: HOST_PATHS.claude,
});
const rubric = methodology.split('## Health Score Rubric')[1].split('## Framework-Specific Guidance')[0];

describe('QA health rubric scoring contract', () => {
  test('console bands have no overlapping boundary at ten errors', () => {
    expect(rubric).toContain('4-10 errors');
    expect(rubric).toContain('11+ errors');
    expect(rubric).not.toContain('10+ errors');
    expect(rubric).toContain('Exclude warnings');
  });

  test('defines severity, categories, and duplicate handling', () => {
    for (const severity of ['Critical', 'High', 'Medium', 'Low']) {
      expect(rubric).toContain(`**${severity}:**`);
    }
    expect(rubric).toContain('one primary category');
    expect(rubric).toContain('same root cause');
    expect(rubric).toContain('client-side routes');
  });

  test('defines partial coverage and weighted rounding', () => {
    expect(rubric).toContain('untested');
    expect(rubric).toContain('provisional');
    expect(rubric).toContain('15% = 0.15');
    expect(rubric).toContain('Round only the final score');
  });
});

const healthTmpl = fs.readFileSync(path.join(import.meta.dir, '..', 'health', 'SKILL.md.tmpl'), 'utf-8');
const gbrainSection = healthTmpl.split('**GBrain sub-score computation:**')[1] ?? '';
const gbrainScript = gbrainSection.match(/```bash\nbun --no-env-file --config=\/dev\/null -e '\n([\s\S]*?)\n'\n```/)?.[1] ?? '';

function gbrainScore(doctor: number | null, queue: number | null, pushHours: number | null): string {
  const script = gbrainScript
    .replace('<N|null>', String(doctor))
    .replace('<N|null>', String(queue))
    .replace('<N|null>', String(pushHours));
  const run = spawnSync(process.execPath, [...bunIsolationArgs(), '-e', script], { encoding: 'utf-8', timeout: 30_000 });
  expect(run.status).toBe(0);
  return run.stdout.trim();
}

describe('/health GBrain score has one rule, computed in code (#3351)', () => {
  test('the rubric row defers to the computation instead of scoring bands', () => {
    const row = healthTmpl.split('\n').find(line => line.startsWith('| GBrain |')) ?? '';
    expect(row).toContain('GBrain sub-score computation');
    expect(row).not.toMatch(/queue\s*</);
    expect(row).not.toContain('doctor=');
  });

  test('the issue inputs score by the formula, not the rubric column', () => {
    expect(gbrainScript).not.toBe('');
    expect(gbrainScore(10, 50, 2)).toBe('GBRAIN_SCORE: 9.1');
    expect(gbrainScore(7, 3, 2)).toBe('GBRAIN_SCORE: 8.5');
  });

  test('bands are half-open at 10/100 queue lines and 24/72 hours', () => {
    expect(gbrainScore(10, 9, 23.9)).toBe('GBRAIN_SCORE: 10.0');
    expect(gbrainScore(10, 10, 24)).toBe('GBRAIN_SCORE: 8.5');
    expect(gbrainScore(10, 99, 71.9)).toBe('GBRAIN_SCORE: 8.5');
    expect(gbrainScore(10, 100, 72)).toBe('GBRAIN_SCORE: 5.0');
    expect(gbrainScore(0, 100, 72)).toBe('GBRAIN_SCORE: 0.0');
    expect(gbrainScore(null, 0, 1)).toBe('GBRAIN_SCORE: 5.0');
  });

  test('sync off gives the doctor component the whole weight', () => {
    expect(gbrainScore(10, null, null)).toBe('GBRAIN_SCORE: 10.0');
    expect(gbrainScore(7, null, null)).toBe('GBRAIN_SCORE: 7.0');
    expect(gbrainScore(0, null, null)).toBe('GBRAIN_SCORE: 0.0');
  });
});
