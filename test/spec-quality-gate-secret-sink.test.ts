/** Exercise each host's generated redaction path before observable dispatch/sinks. */
import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { claimPrivateRequest, finishPrivateRequest, preparePrivateRequest } from '../lib/codex-request-file';

const ROOT = resolve(import.meta.dir, '..');
let output: string;

beforeAll(() => {
  output = mkdtempSync(join(tmpdir(), 'gstack-spec-gate-render-'));
  const rendered = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', output], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
  });
  if (rendered.exitCode !== 0) throw new Error(rendered.stderr.toString());
});
afterAll(() => { if (output) rmSync(output, { recursive: true, force: true }); });

function content(host: 'claude' | 'codex'): string {
  if (host === 'claude') return readFileSync(join(output, 'spec', 'sections', 'gate-and-file.md'), 'utf8');
  const skillDir = join(output, '.agents', 'skills', 'gstack-spec');
  return [
    readFileSync(join(skillDir, 'SKILL.md'), 'utf8'),
    readFileSync(join(skillDir, 'sections', 'gate-and-file.md'), 'utf8'),
  ].join('\n');
}

interface ScanResult {
  code: number;
  stdout: string;
  stderr: string;
  sinks: Array<{ name: string; body: string }>;
  pending: string[];
  printed?: string;
  disposition?: 'clean' | 'decision-required' | 'blocked' | 'scanner-failed';
  retired?: boolean;
  retainedPrivate?: boolean;
}

