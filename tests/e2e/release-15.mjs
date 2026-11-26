import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeJar, testConfig } from '../../apps/api/src/dev/testing.ts';
import { archiveBuild, archiveFixtureWorker } from '../fixtures/archive-fixture.mjs';

process.env.MGO_VERSION = '1.5.0';
const { buildApp } = await import('../../apps/api/src/server.ts');
const dir = mkdtempSync(path.join(tmpdir(), 'mgo-release-ui-'));
const original = makeJar('3D Bomberman');
const build = archiveBuild(original, { title: '3D Bomberman', filename: '3D Bomberman.jar' });
const app = await buildApp(testConfig({ dataDir: dir, runDir: path.join(dir, 'run'), lanMode: true }), {
  archiveWorker: archiveFixtureWorker([build], new Map([[build.sha256, original]])),
  javaCatalogFetch: async url => url.hostname === 'raw.githubusercontent.com' ? Response.json({ entries: [
    { id: 'ma:3d-bomberman-test', title: '3D Bomberman', genres: ['Action'] },
  ] }) : new Response('<meta name="description" content="J2ME action game">'),
});
const base = await app.fastify.listen({ port: 0, host: '127.0.0.1' });
let browser;
try {
  assert.equal((await app.fastify.inject({ url: '/api/games', headers: { host: '192.168.0.15:8443' } })).statusCode, 200);
  assert.equal((await app.fastify.inject({ url: '/api/games', headers: { host: 'nas.home.arpa:8443' } })).statusCode, 200);
  assert.equal((await app.fastify.inject({ url: '/api/games', headers: { host: 'external.example.com:8443' } })).statusCode, 403);
  assert.equal((await app.fastify.inject({ url: '/api/games', headers: { host: '192.168.0.15:8443', origin: 'https://external.example.com' } })).statusCode, 403);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  const wizard = page.getByRole('dialog', { name: 'Set up MGO' });
  await wizard.getByTestId('wizard-next').click();
  assert.match(await wizard.getByRole('link', { name: 'View the game list' }).getAttribute('href'), /java_curated_top\.txt$/);
  const curated = wizard.getByRole('region', { name: 'Curated Java ME library' });
  await curated.getByRole('button', { name: 'Install index' }).click();
  await curated.getByRole('button', { name: 'Find curated builds' }).click();
  await curated.getByRole('button', { name: 'Download 1 selected games' }).waitFor();
  assert.equal(app.library.count(), 0, 'preview alone does not import');
  const bad = await app.fastify.inject({ url: '/api/archive/curated', method: 'POST', payload: { confirmed: true, selection: [{ title: 'Not on the list', sha256: build.sha256 }] } });
  assert.equal(bad.statusCode, 400);
  assert.ok(await curated.getByRole('checkbox', { name: 'After downloading, scan the folder and find metadata in My Abandonware' }).isChecked());
  await curated.getByRole('button', { name: 'Download 1 selected games' }).click();
  await curated.getByText('1/1 imported', { exact: false }).waitFor();
  assert.equal(readdirSync(path.join(dir, 'import/Curated Java ME')).length, 1);
  const game = app.library.findBySha(build.sha256);
  assert.ok(game);
  await curated.getByText('1 files scanned · 1 titles recognized').waitFor();
  assert.equal((await app.fastify.inject(`/api/games/${game.id}/java-catalog`)).json().info.description, 'J2ME action game');
  await wizard.getByRole('button', { name: 'Skip setup' }).click();
  await page.locator('.runtime-list').getByText('v1.5.0', { exact: true }).waitFor();
  assert.match(await page.locator('.runtime-list').innerText(), /Frontend web app[\s\S]*Java ME emulator[\s\S]*Symbian \/ N-Gage emulator/);
  assert.match(await page.locator('.brand-logo').getAttribute('src'), /logo-(?:horizontal|light)\.svg$/);
  for (let i = 0; i < 26; i++) app.library.add(makeJar(`Another title ${i}`), null, 1024 ** 2);
  const last = app.library.add(makeJar('ZZZ last played'), null, 1024 ** 2).game;
  await page.reload();
  await page.locator('.game-card', { hasText: last.name }).getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForURL('**/play/' + last.id);
  await page.locator('.stage-fps-limit summary').click();
  const fps = page.getByRole('radiogroup', { name: 'Frame limit (fps)' });
  await fps.waitFor();
  assert.equal(await fps.getByRole('radio', { name: 'Default' }).getAttribute('aria-checked'), 'true');
  await page.locator('.stage-left').getByRole('button', { name: 'Library' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('ZZZ last played') && scrollY > 0);
  await page.goto(base + '/settings#mobygames');
  await page.getByRole('heading', { name: 'Java ME' }).waitFor();
  await page.getByRole('heading', { name: 'N-Gage', exact: true }).waitFor();
  await page.goto(base + '/phones');
  const thumb = page.locator('.phone-pick-skin').first();
  await thumb.waitFor();
  assert.ok((await thumb.boundingBox()).height >= 165, 'larger handset thumbnails');
  await page.route('**/api/health', async route => {
    const response = await route.fetch();
    const health = await response.json();
    await route.fulfill({ response, json: { ...health, version: '0.1.0-beta.1+edge.085995c' } });
  });
  await page.reload();
  await page.locator('.runtime-list').getByText('Edge · 085995c', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS 1.5 release UI, LAN Host/Origin checks, curated wizard import, compact phone labels, FPS default and library return focus.');
} finally {
  await browser?.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
