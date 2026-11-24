// Real API + Chromium: install and remove a MIDI SoundFont in Settings → Sound.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const dir = mkdtempSync(path.join(tmpdir(), 'mgo-sf-e2e-'));
const port = 20900 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const server = spawn('node', ['apps/api/dist/server.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', LOG_LEVEL: 'warn' }, stdio: ['ignore', 'inherit', 'inherit'] });
let browser;
const wait = async (fn, what) => { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw Error(`timeout: ${what}`); };
try {
  await wait(async () => (await fetch(base + '/api/health')).ok, 'server');
  await fetch(base + '/api/setup/skip', { method: 'POST' });
  const sf2 = Buffer.alloc(4096);
  sf2.write('RIFF', 0, 'latin1'); sf2.writeUInt32LE(4096 - 8, 4); sf2.write('sfbk', 8, 'latin1');

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const p = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base + '/settings#sound');
  await p.getByText('MIDI SoundFont', { exact: true }).waitFor();
  assert.equal(await p.getByLabel('MIDI SoundFont').inputValue(), '');

  await p.locator('input[type=file][accept=".sf2"]').setInputFiles({ name: 'room.sf2', mimeType: 'application/octet-stream', buffer: sf2 });
  await p.getByLabel('MIDI SoundFont').locator('option', { hasText: /room\.sf2/ }).waitFor({ state: 'attached' });
  assert.equal((await (await fetch(base + '/api/settings')).json()).soundfont.name, 'room.sf2');

  await p.locator('input[type=file][accept=".sf2"]').setInputFiles({ name: 'broken.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from('nope') });
  await p.getByText(/too small to be a SoundFont/i).waitFor();
  assert.equal((await (await fetch(base + '/api/settings')).json()).soundfont.name, 'room.sf2', 'a rejected file keeps the installed bank');

  const bank = p.getByLabel('MIDI SoundFont');
  await p.locator('input[type=file][accept=".sf2"]').setInputFiles({ name: 'hall.sf2', mimeType: 'application/octet-stream', buffer: sf2 });
  await bank.locator('option', { hasText: /hall\.sf2/ }).waitFor({ state: 'attached' });
  assert.equal(await bank.locator('option').count(), 3, 'both custom banks are available');
  await bank.selectOption({ label: 'room.sf2 · 0.0 MB' });
  await p.getByText('SoundFont selected for the next launch.', { exact: true }).waitFor();
  assert.equal((await (await fetch(base + '/api/settings')).json()).soundfont.name, 'room.sf2');
  await bank.selectOption('');
  await p.getByText('Back to the built-in bank.', { exact: true }).waitFor();
  assert.equal((await (await fetch(base + '/api/settings')).json()).soundfont, null);
  assert.equal(await bank.locator('option').count(), 3);
  await bank.selectOption({ label: 'room.sf2 · 0.0 MB' });
  await p.getByRole('button', { name: 'Remove', exact: true }).click();
  await p.getByLabel('MIDI SoundFont').locator('option', { hasText: /room\.sf2/ }).waitFor({ state: 'detached' });
  assert.equal(await p.getByLabel('MIDI SoundFont').inputValue(), '');
  assert.equal((await (await fetch(base + '/api/settings')).json()).soundfont, null);
  assert.deepEqual(errors, []);
  console.log('soundfont e2e OK');
} finally {
  await browser?.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 800)); // the emulator may still be writing its log
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp dir: not worth hiding the real result */ }
}
