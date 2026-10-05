/** Owned, one-shot request transport for native tools without structured stdin.
 * Payloads never live in the repository. Retirement is recoverable, never unlink.
 */
import * as fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const PREFIX = 'gstack-codex-request-';
const MAX_BYTES = 1_048_576;
interface Options { tempRoot?: string; trashRoot?: string; filename?: 'request.json' | 'input.txt' }
interface Identity { dev: number; ino: number }
export interface ClaimedRequest {
  path: string; directory: string; raw: string; hash: string;
  directoryIdentity: Identity; fileIdentity: Identity; claimIdentity: Identity; ownerIdentity: Identity; ownerHash: string; claimHash: string;
}
const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const uid = () => {
  if (!process.getuid) throw new Error('Private request ownership is unsupported on this platform; use structured stdin.');
  return process.getuid();
};
function privateStat(path: string, directory: boolean, mode: number): fs.Stats {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || stat.uid !== uid() || (stat.mode & 0o777) !== mode || (!directory && stat.nlink !== 1)) {
    throw new Error('Request ownership, type or private mode is invalid.');
  }
  return stat;
}
function root(options: Options): string { return fs.realpathSync(options.tempRoot ?? tmpdir()); }

export function preparePrivateRequest(options: Options = {}): { path: string; directory: string } {
  uid();
  const directory = fs.mkdtempSync(join(root(options), PREFIX));
  fs.chmodSync(directory, 0o700);
  const filename = options.filename ?? 'request.json';
  const path = join(directory, filename);
  fs.writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(join(directory, 'owner.json'), JSON.stringify({ schema: 1, owner: 'gstack-codex-request', filename, id: randomUUID() }), { flag: 'wx', mode: 0o400 });
  return { path, directory };
}

export function claimPrivateRequest(input: string, options: Options = {}): ClaimedRequest {
  const path = resolve(input), directory = dirname(path);
  if (!['request.json', 'input.txt'].includes(basename(path)) || dirname(directory) !== root(options)
    || !new RegExp('^' + PREFIX + '[a-zA-Z0-9]{6}$').test(basename(directory))) {
    throw new Error('Not an allocated private request path.');
  }
  const directoryIdentity = privateStat(directory, true, 0o700);
  const ownerIdentity = privateStat(join(directory, 'owner.json'), false, 0o400);
  const ownerRaw = fs.readFileSync(join(directory, 'owner.json'), 'utf8');
  const owner = JSON.parse(ownerRaw);
  if (owner.schema !== 1 || owner.owner !== 'gstack-codex-request' || owner.filename !== basename(path) || typeof owner.id !== 'string') throw new Error('Invalid request owner.');
  const expected = privateStat(path, false, 0o600);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw: string;
  try {
    const actual = fs.fstatSync(fd);
    if (!same(expected, actual) || actual.size > MAX_BYTES) throw new Error('Request changed or exceeds the 1 MiB limit.');
    const bytes = fs.readFileSync(fd);
    raw = bytes.toString('utf8');
    if (!Buffer.from(raw).equals(bytes)) throw new Error('Request must contain valid UTF-8 bytes.');
    if (Buffer.byteLength(raw) > MAX_BYTES || !same(directoryIdentity, privateStat(directory, true, 0o700))) throw new Error('Request changed or exceeds the 1 MiB limit.');
  } finally { fs.closeSync(fd); }
  const digest = hash(raw);
  const claimRaw = JSON.stringify({ schema: 1, owner: owner.id, sha256: digest });
  try {
    fs.writeFileSync(join(directory, 'claim.json'), claimRaw, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Request already claimed; allocate a new request instead of replaying it.');
    throw error;
  }
  return { path, directory, raw, hash: digest, directoryIdentity, fileIdentity: expected,
    ownerIdentity, ownerHash: hash(ownerRaw), claimHash: hash(claimRaw),
    claimIdentity: privateStat(join(directory, 'claim.json'), false, 0o600) };
}

function intactRequest(claimed: ClaimedRequest, directory: string): boolean {
  const payload = join(directory, basename(claimed.path));
  try {
    if (!same(claimed.directoryIdentity, privateStat(directory, true, 0o700))
      || !same(claimed.fileIdentity, privateStat(payload, false, 0o600))
      || !same(claimed.claimIdentity, privateStat(join(directory, 'claim.json'), false, 0o600))
      || !same(claimed.ownerIdentity, privateStat(join(directory, 'owner.json'), false, 0o400))
      || hash(fs.readFileSync(join(directory, 'owner.json'))) !== claimed.ownerHash
      || hash(fs.readFileSync(join(directory, 'claim.json'))) !== claimed.claimHash
      || hash(fs.readFileSync(payload)) !== claimed.hash) return false;
    // Do not move a task's new files just because the old request still exists.
    if (fs.readdirSync(directory).sort().join(',') !== ['claim.json', 'owner.json', basename(claimed.path)].sort().join(',')) return false;
    return same(claimed.directoryIdentity, privateStat(directory, true, 0o700));
  } catch { return false; }
}

export function finishPrivateRequest(claimed: ClaimedRequest, succeeded: boolean, options: Options = {}): { status: 'retired' | 'retained_private'; path: string; reason?: string } {
  let location = claimed.directory;
  const retained = (reason: string) => ({ status: 'retained_private' as const, path: location, reason });
  if (!intactRequest(claimed, location)) return retained('ownership_or_bytes_changed');
  if (!succeeded) return retained('dispatch_failed');
  const trash = options.trashRoot ?? (process.platform === 'darwin' ? join(process.env.HOME || homedir(), '.Trash') : undefined);
  if (!trash) return retained('trash_unavailable');
  try {
    const stat = fs.lstatSync(trash);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o022)) return retained('trash_unavailable');
    // A unique container makes rename non-clobbering. No existing trash item
    // or unrelated file can be its target; no permanent removal is performed.
    const container = fs.mkdtempSync(join(trash, PREFIX));
    fs.chmodSync(container, 0o700);
    const destination = join(container, 'request');
    // Destination allocation is observable and can take time: validate again.
    if (!intactRequest(claimed, location)) return retained('ownership_or_bytes_changed');
    fs.renameSync(claimed.directory, destination);
    location = destination;
    // Pathname rename cannot exclude a same-UID last-instant race. Preserve
    // moved content at its actual recoverable location and never call a detected
    // change retired success. Do not restore over a replacement at the old path.
    if (!intactRequest(claimed, destination)) return retained('ownership_or_bytes_changed');
    return { status: 'retired', path: destination };
  } catch { return retained('trash_unavailable'); }
}
