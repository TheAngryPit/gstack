import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePrivateRequest, claimPrivateRequest, finishPrivateRequest } from '../lib/codex-request-file';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'native-request-test-')); fs.mkdirSync(join(root, '.Trash')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const options = () => ({ tempRoot: root, trashRoot: join(root, '.Trash') });

test('two tasks allocate distinct private requests without changing an existing repository file', () => {
  const existing = join(root, 'gbrain-request.json');
  fs.writeFileSync(existing, 'other task');
  const a = preparePrivateRequest(options()), b = preparePrivateRequest(options());
  expect(a.path).not.toBe(b.path);
  for (const request of [a, b]) {
    expect(fs.statSync(request.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(request.path).mode & 0o777).toBe(0o600);
  }
  expect(fs.readFileSync(existing, 'utf8')).toBe('other task');
});

test('claim binds the literal bytes once and successful consumption is recoverably retired', () => {
  const request = preparePrivateRequest(options());
  const raw = JSON.stringify({ op: 'search', query: 'literal $() ` ; Unicode ☃' });
  fs.writeFileSync(request.path, raw);
  const claimed = claimPrivateRequest(request.path, options());
  expect(claimed.raw).toBe(raw);
  expect(() => claimPrivateRequest(request.path, options())).toThrow('already claimed');
  const result = finishPrivateRequest(claimed, true, options());
  expect(result.status).toBe('retired');
  expect(fs.existsSync(request.directory)).toBe(false);
  expect(fs.readFileSync(join(result.path, 'request.json'), 'utf8')).toBe(raw);
  expect(fs.statSync(result.path).mode & 0o777).toBe(0o700);
});

test('failed dispatch and unavailable Trash retain private bytes with an explicit result', () => {
  for (const succeed of [false, true]) {
    const request = preparePrivateRequest(options());
    fs.writeFileSync(request.path, '{"op":"get","slug":"fixture"}');
    const claimed = claimPrivateRequest(request.path, options());
    const result = finishPrivateRequest(claimed, succeed, { ...options(), trashRoot: join(root, 'missing-trash') });
    expect(result.status).toBe('retained_private');
    expect(result.path).toBe(request.directory);
    expect(fs.readFileSync(request.path, 'utf8')).toContain('fixture');
    expect(fs.statSync(request.path).mode & 0o777).toBe(0o600);
  }
});

test('arbitrary files, symlinks, hardlinks and broad file modes are refused without modifying targets', () => {
  const victim = join(root, 'foreign.json');
  fs.writeFileSync(victim, 'private unrelated file', { mode: 0o600 });
  expect(() => claimPrivateRequest(victim, options())).toThrow();
  for (const kind of ['symlink', 'hardlink', 'mode']) {
    const request = preparePrivateRequest(options());
    if (kind === 'mode') fs.chmodSync(request.path, 0o644);
    else {
      fs.unlinkSync(request.path); // exact empty fixture only
      if (kind === 'symlink') fs.symlinkSync(victim, request.path);
      else fs.linkSync(victim, request.path);
    }
    expect(() => claimPrivateRequest(request.path, options())).toThrow();
    expect(fs.readFileSync(victim, 'utf8')).toBe('private unrelated file');
  }
});

test('changed or reused targets are never retired and cannot be claimed a second time', () => {
  const request = preparePrivateRequest(options());
  fs.writeFileSync(request.path, '{"op":"search","query":"original"}');
  const claimed = claimPrivateRequest(request.path, options());
  fs.writeFileSync(request.path, '{"op":"search","query":"new owner data"}');
  const result = finishPrivateRequest(claimed, true, options());
  expect(result.status).toBe('retained_private');
  expect(result.reason).toBe('ownership_or_bytes_changed');
  expect(fs.readFileSync(request.path, 'utf8')).toContain('new owner data');
  expect(() => claimPrivateRequest(request.path, options())).toThrow();
});

test('generic private inputs retain literal untrusted bytes and require the exact consumed hash to retire', () => {
  const prepare = Bun.spawnSync([process.execPath, join(import.meta.dir, '../bin/gstack-private-input'), '--prepare'], { env: { ...process.env, TMPDIR: root, HOME: root }, timeout: 30_000 });
  expect(prepare.exitCode).toBe(0);
  const input = JSON.parse(prepare.stdout.toString());
  const raw = 'REDACT_BODY_EOF\n$(touch /not-executed) `false` " ;\nUnicode ☃';
  fs.writeFileSync(input.path, raw);
  const wrong = Bun.spawnSync([process.execPath, join(import.meta.dir, '../bin/gstack-private-input'), '--retire', input.path, '--sha256', '0'.repeat(64)], { env: { ...process.env, TMPDIR: root, HOME: root }, timeout: 30_000 });
  expect(wrong.exitCode).toBe(1);
  expect(JSON.parse(wrong.stdout.toString()).status).toBe('retained_private');
  expect(fs.readFileSync(input.path, 'utf8')).toBe(raw);
  const second = preparePrivateRequest({ ...options(), filename: 'input.txt' });
  fs.writeFileSync(second.path, raw);
  const digest = new Bun.CryptoHasher('sha256').update(raw).digest('hex');
  const success = Bun.spawnSync([process.execPath, join(import.meta.dir, '../bin/gstack-private-input'), '--retire', second.path, '--sha256', digest], { env: { ...process.env, TMPDIR: root, HOME: root }, timeout: 30_000 });
  expect(success.exitCode).toBe(0);
  const retired = JSON.parse(success.stdout.toString());
  expect(retired.status).toBe('retired');
  expect(fs.readFileSync(join(retired.path, 'input.txt'), 'utf8')).toBe(raw);
});

test('invalid UTF-8 cannot be claimed as different bytes', () => {
  const request = preparePrivateRequest(options());
  fs.writeFileSync(request.path, Buffer.from([0xff]));
  expect(() => claimPrivateRequest(request.path, options())).toThrow('UTF-8');
});

test('retirement compares raw bytes rather than equal UTF-8 replacement characters', () => {
  const request = preparePrivateRequest(options());
  fs.writeFileSync(request.path, '\uFFFD');
  const claimed = claimPrivateRequest(request.path, options());
  fs.writeFileSync(request.path, Buffer.from([0xff]));
  const result = finishPrivateRequest(claimed, true, options());
  expect(result.status).toBe('retained_private');
  expect(result.reason).toBe('ownership_or_bytes_changed');
  expect(fs.readFileSync(request.path)).toEqual(Buffer.from([0xff]));
});

for (const change of ['late-file', 'replacement-directory']) {
  test(`retirement revalidates after Trash allocation: ${change}`, () => {
    const request = preparePrivateRequest(options());
    fs.writeFileSync(request.path, 'original');
    const claimed = claimPrivateRequest(request.path, options());
    const mkdtemp = fs.mkdtempSync;
    const spy = spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string) => {
      const created = mkdtemp(prefix);
      if (prefix.startsWith(join(root, '.Trash'))) {
        if (change === 'replacement-directory') {
          fs.renameSync(request.directory, join(root, 'original-held'));
          fs.mkdirSync(request.directory, {mode:0o700});
        }
        fs.writeFileSync(join(request.directory, 'unrelated.txt'), 'new owner data');
      }
      return created;
    }) as typeof fs.mkdtempSync);
    let result;
    try { result = finishPrivateRequest(claimed, true, options()); }
    finally { spy.mockRestore(); }
    expect(result!.status).toBe('retained_private');
    expect(result!.reason).toBe('ownership_or_bytes_changed');
    expect(result!.path).toBe(request.directory);
    expect(fs.readFileSync(join(request.directory, 'unrelated.txt'), 'utf8')).toBe('new owner data');
    if (change === 'replacement-directory') expect(fs.readFileSync(join(root,'original-held','request.json'),'utf8')).toBe('original');
  });
}

test('a last-instant mutation during rename is retained at its recoverable location, never retired success', () => {
  const request = preparePrivateRequest(options());
  fs.writeFileSync(request.path, 'original');
  const claimed = claimPrivateRequest(request.path, options());
  const rename = fs.renameSync;
  const spy = spyOn(fs, 'renameSync').mockImplementation(((source: string, destination: string) => {
    if (source === request.directory) fs.writeFileSync(join(source, 'unrelated.txt'), 'late data');
    return rename(source,destination);
  }) as typeof fs.renameSync);
  let result;
  try { result = finishPrivateRequest(claimed, true, options()); }
  finally { spy.mockRestore(); }
  expect(result!.status).toBe('retained_private');
  expect(result!.reason).toBe('ownership_or_bytes_changed');
  expect(fs.readFileSync(join(result!.path, 'unrelated.txt'), 'utf8')).toBe('late data');
  expect(fs.readFileSync(join(result!.path, 'request.json'), 'utf8')).toBe('original');
});
