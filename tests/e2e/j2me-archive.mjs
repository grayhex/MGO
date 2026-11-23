import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildApp } from '../../apps/api/src/server.ts';
import { makeJar, testConfig } from '../../apps/api/src/dev/testing.ts';
import { archiveBuild, archiveFixtureWorker } from '../fixtures/archive-fixture.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'mgo-archive-e2e-'));
const data = path.join(root, 'data');
const external = path.join(root, 'external');
mkdirSync(external);
const first = makeJar('Archive Racer');
const second = makeJar('Archive Racer', { version: '2.0.0' });
const candidate = makeJar('Archive Racer', { version: '1.5.0' });
const corrupt = Buffer.from('this is not a JAR');
const invalidBytes = makeJar('Bad Hash', { vendor: 'Fixtures' });
const builds = [
  archiveBuild(first),
  archiveBuild(second, { version: '2.0.0', filename: 'Racer v2.jar' }),
  archiveBuild(corrupt, { title: 'Corrupt ZIP', filename: 'Corrupt ZIP.jar' }),
  archiveBuild(invalidBytes, { title: 'Bad Hash', filename: 'Bad Hash.jar' }),
];
const changed = Buffer.from(invalidBytes);
changed[changed.length - 1] ^= 1;
const options = { delay: 60 };
const worker = archiveFixtureWorker(builds, new Map([[builds[0].sha256, first], [builds[1].sha256, second], [builds[2].sha256, corrupt], [builds[3].sha256, changed]]), options);
const app = await buildApp(testConfig({ dataDir: data, runDir: path.join(root, 'run'), archiveWritableRoot: external, webDir: path.resolve('apps/web/dist') }), { archiveWorker: worker });
const base = await app.fastify.listen({ port: 0, host: '127.0.0.1' });
await fetch(base + '/api/setup/skip', { method: 'POST' });
const current = app.library.add(first, null, 1024 ** 2).game;
const probable = app.library.add(candidate, null, 1024 ** 2).game;
app.library.setTitle(current.groupKey, 'My locked title');
app.library.update(current.id, { favorite: true, settings: { heapMb: 256 } });
const save = path.join(data, 'saves', current.id, 'fixture.bin');
mkdirSync(path.dirname(save), { recursive: true });
writeFileSync(save, 'saved data');
const status = () => fetch(base + '/api/archive').then(r => r.json());
const job = () => fetch(base + '/api/archive/download').then(r => r.json()).then(r => r.job);
const send = (url, method, payload) => fetch(base + '/api/archive' + url, { method, ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
const wait = async (read, label) => {
  for (let i = 0; i < 120; i++) {
    const val = await read();
    if (val) return val;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timeout: ' + label);
};
let browser;
try {
  assert.equal((await send('/search?q=racer', 'GET')).status, 409);
  assert.equal(app.library.get(current.id).name, 'My locked title');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/settings#mobygames');
  const archive = page.getByRole('region', { name: 'J2ME Archive' });
  await archive.getByRole('button', { name: 'Install index' }).click();
  await archive.getByRole('button', { name: 'Update index' }).waitFor();
  assert.equal((await status()).index.version, 'index-v2');
  await archive.getByRole('button', { name: 'Start preview' }).click();
  await archive.getByRole('button', { name: 'View preview' }).click();
  assert.equal(app.library.get(current.id).archiveMatch, undefined, 'preview leaves the library unchanged');
  await archive.getByText('Needs review', { exact: true }).last().waitFor();
  await archive.getByRole('button', { name: 'Apply archive matches' }).click();
  await archive.getByText('Matches applied', { exact: true }).waitFor();
  assert.equal(app.library.get(current.id).archiveMatch.confidence, 'verified');
  assert.equal(app.library.get(probable.id).archiveMatch.state, 'review');
  assert.equal(app.library.get(current.id).name, 'My locked title');
  assert.equal(app.library.get(current.id).favorite, true);
  assert.equal(app.library.get(current.id).settings.heapMb, 256);
  assert.equal(readFileSync(save, 'utf8'), 'saved data');

  const manual = await send('/match/' + probable.id, 'PUT', { sha256: builds[0].sha256 });
  assert.equal(manual.status, 200);
  assert.equal((await manual.json()).confidence, 'candidate');
  assert.notEqual(app.library.get(probable.id).archiveMatch.matchedSha256, probable.sha256);

  await page.goto(base);
  await page.getByRole('button', { name: 'Find games in J2ME Archive' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search the archive' }).fill('Archive Racer');
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await dialog.getByText('Already in library', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: /Racer v2.jar/ }).click();
  await dialog.getByText(builds[1].sha256, { exact: true }).waitFor();
  assert.equal(await job(), null, 'search and preview never start a transfer');
  await dialog.getByRole('button', { name: 'Download to my library…' }).click();
  await dialog.getByLabel('Destination subfolder').fill('Games/Racing');
  await dialog.getByRole('button', { name: 'Confirm download' }).click();
  await dialog.getByText('JAR verified and imported').waitFor();
  const imported = await job();
  const dir = path.join(data, 'import/Games/Racing');
  assert.equal(readdirSync(dir).length, 1);
  assert.deepEqual(readFileSync(path.join(dir, readdirSync(dir)[0])), Buffer.from(second));
  assert.equal(app.library.get(imported.gameId).groupKey, current.groupKey);
  assert.equal(app.library.get(imported.gameId).archiveMatch.state, 'exact');
  await dialog.getByRole('button', { name: 'Open game' }).click();
  await page.waitForURL('**/play/' + imported.gameId);
  assert.equal((await send('/download', 'POST', { sha256: builds[1].sha256 })).status, 202);
  assert.equal((await job()).duplicate, true);

  assert.equal((await send('/download', 'POST', { sha256: builds[2].sha256, folder: '../outside' })).status, 400);
  symlinkSync(root, path.join(external, 'link'), 'dir');
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal((await send('/download', 'POST', { sha256: builds[2].sha256, root: 'external', folder: 'link/target' })).status, 400);
  options.delay = 2000;
  assert.equal((await send('/download', 'POST', { sha256: builds[2].sha256 })).status, 202);
  assert.equal((await (await send('/download', 'DELETE')).json()).cancelled, true);
  await wait(async () => (await job())?.state === 'cancelled', 'cancelled download');
  assert.equal(app.library.findBySha(builds[2].sha256), null);
  options.delay = 0;
  await new Promise(resolve => setTimeout(resolve, 2100));
  await send('/download', 'POST', { sha256: builds[2].sha256 });
  const badZip = await wait(async () => { const j = await job(); return j?.state === 'failed' && j; }, 'corrupt ZIP rejected');
  assert.match(badZip.message, /not a JAR/);
  await new Promise(resolve => setTimeout(resolve, 2100));
  await send('/download', 'POST', { sha256: builds[3].sha256 });
  const badHash = await wait(async () => { const j = await job(); return j?.sha256 === builds[3].sha256 && j.state === 'failed' && j; }, 'SHA-256 mismatch rejected');
  assert.match(badHash.message, /SHA-256 mismatch/);
  assert.equal(app.library.findBySha(builds[3].sha256), null);
  assert.equal(app.library.count(), 3);
  assert.deepEqual(errors, []);
  console.log('PASS J2ME Archive installs an index, previews and applies exact matches, reviews candidates, downloads and deduplicates a selected JAR, and rejects unsafe destinations and invalid artifacts.');
} finally {
  await browser?.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
