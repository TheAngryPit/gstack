import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// D2: census 37195203538 refused plan-ceo-review-format-approach twice
// (reasoning_extraction, "duplicating model outputs") on its session prompt.
// GSTA-96: the mode menu refused at the same capture Write twice in three trials.
const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-format.test.ts'), 'utf8');
const instruction = /function approachQuestionInstruction\(outFile: string\): string \{\n\s*return `([^`]+)`;/.exec(source)?.[1] ?? '';

for (const caseId of ['plan-ceo-review-format-approach', 'plan-ceo-review-format-mode']) {
  test(`${caseId} delivers its question without output-harvesting wording`, () => {
    const start = source.indexOf(`testConcurrentIfSelected('${caseId}'`);
    const block = source.slice(start, source.indexOf('validate:', start));
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('${approachQuestionInstruction(outFile)}');
    expect(block).not.toContain('captureInstruction(');
    const prompt = block + instruction;
    for (const phrase of [/verbatim/i, /paraphrase/i, /exact prose/i, /format-capture/i]) expect(prompt).not.toMatch(phrase);
    expect(instruction).toContain('${outFile}');
    expect(instruction).toContain('do not call any tool to ask the user');
    expect(instruction).toContain('every option, and the Recommendation line');
  });
}
