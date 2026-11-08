/**
 * #3440 item 8 on the launch paths the CLI e2e (proxy-direct-launch.test.ts)
 * never reaches: the BROWSE_EXTENSIONS_DIR persistent context, launchHeaded()
 * and the handoff() relaunch. The three have drifted apart before (stealth
 * args, profile resolution), so each is driven here through the real
 * BrowserManager with HTTPS_PROXY inherited by Chromium, the way the daemon
 * inherits the user's environment. A logging CONNECT proxy on loopback stands
 * in for that proxy and the target name does not resolve, so a CONNECT at the
 * proxy is the only way the navigation can get past DNS: direct means
 * ERR_NAME_NOT_RESOLVED and an empty CONNECT log. The headed control with a
 * configured proxy shows the same harness sees a CONNECT when one is due.
 *
 * Added by: /ship test coverage audit (Capy), 2026-10-25, for #3440 item 8.
 * Value: protects=extension, headed and handoff launches ignore HTTPS_PROXY unless browse configured a proxy; fails_when=one path drops --proxy-server=direct:// or the direct switch overrides a configured proxy; why_new=proxy-direct-launch.test.ts covers only headless launch() through the CLI; seam=none; no_claim=Linux with Xvfb only; macOS/Windows system proxy settings are not exercised
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserManager } from '../src/browser-manager';
import { closeConnectProxies, connectProxy, type ConnectProxy } from './helpers/connect-proxy';

const TARGET = 'proxied.gstack-3440.test';
const ENV_KEYS = [
  'DISPLAY', 'WAYLAND_DISPLAY', 'BROWSE_HEADED', 'CHROMIUM_PROFILE', 'BROWSE_STATE_FILE', 'BROWSE_EXTENSIONS_DIR',
  'BROWSE_PROXY_URL', 'BROWSE_PROXY_USER', 'BROWSE_PROXY_PASS', 'NO_PROXY', 'no_proxy',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
] as const;

let saved: Record<string, string | undefined>;
let scratch = '';
let bm: BrowserManager | null = null;

// One fresh environment proxy per test: a CONNECT leaked by one launch path
// must fail that test alone, never a later one.
let envProxy: ConnectProxy;

afterAll(closeConnectProxies);

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-proxy-direct-paths-'));
  process.env.BROWSE_STATE_FILE = path.join(scratch, 'state', 'browse.json');
  process.env.CHROMIUM_PROFILE = path.join(scratch, 'profile');
  envProxy = await connectProxy();
  process.env.HTTPS_PROXY = envProxy.url;
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

/** What Chromium reports for the unresolvable target: the net error, or 'loaded'. */
async function navigationError(manager: BrowserManager): Promise<string> {
  return manager.getPage().goto(`https://${TARGET}/`, { timeout: 20_000 }).then(() => 'loaded', e => String(e));
}

describe.skipIf(process.platform !== 'linux')('#3440 item 8: every launch path tells Chromium direct:// (Linux, real Chromium)', () => {
  test('BROWSE_EXTENSIONS_DIR persistent context: HTTPS_PROXY is ignored, no CONNECT reaches the proxy', async () => {
    const ext = path.join(scratch, 'ext');
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'probe', version: '1' }));
    process.env.BROWSE_EXTENSIONS_DIR = ext;
    bm = new BrowserManager();
    await bm.launch();
    expect(await navigationError(bm)).toContain('ERR_NAME_NOT_RESOLVED');
    expect(envProxy.connects).toEqual([]);
  }, 60_000);

  test('launchHeaded(): the full Chromium ignores HTTPS_PROXY, no CONNECT reaches the proxy', async () => {
    bm = new BrowserManager();
    await bm.launchHeaded();
    expect(bm.getIsHeaded()).toBe(true);
    expect(await navigationError(bm)).toContain('ERR_NAME_NOT_RESOLVED');
    expect(envProxy.connects).toEqual([]);
  }, 60_000);

  test('handoff(): the relaunched headed Chromium ignores HTTPS_PROXY, no CONNECT reaches the proxy', async () => {
    bm = new BrowserManager();
    await bm.launch();
    expect(await bm.handoff('proxy check')).toContain('HANDOFF:');
    expect(bm.getIsHeaded()).toBe(true);
    expect(await navigationError(bm)).toContain('ERR_NAME_NOT_RESOLVED');
    expect(envProxy.connects).toEqual([]);
  }, 60_000);

  test('control: a configured proxy on the headed path still receives the CONNECT, and HTTPS_PROXY none', async () => {
    const configured = await connectProxy();
    bm = new BrowserManager();
    bm.setProxyConfig({ server: configured.url, bypass: 'localhost,127.0.0.1,[::1]' });
    await bm.launchHeaded();
    expect(await navigationError(bm)).toContain('ERR_TUNNEL_CONNECTION_FAILED');
    // Full Chromium retries a refused tunnel and tunnels its own background
    // traffic too, so the target is present rather than the only entry.
    expect(configured.connects).toContain(`${TARGET}:443`);
    expect(envProxy.connects).toEqual([]);
  }, 60_000);
});
