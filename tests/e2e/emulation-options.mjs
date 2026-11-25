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
  const legacy = await fetch(`${base}/api/games/${props.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { emulation: { locale: 'eu-ES' } } }),
  });
  assert.ok(legacy.ok);
  await p.goto(base + '/');
  await p.locator('.game-card', { hasText: props.name }).getByRole('button', { name: 'Game settings' }).click();
  await p.getByText('Game fonts', { exact: true }).click();
  await p.getByLabel('Font size medium').fill('30');
  await p.getByLabel('Font size small').fill('20');
  await p.getByLabel('Font size large').fill('40');
  await p.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await wait(async () => (await (await fetch(base + '/api/games/' + props.id)).json()).settings.emulation?.fontSizes?.large === 40, 'font options saved');
  await p.goto(base + '/play/' + props.id);
  await p.getByText('Game compatibility options', { exact: true }).waitFor();
  const language = p.getByRole('combobox', { name: 'Language of the phone' });
  assert.equal(await language.inputValue(), 'eu-ES', 'saved locale outside the dropdown list remains selected');
  await language.selectOption('ru-RU');
  await p.getByText('Game fullscreen', { exact: true }).click();
  assert.ok(await p.getByRole('checkbox', { name: 'Game fullscreen', exact: true }).isChecked());
  await p.getByText('Preload resources', { exact: true }).click();
  const touch = p.getByRole('checkbox', { name: 'Touch events' });
  assert.equal(await touch.isChecked(), false, 'the default keypad phone does not advertise touch');
  await p.getByText('Touch events', { exact: true }).click();
  await wait(async () => { const g = (await (await fetch(base + '/api/games')).json()).find((x) => x.id === props.id); return g.settings.emulation?.locale === 'ru-RU' && g.settings.emulation?.pointerEvents === true && g.settings.emulation?.preloadResources === true; }, 'options saved for the game');
  await p.locator('.ctrl-col').getByRole('button', { name: 'Start', exact: true }).click();
  await wait(async () => { const s = await running(); return s && (await (await fetch(base + '/api/sessions/' + s.id)).json()).logTail.some((l) => l.includes('PROPS locale=ru-RU pointer=true') && l.includes(`canvasHeight=${s.height}`)); }, 'the game sees the options and its canvas uses the full screen');
  const defaults = await running();
  assert.equal(defaults.frameRateLimit, null, 'default uses the emulator frame-rate policy');
  assert.doesNotMatch(readFileSync(path.join(dir, 'saves', 'default', props.id, 'midlets.ini'), 'utf8'), /^FrameRate=/m);
  for (const s of await (await fetch(base + '/api/sessions')).json()) await fetch(base + '/api/sessions/' + s.id, { method: 'DELETE' });
  await wait(async () => !(await running()), 'stopped');

  await p.reload();
  await p.getByText('Game compatibility options', { exact: true }).waitFor();
  await wait(async () => (await p.getByLabel('Language of the phone').inputValue()) === 'ru-RU', 'saved options are shown after a reload');
  await p.getByRole('button', { name: 'Reset options' }).click();
  await wait(async () => { const g = (await (await fetch(base + '/api/games')).json()).find((x) => x.id === props.id); return JSON.stringify(g.settings.emulation) === JSON.stringify({ fontSizes: { small: 20, medium: 30, large: 40 } }); }, 'compatibility defaults restored without changing fonts');

  await p.route('**/api/system/resources', route => route.fulfill({ json: {
    cpuPercent: 4.8, memoryBytes: 204 * 1024 ** 2, memoryLimitBytes: 1536 * 1024 ** 2
  } }));

  // ---- game speed ----
  const game = await upload('tests/fixtures/labgames/build/kemgame.jar');
  const phone = await fetch(`${base}/api/games/${game.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { skinId: 'sony-ericsson-k790i' } }),
  });
  assert.ok(phone.ok);
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto(base + '/play/' + game.id);
  const panel = p.locator('.ctrl-col');
  await panel.getByTestId('change-phone').getByText('K790i', { exact: true }).waitFor();
  await p.getByRole('radio', { name: 'Screen', exact: true }).click();
  const toolbar = p.locator('.stage-bar');
  const toolbarFits = () => toolbar.evaluate(bar => {
    const bounds = bar.getBoundingClientRect();
    const buttons = bar.querySelectorAll('.stage-left > button, .stage-view > *, .stage-status > *, .stage-tools > *');
    return bounds.height <= 54 && [...buttons].every(button => {
      const rect = button.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right && Math.abs((rect.top + rect.bottom - bounds.top - bounds.bottom) / 2) < 3;
    });
  });
  for (const language of ['RU', 'EN']) {
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
    const fits = await panel.evaluate(el => {
      const panel = el.getBoundingClientRect();
      const groups = [...el.querySelectorAll('.player-chips')];
      const oneLine = groups.every(group => new Set([...group.children].map(chip => chip.getBoundingClientRect().top)).size === 1 && group.scrollWidth <= group.clientWidth + 1);
      return { bottom: panel.bottom, height: innerHeight, documentHeight: document.documentElement.scrollHeight, nested: getComputedStyle(el).overflowY === 'auto', oneLine };
    });
    assert.ok(fits.bottom <= fits.height && fits.documentHeight <= fits.height + 1 && !fits.nested && fits.oneLine, `compact side panel fits at Full HD in ${language}: ${JSON.stringify(fits)}`);
    assert.ok(await toolbarFits(), `the player toolbar is one line at Full HD in ${language}`);
    assert.equal(await panel.getByText('Game files', { exact: true }).count(), 0);
  }
  const frameLimitButton = p.locator('.stage-fps-limit summary');
  await frameLimitButton.click();
  const limits = p.getByRole('radiogroup', { name: 'Frame limit (fps)' });
  assert.deepEqual(await limits.getByRole('radio').allTextContents(), ['Default', '30', '60']);
  await limits.getByRole('radio', { name: '30 FPS limit' }).click();
  await p.locator('.ctrl-col').getByRole('button', { name: 'Start', exact: true }).click();
  await wait(async () => (await running())?.framesReceived > 5, 'game drawing');
  const first = await running();
  assert.equal(first.frameRateLimit, 30);
  await p.locator('.stage').focus();
  await p.keyboard.press('ArrowLeft');
  assert.ok(await p.locator('.stage').evaluate(el => document.activeElement === el && getComputedStyle(el).outlineStyle === 'none'), 'the keyboard keeps focus on the phone without drawing an outline');
  for (const [width, height] of [[1920, 1080], [1536, 864]]) {
    await p.setViewportSize({ width, height });
    assert.ok(await toolbarFits(), `the running player toolbar stays in one row at ${width}×${height}`);
    await p.getByRole('radio', { name: 'Phone', exact: true }).click();
    assert.ok(await p.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), `running player fits ${width}×${height}`);
    await p.getByRole('radio', { name: 'Screen', exact: true }).click();
  }
  await p.setViewportSize({ width: 1920, height: 1080 });
  const firstGame = await (await fetch(base + '/api/games/' + game.id)).json();
  assert.deepEqual(firstGame.playedResolution, { width: first.width, height: first.height, source: 'played' });
  await frameLimitButton.click();
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
  const handset = (id, skinId) => fetch(`${base}/api/games/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { skinId, profileMode: 'auto' } }),
  });
  assert.ok((await handset(padded.id, 'siemens-s65')).ok);
  await p.goto(base + '/play/' + padded.id);
  await panel.getByTestId('change-phone').getByText('S65', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Start', exact: true }).click();
  await wait(async () => (await running())?.framesReceived > 5, 'the larger game draws on the S65');
  const clipped = await (await fetch(base + '/api/games/' + padded.id)).json();
  assert.deepEqual(clipped.playedResolution, { width: 132, height: 176, source: 'played' });
  assert.equal(clipped.nativeResolution, undefined, 'a clipped picture is not evidence of the native resolution');
  await panel.getByRole('button', { name: 'Stop', exact: true }).click();
  await p.getByTestId('state-badge').filter({ hasText: 'exited' }).waitFor();
  await p.locator('.stage-left').getByRole('button', { name: 'Library' }).click();
  await p.waitForURL(base + '/');
  await p.locator(`[data-library-group="${padded.groupKey}"]`).getByLabel('Native resolution unknown').waitFor();
  assert.match(await p.getByTestId('phone-resolution-filter').innerText(), /132×176/);
  assert.ok((await handset(padded.id, 'sony-ericsson-k790i')).ok);
  await p.goto(base + '/play/' + padded.id);
  await panel.getByRole('progressbar', { name: 'Memory' }).waitFor();
  await panel.getByRole('button', { name: 'Start', exact: true }).click();
  await p.getByTestId('game-resolution').filter({ hasText: '176×220' }).waitFor();
  assert.equal(await p.getByTestId('frame-size').innerText(), '240×320');
  const recommendation = p.getByTestId('phone-suggestion');
  assert.match(await recommendation.innerText(), /Better screen fit/);
  await p.getByTestId('phone-suggestion-switch').click();
  await wait(async () => {
    const g = await (await fetch(base + '/api/games/' + padded.id)).json();
    return g.settings.width === 176 && g.settings.height === 220;
  }, 'the suggested handset applies its screen size');
  await panel.getByRole('button', { name: 'Restart with selected profile' }).click();
  await wait(async () => (await running())?.width === 176, 'restarted at the native resolution');
  await p.getByTitle('Game and emulator resolution', { exact: true }).waitFor();
  assert.equal(await p.locator('.player-chips').filter({ has: p.getByTestId('game-resolution') }).getByText('176×220', { exact: true }).count(), 1);
  await p.locator('.stage-left').getByRole('button', { name: 'Library' }).click();
  await p.locator('.game-card', { hasText: 'Small viewport' }).locator('.resolution-tag:visible').filter({ hasText: '176×220' }).first().waitFor();
  const withIcon = await upload('tests/fixtures/labgames/build/kemicon.jar');
  await p.goto(base + '/play/' + withIcon.id);
  await wait(() => p.getByTestId('player-game-icon').evaluate(img => img.naturalWidth > 0), 'the player uses the embedded JAR icon');
  assert.equal(await p.getByTestId('player-game-icon').getAttribute('src'), `/api/games/${withIcon.id}/icon?v=2`);
  assert.equal(await p.getByTestId('screenshot').evaluate(button => button.nextElementSibling?.dataset.testid), 'screenshot-copy');
  assert.deepEqual(errors, []);
  console.log('emulation options e2e OK');
} finally {
  await browser?.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 800)); // the emulator may still be writing its log
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp dir: not worth hiding the real result */ }
}