function runClaudeScan(body: string, scanner: 'real' | 'broken' | 'missing', errexit: boolean): ScanResult {
  const scratch = mkdtempSync(join(tmpdir(), 'gstack-spec-sink-'));
  const runtime = join(scratch, 'runtime');
  const bin = join(runtime, 'bin');
  const sinks = join(scratch, 'sinks');
  const temps = join(scratch, 'tmp');
  const systemTemps = join(scratch, 'system-tmp');
  const shims = join(scratch, 'shims');
  // C1: the env-var-host prelude honors an exported GSTACK_ROOT only when it has bin/ and lib/.
  for (const dir of [bin, join(runtime, 'lib'), sinks, temps, systemTemps, shims]) mkdirSync(dir, { recursive: true });
  const realMktemp = Bun.which('mktemp');
  if (!realMktemp) throw new Error('mktemp is required for the spec redaction fixture');
  writeFileSync(join(shims, 'mktemp'), `#!/usr/bin/env bash
if [ "$#" -eq 0 ]; then exec '${realMktemp}' '${systemTemps}/tmp.XXXXXXXX'; fi
exec '${realMktemp}' "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'gstack-config'), '#!/usr/bin/env bash\nprintf "public\\n"\n', { mode: 0o755 });
  if (scanner === 'real') symlinkSync(join(ROOT, 'bin/gstack-redact'), join(bin, 'gstack-redact'));
  if (scanner === 'broken') writeFileSync(join(bin, 'gstack-redact'), '#!/usr/bin/env bash\nexit 70\n', { mode: 0o755 });
  writeFileSync(join(bin, 'fake-reviewer'), '#!/usr/bin/env bash\ncat > "$SINK_DIR/reviewer-received.txt"\n', { mode: 0o755 });
  const full = content('claude');
  const start = full.indexOf('#### Redaction scan — pre-codex');
  if (start < 0) throw new Error('Missing pre-codex redaction in Claude spec');
  const match = full.slice(start).match(/```bash\n([\s\S]*?)\n```/);
  if (!match) throw new Error('Missing executable scan fence in Claude spec');
  const fence = match[1]
    .replaceAll('~/.claude/skills/gstack', runtime)
    .replaceAll('$HOME/.claude/skills/gstack', runtime)
    .replace('<the exact the spec body goes here>', body);
  if (fence.includes('<the exact')) throw new Error('Spec fixture bytes did not replace the scan placeholder');
  // Deliberately put sinks directly after the real fence. A missing executable
  // stop (the previous prose-only gate) sends/persists the secret and fails.
  const script = `${errexit ? 'set -e\n' : ''}${fence}\n"$GSTACK_BIN/fake-reviewer" < "$REDACT_FILE"
cat "$REDACT_FILE" > "$SINK_DIR/archive.md"
cat "$REDACT_FILE" > "$SINK_DIR/transcript.md"
rm -f "$REDACT_FILE"
`;
  try {
    const result = Bun.spawnSync(['bash', '-c', script], { cwd: scratch,
      env: { ...process.env, PATH: `${shims}${delimiter}${process.env.PATH ?? ''}`,
        GSTACK_ROOT: runtime, GSTACK_BIN: bin, SINK_DIR: sinks, TMPDIR: temps },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    const stdout = result.stdout.toString();
    const printed = /^REDACT_FILE: (.+)$/m.exec(stdout)?.[1];
    return { code: result.exitCode, stdout, stderr: result.stderr.toString(),
      sinks: readdirSync(sinks).map(name => ({ name, body: readFileSync(join(sinks, name), 'utf8') })),
      pending: [temps, systemTemps].flatMap(dir => readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf8'))),
      printed: printed && existsSync(printed) ? readFileSync(printed, 'utf8') : undefined };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function runCodexScan(body: string, scanner: 'real' | 'broken' | 'missing' = 'real'): ScanResult {
  const scratch = mkdtempSync(join(tmpdir(), 'gstack-codex-spec-sink-'));
  try {
    const sinks = join(scratch, 'sinks');
    const trash = join(scratch, 'trash');
    mkdirSync(sinks, { mode: 0o700 });
    mkdirSync(trash, { mode: 0o700 });

    const allocated = preparePrivateRequest({ tempRoot: scratch, filename: 'input.txt' });
    writeFileSync(allocated.path, Buffer.from(body), { flag: 'w' });
    const claimed = claimPrivateRequest(allocated.path, { tempRoot: scratch });
    const scannerPath = join(scratch, 'gstack-redact');
    if (scanner === 'real') symlinkSync(join(ROOT, 'bin/gstack-redact'), scannerPath);
    if (scanner === 'broken') writeFileSync(scannerPath, 'process.exit(70);\n', { mode: 0o600 });

    let rawCode = 1;
    let stdout = '';
    let stderr = '';
    try {
      const result = Bun.spawnSync([process.execPath, scannerPath, '--from-file', allocated.path,
        '--repo-visibility', 'private', '--json'], { cwd: scratch, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
      rawCode = result.exitCode;
      stdout = result.stdout.toString();
      stderr = result.stderr.toString();
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
    }

    let report: { counts?: { HIGH?: number; MEDIUM?: number; LOW?: number; WARN?: number }; findings?: unknown[] } | undefined;
    try { report = JSON.parse(stdout); } catch { /* Missing or malformed scanner output fails closed below. */ }
    const counts = report?.counts;
    const reportIsUsable = !!counts && ['HIGH', 'MEDIUM', 'LOW', 'WARN'].every(key => Number.isInteger(counts[key as keyof typeof counts]));
    const expectedCode = counts && counts.HIGH! > 0 ? 3 : counts && counts.MEDIUM! > 0 ? 2 : 0;
    const consistent = reportIsUsable && report?.findings !== undefined && rawCode === expectedCode;
    const code = consistent ? rawCode : 1;
    const disposition = code === 0 ? 'clean' : code === 2 ? 'decision-required' : code === 3 ? 'blocked' : 'scanner-failed';
    let retirement: ReturnType<typeof finishPrivateRequest> | undefined;

    // The generated Codex section is native tool guidance rather than a shell
    // fence. Exercise its file-based scanner contract directly: every result
    // other than a valid clean report stops before the synthetic downstream sinks.
    if (disposition === 'clean') {
      const bytesBeforeConsumption = readFileSync(allocated.path);
      const consumedHash = createHash('sha256').update(bytesBeforeConsumption).digest('hex');
      if (!bytesBeforeConsumption.equals(Buffer.from(body)) || claimed.hash !== consumedHash) {
        throw new Error('Codex fixture input changed between scan and consumption');
      }
      for (const name of ['reviewer-received.txt', 'archive.md', 'transcript.md']) {
        writeFileSync(join(sinks, name), bytesBeforeConsumption, { flag: 'wx', mode: 0o600 });
      }
      retirement = finishPrivateRequest(claimed, true, { tempRoot: scratch, trashRoot: trash });
      if (retirement.status === 'retired') {
        const retiredBody = readFileSync(join(retirement.path, 'input.txt'));
        if (!retiredBody.equals(bytesBeforeConsumption)) throw new Error('Retired Codex input differs from consumed bytes');
      }
    }

    return {
      code,
      disposition,
      stdout,
      stderr,
      sinks: readdirSync(sinks).map(name => ({ name, body: readFileSync(join(sinks, name), 'utf8') })),
      pending: existsSync(allocated.path) ? [readFileSync(allocated.path, 'utf8')] : [],
      retired: retirement?.status === 'retired',
      retainedPrivate: retirement?.status === 'retained_private' || disposition !== 'clean',
    };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function runScan(host: 'claude' | 'codex', body: string, scanner: 'real' | 'broken' | 'missing' = 'real', errexit = false) {
  return host === 'claude' ? runClaudeScan(body, scanner, errexit) : runCodexScan(body, scanner);
}

for (const host of ['claude', 'codex'] as const) {
  describe(`${host} /spec quality-gate secret sink`, () => {
    test('HIGH blocks reviewer dispatch and all downstream raw sinks, even without errexit', () => {
      const secret = ['AKIA', '1234567890ABCDEF'].join('');
      for (const errexit of [false, true]) {
        const result = runScan(host, `Deploy using ${secret}`, 'real', errexit);
        expect(result.code).toBe(3);
        expect(result.sinks).toEqual([]);
        expect(result.pending).toEqual(host === 'codex' ? [`Deploy using ${secret}`] : []);
        expect(result.stdout).not.toContain(secret);
        if (host === 'claude') expect(result.stderr).toContain('blocked');
        else expect(result.retainedPrivate).toBe(true);
      }
    });
    test('MEDIUM pauses dispatch pending its existing user disposition', () => {
      const body = 'Notify the launch contact at owner@private-customer.io';
      const result = runScan(host, body);
      expect(result.code).toBe(2);
      expect(result.sinks).toEqual([]);
      expect(result.pending).toEqual([body + (host === 'claude' ? '\n' : '')]);
      if (host === 'claude') {
        expect(result.printed).toBe(body + '\n');
        expect(result.stderr).toContain('paused');
      } else {
        expect(result.disposition).toBe('decision-required');
        expect(result.retainedPrivate).toBe(true);
        expect(result.stdout).not.toContain(body);
      }
    });
    for (const scanner of ['broken', 'missing'] as const) {
      test(`${scanner} scanner cannot become successful coverage or persistence`, () => {
        const result = runScan(host, 'Add a greeting command with a unit test.', scanner);
        expect(result.code).not.toBe(0);
        expect(result.sinks).toEqual([]);
        expect(result.pending).toEqual(host === 'codex' ? ['Add a greeting command with a unit test.'] : []);
        if (host === 'claude') expect(result.stderr).toContain('refusing');
        else {
          expect(result.disposition).toBe('scanner-failed');
          expect(result.retainedPrivate).toBe(true);
        }
      });
    }
    test('clean scan passes the exact scanned bytes to the reviewer and sinks', () => {
      const body = 'Add a greeting command with a unit test.\nKeep the CLI backwards compatible.';
      const result = runScan(host, body);
      expect(result.code).toBe(0);
      expect(result.sinks.map(sink => sink.name).sort()).toEqual(['archive.md', 'reviewer-received.txt', 'transcript.md']);
      expect(result.sinks.every(sink => sink.body === body + (host === 'claude' ? '\n' : ''))).toBe(true);
      if (host === 'claude') expect(result.pending).toEqual([]);
      else {
        expect(result.pending).toEqual([]);
        expect(result.retired).toBe(true);
      }
    });
    test('redaction runs before review dispatch and --no-gate only skips scoring', () => {
      const text = content(host);
      expect(text).toContain('`--no-gate` skips the outside score only; redaction always runs');
      expect(text).toContain('On --no-gate record skipped after redaction succeeds.');
      if (host === 'claude') {
        const scan = text.indexOf('#### Redaction scan — pre-codex');
        const preflight = text.indexOf('_OUTSIDE_CFG=enabled', scan);
        expect(scan).toBeGreaterThan(-1);
        expect(preflight).toBeGreaterThan(scan);
      } else {
        const scan = text.indexOf('### Phase 4.5b: Fail-closed redaction');
        const dispatch = text.indexOf('**Dispatch (when redaction passes):**', scan);
        const score = text.indexOf('**Scoring outcomes:**', dispatch);
        expect(scan).toBeGreaterThan(-1);
        expect(dispatch).toBeGreaterThan(scan);
        expect(score).toBeGreaterThan(dispatch);
        expect(text).toContain('Use the native required-decision path; lack of optional input is not consent.');
        expect(text).toContain('Never scan a string then re-render it; pass the SAME file');
        expect(text).toContain('No raw-body archive, transcript log or dispatch.');
        expect(text).toContain('retained_private');
        expect(text).not.toContain('_OUTSIDE_CFG=enabled');
      }
    });
  });
}
