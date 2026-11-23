// The UI installs a real Bridge bundle from a synthetic release server. The bundled
// version label is set to 2.22 so this exercises an upgrade on every CI build.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const dir = mkdtempSync(path.join(tmpdir(), 'mgo-kem-update-'));
const runtime = path.resolve('runtime/build/kemulator');
const version = readFileSync(path.join(runtime, 'KEM_VERSION'), 'utf8').trim();
const bundled = path.join(dir, 'bundled');
mkdirSync(bundled);
for (const file of readdirSync(runtime).filter(file => file !== 'KEM_VERSION')) symlinkSync(path.join(runtime, file), path.join(bundled, file));
writeFileSync(path.join(bundled, 'KEM_VERSION'), '2.22');
const bundle = execFileSync(process.execPath, ['tools/release/pack-kemulator.mjs', runtime, dir], { encoding: 'utf8' }).trim();
const name = path.basename(bundle);
const bytes = readFileSync(bundle);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const source = createServer((req, res) => {
  if (req.url === '/mgo-updates/latest') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tag_name: '1.1.0', assets: [{ name, size: bytes.length, digest: `sha256:${sha256}` }] }));
  } else if (req.url === `/mgo-updates/download/1.1.0/${name}`) res.end(bytes);
  else { res.writeHead(404); res.end(); }
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const sourcePort = await listen(source);
const temp = createServer();
const port = await listen(temp);
await new Promise(resolve => temp.close(resolve));
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server;
let browser;
const health = () => fetch(base + '/api/health').then(r => r.json());
const wait = async (read, label) => {
  for (let i = 0; i < 150; i++) { try { if (await read()) return; } catch {} await sleep(100); }
  throw new Error(`timeout: ${label}`);
};
const start = async () => {
  server = spawn(process.execPath, ['apps/api/dist/server.js'], { env: { ...process.env, MGO_RELEASE_PROXY_URL: `http://127.0.0.1:${sourcePort}`, KEM_DIR: bundled, RUN_DIR: path.join(dir, 'run'), PORT: String(port), DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', LOG_LEVEL: 'warn' }, stdio: 'inherit' });
  await wait(async () => (await health()).ok, 'Java ME runtime');
};
const stop = async () => {
  if (!server || server.exitCode !== null) return;
  await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
};
try {
  await start();
  await fetch(base + '/api/setup/skip', { method: 'POST' });
  assert.equal((await health()).kemulator.version, '2.22');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(base + '/settings');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await page.getByRole('button', { name: `Install KEmulator v${version}`, exact: true }).click();
  await page.getByText(`KEmulator v${version} will run the next Java ME game you start.`, { exact: true }).waitFor();
  assert.equal((await health()).kemulator.version, version);
  await stop();
  await start();
  assert.equal((await health()).kemulator.version, version, 'active version survives service restart');
  const fd = new FormData();
  fd.append('jar', new Blob([readFileSync('tests/fixtures/testmidlet/build/kemtest.jar')]), 'kemtest.jar');
  const up = await fetch(base + '/api/games', { method: 'POST', body: fd });
  assert.equal(up.status, 201);
  const { game } = await up.json();
  const started = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: game.id }) });
  assert.equal(started.status, 201, await started.clone().text());
  const session = await started.json();
  await wait(async () => (await (await fetch(`${base}/api/sessions/${session.id}`)).json()).framesReceived > 3, 'installed runtime renders frames');
  await page.reload();
  await page.getByRole('button', { name: 'Restore bundled version', exact: true }).click();
  await wait(async () => (await health()).kemulator.version === '2.22', 'restore bundled version');
  assert.equal((await (await fetch(`${base}/api/sessions/${session.id}`)).json()).state, 'running', 'switching runtime does not terminate a live game');
  console.log('PASS Settings installs a verified Bridge bundle, persists it, runs a game and restores the bundled version');
} finally {
  await browser?.close();
  await stop();
  source.close();
  rmSync(dir, { recursive: true, force: true });
}
