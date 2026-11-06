/**
 * A logging HTTP CONNECT proxy on loopback for the #3440 item 8 tests: every
 * CONNECT it receives is recorded and refused with 502, so a navigation whose
 * target name does not resolve can reach the proxy only when Chromium was
 * told to use it. close() stops every proxy a file opened.
 */
import * as http from 'node:http';

export interface ConnectProxy { server: http.Server; url: string; connects: string[] }

const opened: ConnectProxy[] = [];

export async function connectProxy(): Promise<ConnectProxy> {
  const connects: string[] = [];
  const server = http.createServer((_req, res) => { res.writeHead(502); res.end(); });
  server.on('connect', (req, socket) => {
    connects.push(req.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const entry = { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, connects };
  opened.push(entry);
  return entry;
}

export async function closeConnectProxies(): Promise<void> {
  for (const { server } of opened.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
}
