/**
 * #3440 item 8: a session browse resolves to direct launches Chromium with
 * `--proxy-server=direct://`, so the proxy variables Chromium reads on its
 * own (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY) never win silently. Two logging
 * CONNECT proxies on loopback stand in for the environment's proxy and a
 * configured one; a name that does not resolve is the target, so a CONNECT at
 * a proxy is the only way the navigation can get past DNS. Linux only: that is
 * where Chromium reads the variables (forcesDirect); macOS and Windows follow
 * the system proxy settings, which proxy-config.test.ts covers as a unit.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeConnectProxies, connectProxy } from './helpers/connect-proxy';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');
const TARGET = 'proxied.gstack-3440.test';

let scratch = '';
let stateFile = '';
let daemonLog = '';

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-proxy-direct-'));
  stateFile = path.join(scratch, 'state', 'browse.json');
  daemonLog = path.join(scratch, 'state', 'browse-daemon.log');
});

// stop works whatever the proxy settings are, so a failed case never leaves
// its daemon behind for the next one to be refused by.
afterEach(async () => { await browse(['stop'], {}); });

afterAll(async () => {
  if (fs.existsSync(stateFile)) {
    try { process.kill(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid, 'SIGKILL'); } catch {}
  }
  await closeConnectProxies();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const readDaemonLog = () => fs.existsSync(daemonLog) ? fs.readFileSync(daemonLog, 'utf8') : '';

async function browse(args: string[], extraEnv: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(BROWSE_|GSTACK_|NO_PROXY$|no_proxy$|HTTPS?_PROXY$|https?_proxy$|ALL_PROXY$|all_proxy$)/.test(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: scratch,
    GSTACK_HOME: path.join(scratch, '.gstack'),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ...(process.platform === 'darwin' ? ['Library', 'Caches'] : ['.cache']), 'ms-playwright'),
    BROWSE_STATE_FILE: stateFile,
    BROWSE_PARENT_PID: '0',
  }, extraEnv);
  // browse-daemon.log is append-mode and shared by every case, so `log` is
  // only what this invocation's daemon wrote: an earlier case's line can never
  // satisfy a later case's assertion.
  const logStart = readDaemonLog().length;
  const cli = Bun.spawn([process.execPath, CLI, ...args], { cwd: scratch, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => cli.kill('SIGKILL'), 60_000);
  const [code, stdout, stderr] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
  clearTimeout(timer);
  return { code, stdout, stderr, out: stdout + stderr, log: readDaemonLog().slice(logStart) };
}

describe.skipIf(process.platform !== 'linux')('#3440 item 8: direct mode never lets Chromium pick a proxy from the environment', () => {
  test('BROWSE_PROXY_URL=direct with HTTPS_PROXY set: no CONNECT reaches the proxy, and the daemon names what it ignored', async () => {
    const envProxy = await connectProxy();
    const env = { HTTPS_PROXY: envProxy.url, BROWSE_PROXY_URL: 'direct' };
    const r = await browse(['goto', `https://${TARGET}/`], env);
    expect(r.stderr).toContain('Starting server...');
    expect(r.stderr).not.toContain('Starting server with proxy');
    expect(r.out).toContain('ERR_NAME_NOT_RESOLVED');
    expect(r.out).not.toContain('ERR_TUNNEL_CONNECTION_FAILED');
    expect(envProxy.connects).toEqual([]);
    expect(r.log).toContain('[browse] [proxy] none: direct connection (--proxy-server=direct://; ignoring HTTPS_PROXY)');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).proxy).toBeUndefined();
  }, 120_000);

  // Added by: /ship test coverage audit (Capy), 2026-10-25, for #3440 item 8.
  // Value: protects=a scheme-less HTTPS_PROXY (host:port, what Chromium's own environment reader took as an HTTP proxy before the launch was explicit; a user:pass@ shape is newly proxied, Chromium rejected it) still reaches that proxy, now through browse's own configuration;
  //   fails_when=resolveProxy stops reading scheme-less variables as http:// and the session goes direct with only a warning; why_new=proxy-env-daemon's scheme-less case targets loopback, which Chromium bypasses anyway; seam=none
  test('a scheme-less HTTPS_PROXY is the configured proxy and the CONNECT reaches the host:port Chromium would have used by itself', async () => {
    const envProxy = await connectProxy();
    const env = { HTTPS_PROXY: envProxy.url.replace(/^http:\/\//, '') };
    const r = await browse(['goto', `https://${TARGET}/`], env);
    expect(r.stderr).toContain(`Starting server with proxy ${envProxy.url}/ from HTTPS_PROXY...`);
    expect(r.stderr).not.toContain('warning: HTTPS_PROXY is not a proxy URL');
    expect(envProxy.connects).toEqual([`${TARGET}:443`]);
    expect(r.log).toContain(`[browse] [proxy] using ${envProxy.url}/ from HTTPS_PROXY`);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).proxy).toBe(`${envProxy.url}/`);
  }, 120_000);

  // Value: protects=the warning fallback ("browse connects directly") is true for a variable that does not parse even as http://: the session never carries it;
  //   fails_when=the direct switch is dropped or the unparseable variable is forwarded to Chromium; seam=none
  test('an unparseable HTTPS_PROXY (unsupported scheme) warns and the daemon still forces direct: no CONNECT reaches the proxy it named', async () => {
    const envProxy = await connectProxy();
    const env = { HTTPS_PROXY: envProxy.url.replace(/^http:\/\//, 'ftp://') };
    const r = await browse(['goto', `https://${TARGET}/`], env);
    expect(r.stderr).toContain('warning: HTTPS_PROXY is not a proxy URL browse can use');
    expect(r.stderr).toContain('Starting server...');
    expect(r.out).toContain('ERR_NAME_NOT_RESOLVED');
    expect(envProxy.connects).toEqual([]);
    expect(r.log).toContain('[browse] [proxy] none: direct connection (--proxy-server=direct://; ignoring HTTPS_PROXY)');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).proxy).toBeUndefined();
  }, 120_000);

  test('control: the same HTTPS_PROXY without the opt-out is the configured proxy, and the CONNECT reaches it', async () => {
    const envProxy = await connectProxy();
    const env = { HTTPS_PROXY: envProxy.url };
    const r = await browse(['goto', `https://${TARGET}/`], env);
    expect(r.stderr).toContain(`Starting server with proxy ${envProxy.url}/ from HTTPS_PROXY...`);
    expect(r.out).toContain('ERR_TUNNEL_CONNECTION_FAILED');
    expect(envProxy.connects).toEqual([`${TARGET}:443`]);
    expect(r.log).toContain(`[browse] [proxy] using ${envProxy.url}/ from HTTPS_PROXY (pass-through to Chromium)`);
  }, 120_000);

  test('control: --proxy beats HTTPS_PROXY explicitly, so only the configured proxy sees the CONNECT', async () => {
    const envProxy = await connectProxy();
    const configured = await connectProxy();
    const env = { HTTPS_PROXY: envProxy.url };
    const r = await browse(['--proxy', configured.url, 'goto', `https://${TARGET}/`], env);
    expect(r.stderr).toContain(`Starting server with proxy ${configured.url}/ from --proxy...`);
    expect(r.out).toContain('ERR_TUNNEL_CONNECTION_FAILED');
    expect(configured.connects).toEqual([`${TARGET}:443`]);
    expect(envProxy.connects).toEqual([]);
  }, 120_000);
});
