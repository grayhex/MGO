// Real API + KEmulator + Chromium: per-game compatibility options and the game speed control.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const dir = mkdtempSync(path.join(tmpdir(), 'mgo-emu-'));
const port = 21600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const server = spawn('node', ['apps/api/dist/server.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', LOG_LEVEL: 'warn' }, stdio: ['ignore', 'inherit', 'inherit'] });
let browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, what) => { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error(`timeout: ${what}`); };
const upload = async (file) => {
  const fd = new FormData();
  fd.append('jar', new Blob([typeof file === 'string' ? readFileSync(file) : file]), typeof file === 'string' ? path.basename(file) : 'padded.jar');
  const r = await fetch(base + '/api/games', { method: 'POST', body: fd });
  assert.equal(r.status, 201);
  return (await r.json()).game;
};
const running = async () => (await (await fetch(base + '/api/sessions')).json()).find((x) => x.state === 'running');

try {
  await wait(async () => (await fetch(base + '/api/health')).ok, 'server');
  await fetch(base + '/api/setup/skip', { method: 'POST' });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const p = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  // ---- options are saved for the game and reach it ----
  const props = await upload('tests/fixtures/labgames/build/kemprops.jar');
  await p.goto(base + '/play/' + props.id);
  await p.getByText('Game compatibility options', { exact: true }).click();
  await p.getByLabel('Language of the phone').fill('ru-RU');
  await p.getByLabel('Font size medium').fill('30');
  await p.getByLabel('Font size small').fill('20');
  await p.getByLabel('Font size large').fill('40');
  await p.getByText('Preload resources', { exact: true }).click();
  const touch = p.getByRole('checkbox', { name: 'Touch events' });
  assert.equal(await touch.isChecked(), false, 'the default keypad phone does not advertise touch');
  await p.getByText('Touch events', { exact: true }).click();
  await wait(async () => { const g = (await (await fetch(base + '/api/games')).json()).find((x) => x.id === props.id); return g.settings.emulation?.locale === 'ru-RU' && g.settings.emulation?.pointerEvents === true && g.settings.emulation?.preloadResources === true; }, 'options saved for the game');
  await p.locator('.ctrl-col').getByRole('button', { name: 'Start', exact: true }).click();
  await wait(async () => { const s = await running(); return s && (await (await fetch(base + '/api/sessions/' + s.id)).json()).logTail.some((l) => /PROPS locale=ru-RU pointer=true/.test(l)); }, 'the game sees the options');
  const defaults = await running();
  assert.equal(defaults.frameRateLimit, null, 'default uses the emulator frame-rate policy');
  assert.doesNotMatch(readFileSync(path.join(dir, 'saves', 'default', props.id, 'midlets.ini'), 'utf8'), /^FrameRate=/m);
  for (const s of await (await fetch(base + '/api/sessions')).json()) await fetch(base + '/api/sessions/' + s.id, { method: 'DELETE' });
  await wait(async () => !(await running()), 'stopped');

  await p.reload();
  await p.getByText('Game compatibility options', { exact: true }).click();
  await wait(async () => (await p.getByLabel('Language of the phone').inputValue()) === 'ru-RU', 'saved options are shown after a reload');
  await p.getByRole('button', { name: 'Reset options' }).click();
  await wait(async () => { const g = (await (await fetch(base + '/api/games')).json()).find((x) => x.id === props.id); return g.settings.emulation === undefined; }, 'defaults restored');

  await p.route('**/api/system/resources', route => route.fulfill({ json: {
    cpuPercent: 4.8, memoryBytes: 204 * 1024 ** 2, memoryLimitBytes: 1536 * 1024 ** 2
  } }));

  // ---- game speed ----
  const game = await upload('tests/fixtures/labgames/build/kemgame.jar');
  await p.setViewportSize({ width: 1280, height: 720 });
  await p.goto(base + '/play/' + game.id);
  const panel = p.locator('.ctrl-col');
  for (const [language, label] of [['RU', 'Ограничение кадров (fps)'], ['EN', 'Frame limit (fps)']]) {
    await panel.locator('.seg.lang').getByRole('radio', { name: language }).click();
    await panel.locator('.resource-meters').getByText('4.8%').waitFor();
    const row = await panel.locator('.resource-meters').evaluate(meters =>
      [...meters.children].map(meter => {
        const label = document.createRange();
        label.selectNodeContents(meter.querySelector('span'));
        const value = document.createRange();
        value.selectNodeContents(meter.querySelector('b'));
        const left = label.getBoundingClientRect();
        const right = value.getBoundingClientRect();
        return Math.abs(left.top - right.top) < 2 && left.right <= right.left;
      })
    );
    assert.deepEqual(row, [true, true], `resource labels fit on one line in ${language}`);
    const fps = panel.getByRole('radiogroup', { name: label, exact: true });
    await fps.waitFor();
    assert.deepEqual((await fps.getByRole('radio').allTextContents()).slice(-2), ['30', '60']);
    const fits = await panel.evaluate(el => {
      const panel = el.getBoundingClientRect();
      const fps = el.querySelector('.player-seg').getBoundingClientRect();
      return { bottom: panel.bottom, height: innerHeight, fpsRight: fps.right, panelRight: panel.right, fpsHeight: fps.height };
    });
    assert.ok(fits.bottom <= fits.height && fits.fpsRight < fits.panelRight && fits.fpsHeight < 38, `compact side panel fits at 1280×720 in ${language}: ${JSON.stringify(fits)}`);
    assert.equal(await panel.getByText('Game files', { exact: true }).count(), 0);
  }
  const limits = p.getByRole('radiogroup', { name: 'Frame limit (fps)' });
  await limits.getByRole('radio', { name: '30 FPS limit' }).click();
  await p.locator('.ctrl-col').getByRole('button', { name: 'Start', exact: true }).click();
  await wait(async () => (await running())?.framesReceived > 5, 'game drawing');
  const first = await running();
  assert.equal(first.frameRateLimit, 30);
  const firstGame = await (await fetch(base + '/api/games/' + game.id)).json();
  assert.deepEqual(firstGame.playedResolution, { width: first.width, height: first.height, source: 'played' });
  await limits.getByRole('radio', { name: '60 FPS limit' }).click();
  await p.getByText('Restart to apply the frame limit.').waitFor();
  assert.equal((await running()).id, first.id, 'choosing a limit keeps the game running');
  await p.locator('.ctrl-col').getByRole('button', { name: 'Restart', exact: true }).click();
  await wait(async () => { const s = await running(); return s?.id !== first.id && s?.frameRateLimit === 60 && s.framesReceived > 5; }, '60 FPS applied on restart');
  assert.match(readFileSync(path.join(dir, 'saves', 'default', game.id, 'midlets.ini'), 'utf8'), /FrameRate=60/);
  assert.match(readFileSync(path.join(dir, 'saves', 'default', game.id, 'midlets.ini'), 'utf8'), /PatchYield=true/);
  await p.getByRole('radio', { name: '×0.5', exact: true }).click();
  await wait(async () => (await running()).speed === -50, 'half speed');
  await wait(async () => (await p.getByRole('radio', { name: '×0.5', exact: true }).getAttribute('aria-checked')) === 'true', 'the control shows the speed');
  await p.getByRole('radio', { name: '×2', exact: true }).click();
  await wait(async () => (await running()).speed === 2, 'double speed');
  await p.reload();
  await p.getByRole('radio', { name: '×2', exact: true }).waitFor();
  await wait(async () => (await p.getByRole('radio', { name: '×2', exact: true }).getAttribute('aria-checked')) === 'true', 'speed shown after a reload');
  await panel.getByRole('button', { name: 'Stop', exact: true }).click();
  await wait(async () => !(await running()), 'first game stopped');
  const files = unzipSync(readFileSync('tests/fixtures/testmidlet/build/kemtest.jar'));
  const manifest = 'META-INF/MANIFEST.MF';
  files[manifest] = strToU8(strFromU8(files[manifest])
    .replace('MIDlet-Name: KemTest', 'MIDlet-Name: Small viewport')
    .replace('MIDlet-1: KemTest, , kemtest.KemTest', 'MIDlet-1: Small viewport, , MissingMain\r\nMGO-Padded-Test: true'));
  const padded = await upload(zipSync(files));
  assert.equal(padded.nativeResolution, undefined);
  await p.goto(base + '/play/' + padded.id);
  await panel.getByRole('progressbar', { name: 'Memory' }).waitFor();
  await panel.getByRole('button', { name: 'Start', exact: true }).click();
  await p.getByTestId('game-resolution').filter({ hasText: 'Game 176×220' }).waitFor();
  const recommendation = p.getByTestId('phone-suggestion');
  assert.match(await recommendation.innerText(), /Game 176×220 · Emulator 240×320/);
  await p.getByTestId('phone-suggestion-switch').click();
  await wait(async () => {
    const g = await (await fetch(base + '/api/games/' + padded.id)).json();
    return g.settings.width === 176 && g.settings.height === 220;
  }, 'the suggested handset applies its screen size');
  await p.locator('.stage-left').getByRole('button', { name: 'Library' }).click();
  await p.locator('.game-card', { hasText: 'Small viewport' }).locator('.resolution-tag:visible').filter({ hasText: '176×220' }).first().waitFor();
  assert.deepEqual(errors, []);
  console.log('emulation options e2e OK');
} finally {
  await browser?.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 800)); // the emulator may still be writing its log
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp dir: not worth hiding the real result */ }
}
