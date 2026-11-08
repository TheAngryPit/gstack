/**
 * bin/gstack-host-renders.sh: the WEAK proof that an agents/openai.yaml is the
 * generator's own render, now that a template's codex_default_prompt: makes
 * the default_prompt line vary per skill (it used to be one fixed sentence).
 *
 * Value: protects=_gstack_hr_generated accepts the generator's openai.yaml for any default_prompt and still rejects a foreign or edited one; fails_when=the shape check reverts to the generic-prompt literal, or drops display_name/policy/6-line limits; why_new=host-renders-prune asserts one backed-up line; no test exercises the rejected shapes; seam=none; no_claim=what the prune does after the proof
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateOpenAIYaml } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin/gstack-host-renders.sh');

describe.skipIf(process.platform === 'win32')('_gstack_hr_generated proves an openai.yaml by shape, not by its prompt sentence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-openai-yaml-proof-'));
  const tree = path.join(dir, '.agents');
  const real = path.join(dir, 'checkout');
  fs.mkdirSync(real, { recursive: true });

  function proven(rel: string, content: string): boolean {
    const file = path.join(tree, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const r = spawnSync('bash', ['-c', `. "${HELPER}"\n_gstack_hr_generated "${file}" "${tree}" "${real}" && echo proven || echo kept`], {
      encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.tmpdir() },
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim() === 'proven';
  }

  const custom = generateOpenAIYaml('gstack-ship', 'short', 'Use $gstack-ship to take this branch to a pull request: "quoted", colons: too.');
  const generic = generateOpenAIYaml('gstack-careful', 'short');

  test('the generator\'s render is proven whether the prompt is the skill\'s own sentence or the fallback', () => {
    expect(custom).not.toContain('Use gstack-ship for this task.');
    expect(proven('skills/gstack-ship/agents/openai.yaml', custom)).toBe(true);
    expect(generic).toContain('default_prompt: "Use gstack-careful for this task."');
    expect(proven('skills/gstack-careful/agents/openai.yaml', generic)).toBe(true);
  });

  test('a file that is not the generator\'s shape for that skill directory is kept, not backed up', () => {
    expect(proven('skills/gstack-qa/agents/openai.yaml', custom), 'display_name names another skill').toBe(false);
    expect(proven('skills/gstack-ship/agents/openai.yaml', custom.replace('policy:\n', 'rules:\n')), 'no policy: block').toBe(false);
    expect(proven('skills/gstack-ship/agents/openai.yaml', custom.replace('  default_prompt: "', '  default_prompt: \'')), 'prompt not double-quoted').toBe(false);
    expect(proven('skills/gstack-ship/agents/openai.yaml', custom + '  my_note: hand-written\n'), 'a seventh line').toBe(false);
    expect(proven('skills/gstack-ship/agents/openai.yaml', 'notes:\n' + custom.slice('interface:\n'.length)), 'first line is not interface:').toBe(false);
    expect(proven('skills/gstack-ship/openai.yaml', custom), 'not under agents/').toBe(false);
  });
});
