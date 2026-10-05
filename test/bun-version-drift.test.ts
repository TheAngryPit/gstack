/**
 * A shared Bun baseline across CI surfaces, with an explicit fork Windows pin.
 *
 * The drift class this pins: Dockerfile.ci's comment records that the old
 * `| BUN_VERSION=x.y.z bash` form silently installed latest on every image
 * rebuild (observed 1.3.13/1.3.14 drift vs the 1.3.10 devs ran locally),
 * and before 2026-08-29 the lanes disagreed four ways (1.3.13 / latest /
 * unpinned / 1.3.10). Different Bun versions change test-runner OUTPUT
 * SHAPES the strict classifiers regex-match, spawn semantics, and shell
 * parsing — a lane on a different Bun is testing a different product.
 *
 * Bumping Bun: change every stable surface in one commit and keep the fork
 * Windows exception explicit; this test names and validates each one.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

interface Pin {
  surface: string;
  versions: string[];
  policy: 'stable' | 'official-fork-conditional' | 'unparsed';
  raw: string;
}

const FORK_WINDOWS_VERSION = '1.4.2';

function collectPins(): Pin[] {
  const pins: Pin[] = [];

  for (const name of fs.readdirSync(WORKFLOWS_DIR).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const source = fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf-8');
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/uses:\s*oven-sh\/setup-bun@/.test(lines[i])) continue;
      // A pinned stanza is `with:` + `bun-version: <v>` within the next few
      // lines; an unpinned setup-bun is itself drift (installs latest).
      const window = lines.slice(i + 1, i + 4).join('\n');
      const m = window.match(/bun-version:\s*([^\r\n]+)/);
      const raw = m?.[1].trim() ?? '';
      const stable = raw.match(/^["']?(\d+\.\d+\.\d+)["']?$/);
      const conditional = raw.match(/^\$\{\{\s*github\.repository\s*==\s*'garrytan\/gstack'\s*&&\s*'(\d+\.\d+\.\d+)'\s*\|\|\s*'(\d+\.\d+\.\d+)'\s*\}\}$/);
      pins.push({
        surface: `${name}:${i + 1}`,
        versions: stable ? [stable[1]] : conditional ? [conditional[1], conditional[2]] : [],
        policy: stable ? 'stable' : conditional ? 'official-fork-conditional' : 'unparsed',
        raw: raw || '<unpinned setup-bun — installs latest>',
      });
    }
  }

  const dockerfile = fs.readFileSync(
    path.join(ROOT, '.github', 'docker', 'Dockerfile.ci'), 'utf-8');
  const dockerPin = dockerfile.match(/^ARG BUN_VERSION=["']?([\w.]+)["']?$/m);
  pins.push({
    surface: 'Dockerfile.ci',
    versions: dockerPin ? [dockerPin[1]] : [],
    policy: dockerPin ? 'stable' : 'unparsed',
    raw: dockerPin?.[1] ?? '<no ARG BUN_VERSION=X.Y.Z>',
  });

  const gitlab = fs.readFileSync(path.join(ROOT, '.gitlab-ci.yml'), 'utf-8');
  const gitlabPin = gitlab.match(/BUN_VERSION:\s*["']?([\w.]+)["']?/);
  pins.push({
    surface: '.gitlab-ci.yml',
    versions: gitlabPin ? [gitlabPin[1]] : [],
    policy: gitlabPin ? 'stable' : 'unparsed',
    raw: gitlabPin?.[1] ?? '<no BUN_VERSION>',
  });

  return pins;
}

describe('bun version pins', () => {
  test('every CI surface uses the shared pin or explicit fork Windows policy', () => {
    const pins = collectPins();
    // Sanity: the scan found the known surfaces (a regex rot that finds
    // nothing must fail loudly, not vacuously pass).
    expect(pins.length).toBeGreaterThanOrEqual(6);

    const detail = pins.map((p) => `${p.surface} → ${p.raw}`).join('\n');
    const stablePins = pins.filter((p) => p.policy === 'stable');
    const stableVersions = [...new Set(stablePins.flatMap((p) => p.versions))];
    expect(stableVersions, `bun version drift across stable CI surfaces:\n${detail}`).toHaveLength(1);
    expect(stableVersions[0]).toMatch(/^\d+\.\d+\.\d+$/);

    const forkWindowsPins = pins.filter((p) => p.policy === 'official-fork-conditional');
    expect(forkWindowsPins).toHaveLength(4);
    expect(forkWindowsPins.every((p) => p.surface.startsWith('windows-free-tests.yml:'))).toBe(true);
    for (const pin of forkWindowsPins) {
      expect(pin.versions, `${pin.surface} must select the shared version or the fork Windows version:\n${detail}`)
        .toEqual([stableVersions[0], FORK_WINDOWS_VERSION]);
    }

    expect(pins.filter((p) => p.policy === 'unparsed').map((p) => `${p.surface} → ${p.raw}`)).toEqual([]);
  });

  test('every CI surface requires Bun 1.4.0 or newer for safe extra-stdio ownership', () => {
    // Matching pins alone would allow every lane to regress together. Older
    // Linux Bun releases double-close extra stdio FDs during subprocess GC,
    // which can close unrelated listeners after the OS reuses an FD number.
    // https://github.com/oven-sh/bun/issues/34785#issuecomment-5020318035
    for (const pin of collectPins()) {
      expect(pin.versions.length, `${pin.surface} must use a recognized stable or conditional pin (${pin.raw})`).toBeGreaterThan(0);
      for (const version of pin.versions) {
        expect(version, `${pin.surface} must pin a stable numeric version`).toMatch(/^\d+\.\d+\.\d+$/);
        expect(
          Bun.semver.satisfies(version, '>=1.4.0'),
          `${pin.surface} pins Bun ${version}; Bun >=1.4.0 is required for safe extra-stdio ownership`,
        ).toBe(true);
      }
    }
  });
});
