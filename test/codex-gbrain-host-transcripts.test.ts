import { expect, test } from 'bun:test';
import { RESOLVERS } from '../scripts/resolvers';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const context: TemplateContext = {
  skillName: 'setup-gbrain',
  tmplPath: 'setup-gbrain/SKILL.md.tmpl',
  host: 'codex',
  paths: HOST_PATHS.codex,
};

test('Codex transcript guidance uses accepted consent values, not collector flags', () => {
  const output = RESOLVERS.GBRAIN_HOST_TRANSCRIPTS(context);

  expect(output).toContain('`off`, `recent`, `all`, or `new@<YYYY-MM-DDTHH:MM:SSZ>`');
  expect(output).toContain('`recent+repos`, `all+repos`, or `new@<YYYY-MM-DDTHH:MM:SSZ>+repos`');
  expect(output).toContain('`--incremental` and `--bulk` are collector execution flags, not config values');
  expect(output).not.toMatch(/transcript_ingest_mode[^\n]*`(?:incremental|bulk)`/);
});
