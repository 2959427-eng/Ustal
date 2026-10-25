// Local synthetic Caddy contract check; no production requests or configuration changes.
// CADDY_BIN=/path/to/caddy node infra/timeweb/scripts/test-legal-routing.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

assert(process.env.CADDY_BIN, 'Set CADDY_BIN to the installed Caddy binary');
const source = readFileSync(new URL('../app/Caddyfile', import.meta.url), 'utf8');
const seen = [];
const api = http.createServer((req, res) => {
  seen.push(req.url);
  res.setHeader('Content-Type', req.url === '/legal.css' ? 'text/css' : 'text/html');
  res.end(req.method === 'HEAD' ? '' : `fixture:${req.url}`);
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const apiPort = api.address().port;
const reservation = http.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const dir = mkdtempSync(join(tmpdir(), 'ustal-legal-routing-'));
const file = join(dir, 'Caddyfile');
// Exercise the exact public-site block from the deployment file with local listeners.
const start = source.indexOf('\nustal.site {');
assert(start >= 0, 'Exact public-site block missing');
const block = source.slice(start + 1, source.indexOf('\nwww.ustal.site {'));
assert(block.startsWith('ustal.site {'));
writeFileSync(file, '{\n admin off\n auto_https off\n}\n' + block
  .replace('ustal.site {', `http://127.0.0.1:${port} {`)
  .replaceAll('api:4000', `127.0.0.1:${apiPort}`)
  .replaceAll('{$API_DOMAIN}', 'api.ustal.test'));
const validate = spawnSync(process.env.CADDY_BIN, ['validate', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8' });
assert.equal(validate.status, 0, validate.stderr);
const caddy = spawn(process.env.CADDY_BIN, ['run', '--config', file, '--adapter', 'caddyfile'], { stdio: 'ignore' });
const origin = `http://127.0.0.1:${port}`;
let checks = 0;
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { ready = (await fetch(origin, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Local Caddy did not start');
  for (const path of ['/privacy', '/terms', '/community-guidelines', '/support', '/legal.css']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200); assert.equal(await response.text(), `fixture:${path}`); checks++;
    assert.equal((await fetch(origin + path, { method: 'HEAD' })).status, 200); checks++;
  }
  const redirect = await fetch(origin + '/delete-account', { redirect: 'manual' });
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), 'https://api.ustal.test/delete-account'); checks++;
  assert(!seen.includes('/delete-account'));
  for (const path of ['/auth/login', '/me', '/account/delete/client.js', '/privacy-extra']) {
    assert.equal((await fetch(origin + path)).status, 404); assert(!seen.includes(path)); checks++;
  }
  assert.equal((await fetch(origin + '/privacy', { method: 'POST' })).status, 404); checks++;
  assert.equal(await (await fetch(origin)).text(), 'USTAL'); checks++;
  assert(source.includes('reverse_proxy admin:4100'));
  assert(source.includes('redir https://ustal.site{uri} permanent')); checks++;
  console.log(`PASS: ${checks} legal routing checks; read-only public routes and deletion-origin redirect`);
} finally {
  if (caddy.exitCode === null) {
    const exited = new Promise(resolve => caddy.once('exit', resolve));
    caddy.kill(); await exited;
  }
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
  const withinTemp = relative(resolve(tmpdir()), resolve(dir));
  assert(!isAbsolute(withinTemp) && !withinTemp.startsWith('..') && withinTemp.startsWith('ustal-legal-routing-'));
  rmSync(dir, { recursive: true, force: true });
}
