/**
 * The `--config` file for every Bun child browse spawns (#3085). The child
 * runs in the user's project, where Bun would otherwise load that project's
 * bunfig.toml, whose preload runs code. POSIX passes /dev/null. Windows has no
 * /dev/null and `--config=NUL` panicked Bun 1.3.10 while parsing the flag, so
 * Windows gets an empty bunfig created exclusively in a private directory and
 * re-checked to be a zero-byte regular file before each spawn; anything else
 * is replaced, so the file cannot become a preload vector.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let emptyConfig: string | null = null;

function isEmptyRegularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size === 0;
  } catch {
    return false;
  }
}

export function emptyBunConfig(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return '/dev/null';
  if (emptyConfig && isEmptyRegularFile(emptyConfig)) return emptyConfig;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bunfig-'));
  const file = path.join(dir, 'bunfig.toml');
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  if (!isEmptyRegularFile(file)) throw new Error(`empty Bun config ${file} is not a zero-byte file`);
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  emptyConfig = file;
  return file;
}

export interface BunExeLookup {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  isBun?: boolean;
  isFile?: (p: string) => boolean;
}

/**
 * The bun.exe a Windows parent spawns its bun children with, or null when
 * none is installed: the running bun.exe itself, then BUN_INSTALL\bin, each
 * absolute PATH entry (plus, beside npm's bun.cmd shim, the bun.exe it
 * forwards to), then USERPROFILE\.bun\bin. The terminal agent and the native
 * cookie-import worker (cookie-import-native.ts) both resolve through it; it
 * lives here because this file is part of the native import's source-bound
 * qualification (NATIVE_CODE_INPUTS), and terminal-agent-control.ts is not.
 */
export function findWindowsBunExe(opts: BunExeLookup = {}): string | null {
  const win = path.win32;
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const isBun = opts.isBun ?? !!process.versions.bun;
  const isFile = opts.isFile ?? ((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  // A compiled browse.exe also reports versions.bun, so check the name too.
  if (isBun && /^bun\.exe$/i.test(win.basename(execPath))) return execPath;
  const dirs = (env.PATH || env.Path || '').split(';').filter(d => d && win.isAbsolute(d));
  const candidates = [
    ...(env.BUN_INSTALL ? [win.join(env.BUN_INSTALL, 'bin', 'bun.exe')] : []),
    ...dirs.flatMap(d => [
      win.join(d, 'bun.exe'),
      // npm global install: PATH holds only the bun.cmd shim; the real
      // binary it forwards to lives under node_modules.
      ...(isFile(win.join(d, 'bun.cmd')) ? [win.join(d, 'node_modules', 'bun', 'bin', 'bun.exe')] : []),
    ]),
    ...(env.USERPROFILE ? [win.join(env.USERPROFILE, '.bun', 'bin', 'bun.exe')] : []),
  ];
  return candidates.find(isFile) ?? null;
}
