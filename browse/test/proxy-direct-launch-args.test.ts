/**
 * #3440 item 8, the platform gate at the real boundary: the command line the
 * headless launch hands Chromium. proxy-config.test.ts proves forcesDirect()
 * per platform and proxy-direct-launch*.test.ts prove the switch's effect on
 * traffic, but both run that proof on Linux, where the switch is always due,
 * so neither can see the arm that protects GStack Browser.app users behind a
 * corporate proxy: on macOS and Windows a launch with no browse proxy must
 * NOT carry --proxy-server=direct:// (Chromium keeps the system proxy
 * settings) unless the user set BROWSE_PROXY_URL=direct. The expected values
 * are written out per platform here, not read back from forcesDirect(), so a
 * launch path that stops consulting the predicate and a predicate that
 * changes its answer both fail. Chromium's command line comes from the pid
 * BrowserManager records for its own launch (/proc on Linux, ps on macOS);
 * readPidCmdline has no Windows source, so the file skips there.
 *
 * Added by: /ship test coverage audit (Capy), 2026-10-25, for #3440 item 8.
 * Value: protects=the headless Chromium command line carries --proxy-server=direct:// on Linux and with BROWSE_PROXY_URL=direct, and omits it on macOS without it;
 *   fails_when=proxyLaunchArgs stops consulting forcesDirect, hardcodes the switch, or drops it for an explicit direct;
 *   why_new=proxy-config.test.ts tests the predicate alone and the Linux e2e cannot observe the macOS/Windows omission that keeps system proxy settings;
 *   seam=none; no_claim=no navigation: the switch's effect on traffic is proxy-direct-launch*.test.ts (Linux); Windows and the system proxy itself are not exercised
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserManager } from '../src/browser-manager';
import { readPidCmdline } from '../src/xvfb';

const DIRECT_SWITCH = '--proxy-server=direct://';
const ENV_KEYS = [
  'BROWSE_STATE_FILE', 'BROWSE_EXTENSIONS_DIR', 'GSTACK_CHROMIUM_PATH',
  'BROWSE_PROXY_URL', 'BROWSE_PROXY_USER', 'BROWSE_PROXY_PASS', 'NO_PROXY', 'no_proxy',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
] as const;

let saved: Record<string, string | undefined>;
let scratch = '';
let bm: BrowserManager | null = null;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-proxy-direct-args-'));
  process.env.BROWSE_STATE_FILE = path.join(scratch, 'state', 'browse.json');
  // Nothing listens here: the test reads the command line, never navigates.
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  bm = null;
});

afterEach(async () => {
  try { await Promise.race([bm?.close(), new Promise(resolve => setTimeout(resolve, 5000))]); } catch {}
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}, 15000);

/** The switches of the Chromium this manager launched, from the pid it recorded. */
async function launchedSwitches(manager: BrowserManager): Promise<string[]> {
  await manager.launch();
  const info = manager.getChromiumProcInfo();
  if (!info) throw new Error('BrowserManager recorded no Chromium pid for its own headless launch');
  const cmdline = readPidCmdline(info.pid);
  if (!cmdline) throw new Error(`no command line readable for Chromium pid ${info.pid}`);
  return cmdline.split(' ').filter(arg => arg.startsWith('--'));
}

describe.skipIf(process.platform === 'win32')('#3440 item 8: the headless Chromium command line carries direct:// only where it is due', () => {
  test('no browse proxy with HTTPS_PROXY set: the switch is present on Linux and absent elsewhere, so macOS keeps the system proxy settings', async () => {
    bm = new BrowserManager();
    const switches = await launchedSwitches(bm);
    expect(switches.includes(DIRECT_SWITCH)).toBe(process.platform === 'linux');
    expect(switches.filter(arg => arg.startsWith('--proxy-server=')).length).toBeLessThanOrEqual(1);
  }, 60_000);

  test('BROWSE_PROXY_URL=direct with HTTPS_PROXY set: the switch is present on every platform', async () => {
    process.env.BROWSE_PROXY_URL = 'direct';
    bm = new BrowserManager();
    const switches = await launchedSwitches(bm);
    expect(switches).toContain(DIRECT_SWITCH);
    expect(switches.filter(arg => arg.startsWith('--proxy-server=')).length).toBe(1);
  }, 60_000);
});
