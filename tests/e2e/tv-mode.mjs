import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const dir = mkdtempSync(path.join(tmpdir(), 'mgo-tv-'));
const port = 19400 + Math.floor(Math.random() * 250);
const base = `http://127.0.0.1:${port}`;
const server = spawn('node', ['apps/api/dist/server.js'], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 150; i++) {
    if (await Promise.resolve().then(check).catch(() => false)) return;
    await delay(100);
  }
  throw new Error(message);
}
const screenshotDir = process.env.MGO_TV_SCREENSHOTS;
async function shot(page, name) {
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), animations: 'disabled' });
  }
}

const padIndex = { up: 12, down: 13, left: 14, right: 15, fire: 0, menu: 9, back: 8 };
const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
async function pad(page, key) {
  await page.evaluate(index => { window.tvButtons = [index]; }, padIndex[key]);
  await frames(page);
  await page.evaluate(() => { window.tvButtons = []; });
  await frames(page);
}
const phoneVolumeUp = page => page.keyboard.press('Control+Alt+Shift+KeyP');

// The browser geometry determines a sequence of real controller direction presses.
// This keeps the flow independent of the number of columns at each tested resolution.
async function focusWith(page, selector, drive) {
  const route = await page.evaluate(selector => {
    const desired = document.querySelector(selector);
    const focused = document.activeElement;
    const scope = document.querySelector('.tv-dialog') ?? document.querySelector('.tv-body');
    const items = [...scope.querySelectorAll('button:not(:disabled),a[href],summary,select,input,textarea,[data-tv-focus]')]
      .filter(el => !el.closest('[inert],[hidden]') && el.getClientRects().length && getComputedStyle(el).visibility === 'visible');
    const start = items.indexOf(focused);
    const end = items.indexOf(desired);
    if (start < 0 || end < 0) throw Error(`Missing focus: ${focused?.textContent}; target: ${selector}`);
    const box = items.map(el => el.getBoundingClientRect());
    const edge = (from, horizontal, sign) => {
      const a = box[from];
      let best = -1;
      let distance = Infinity;
      for (let i = 0; i < box.length; i++) {
        if (i === from) continue;
        const b = box[i];
        const dx = (b.left + b.right - a.left - a.right) / 2;
        const dy = (b.top + b.bottom - a.top - a.bottom) / 2;
        const primary = (horizontal ? dx : dy) * sign;
        const secondary = Math.abs(horizontal ? dy : dx);
        const cross = horizontal ? Math.max(0, a.top - b.bottom, b.top - a.bottom) : Math.max(0, a.left - b.right, b.left - a.right);
        const score = primary + .45 * secondary + 3 * cross;
        if (primary > 2 && score < distance) { best = i; distance = score; }
      }
      return best;
    };
    const seen = new Set([start]);
    const todo = [{ index: start, keys: [] }];
    for (const { index, keys } of todo) {
      if (index === end) return keys;
      for (const [name, horizontal, sign] of [['up', false, -1], ['down', false, 1], ['left', true, -1], ['right', true, 1]]) {
        const next = edge(index, horizontal, sign);
        if (next < 0 || seen.has(next)) continue;
        seen.add(next);
        todo.push({ index: next, keys: [...keys, name] });
      }
    }
    throw Error(`Unreachable controller target ${selector} from ${focused.textContent}`);
  }, selector);
  for (const key of route) await drive(key);
  assert.equal(await page.evaluate(selector => document.activeElement === document.querySelector(selector), selector), true, selector);
}
const openBy = async (page, selector, drive) => { await focusWith(page, selector, drive); await drive('fire'); };
const tile = game => `[data-tv-game="j2me:${game.groupKey}"]`;

let browser;
try {
  await until(async () => (await fetch(base + '/api/health')).ok, 'API did not start');
  await fetch(base + '/api/setup/skip', { method: 'POST' });
  const fixtures = ['tests/fixtures/testmidlet/build/kemtest.jar', 'tests/fixtures/testmidlet/build/kemtest2.jar'];
  const games = [];
  for (const fixture of fixtures) {
    const body = new FormData();
    body.append('jar', new Blob([readFileSync(fixture)]), path.basename(fixture));
    const response = await fetch(base + '/api/games', { method: 'POST', body });
    assert.equal(response.status, 201);
    games.push((await response.json()).game);
  }
  const [first, second] = games;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const tv = await browser.newPage({ viewport: { width: 3840, height: 2160 }, deviceScaleFactor: 1 });
  const errors = [];
  tv.on('pageerror', error => errors.push(error.message));
  await tv.addInitScript(() => {
    window.tvButtons = [];
    localStorage.setItem('mgo.tv.display', 'clean'); // saved by previous TV Mode releases
    Object.defineProperty(navigator, 'getGamepads', { value: () => [{
      id: 'TV test pad', index: 0, mapping: 'standard', connected: true, axes: [0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: window.tvButtons.includes(i), value: Number(window.tvButtons.includes(i)) })),
    }] });
  });
  await tv.goto(base + '/tv');
  await tv.locator(tile(first)).waitFor();
  await tv.waitForFunction(() => document.activeElement?.textContent.trim() === 'Search games');
  assert.equal(await tv.getByRole('dialog').count(), 0, 'TV opens directly to the library');
  const legacySockets = await tv.evaluate(() => Promise.all(['relay', 'remote'].map(path => new Promise(resolve => {
    const socket = new WebSocket(`ws://${location.host}/api/tv/${path}`);
    socket.onopen = () => { socket.close(); resolve(true); };
    socket.onerror = () => resolve(false);
  }))));
  assert.deepEqual(legacySockets, [false, false]);

  await phoneVolumeUp(tv);
  assert.equal(await tv.evaluate(() => document.activeElement?.textContent.trim()), 'Search games');
  assert.equal(await tv.getByRole('dialog').count(), 0);
  await shot(tv, 'tv-library-4k');
  assert.ok(await tv.evaluate(() => document.documentElement.scrollWidth === innerWidth));

  const usingPad = key => pad(tv, key);
  await openBy(tv, tile(first), usingPad);
  await tv.getByRole('heading', { name: first.name }).waitFor();
  await shot(tv, 'tv-card-4k');
  await frames(tv);
  await openBy(tv, '.tv-details .tv-actions button:nth-child(2)', usingPad);
  await tv.getByRole('dialog', { name: 'Choose a phone' }).waitFor();
  await tv.locator('.tv-phone-grid button').first().waitFor();
  await openBy(tv, '.tv-phone-grid button:nth-child(3)', usingPad);
  await tv.getByRole('dialog', { name: 'Choose a phone' }).waitFor({ state: 'hidden' });
  await frames(tv);
  await openBy(tv, '.tv-details [data-tv-prefer]', usingPad);
  const status = async () => {
    const sessions = await fetch(base + '/api/sessions').then(response => response.json());
    const instance = sessions.find(item => item.state === 'running');
    return instance && fetch(base + '/api/sessions/' + instance.id).then(response => response.json());
  };
  async function presses(code) {
    const running = await status();
    return running?.logTail.filter(line => line.includes(`KEY_DOWN ${code}`)).length ?? 0;
  }
  await until(async () => (await status())?.gameId === first.id, 'First game did not start');
  const darkSkin = tv.locator('.tv-player.tv-lights-out .skin-box[data-view="screen"]');
  const checkDimmedPhone = () => tv.waitForFunction(() => {
    const stage = document.querySelector('.tv-lights-out .stage');
    const image = document.querySelector('.tv-lights-out .skin-body');
    const canvas = document.querySelector('.tv-lights-out .skin-lcd canvas');
    return image?.complete && image.naturalWidth > 0 && getComputedStyle(image).opacity === '0.36' &&
      canvas && getComputedStyle(canvas).opacity === '1' && getComputedStyle(stage).backgroundImage.startsWith('radial-gradient');
  });
  await checkDimmedPhone();
  for (let i = 0; i < 8 && !(await presses(-5)); i++) { await usingPad('fire'); await delay(150); }
  assert.ok(await presses(-5), 'pad input reaches KEmulator');
  await shot(tv, 'tv-game-4k');

  const menu = tv.getByRole('dialog', { name: 'TV menu' });
  await usingPad('menu');
  await menu.waitFor();
  await shot(tv, 'tv-menu-4k');
  await frames(tv);
  await openBy(tv, '.tv-dialog-menu .tv-setting .tv-actions button:last-child', usingPad);
  await usingPad('back');
  await menu.waitFor({ state: 'hidden' });
  const bareCanvas = tv.locator('.tv-player .player-bare-screen canvas');
  await bareCanvas.waitFor();
  const lcd = await bareCanvas.evaluate(canvas => ({ width: canvas.clientWidth, height: canvas.clientHeight, w: canvas.width, h: canvas.height }));
  assert.equal(lcd.width / lcd.w, lcd.height / lcd.h);
  assert.equal(lcd.width % lcd.w, 0);
  assert.equal(await darkSkin.count(), 0, 'Game only is a separate display setting');

  const sameSession = (await status()).id;
  await usingPad('menu');
  await menu.getByRole('button', { name: 'Lights Out', exact: true }).click();
  await usingPad('back');
  await menu.waitFor({ state: 'hidden' });
  await checkDimmedPhone();
  assert.equal((await status()).id, sameSession, 'restoring the handset keeps the current game');

  const stopSelector = '.tv-dialog-menu > .tv-actions:last-child button:first-child';
  const stopGame = async game => {
    await openBy(tv, stopSelector, usingPad);
    await tv.getByRole('dialog', { name: 'Stop game?' }).waitFor();
    await frames(tv);
    await openBy(tv, '.tv-dialog-confirm > button', usingPad);
    await tv.locator(tile(game)).waitFor();
    await tv.waitForFunction(selector => document.activeElement === document.querySelector(selector), tile(game));
  };
  await usingPad('menu');
  await menu.waitFor();
  await frames(tv);
  await stopGame(first);
  console.log('PASS: 4K TV library, gamepad navigation, dimmed phone, integer scaling in Game only and restored focus');

  await tv.setViewportSize({ width: 1920, height: 1080 });
  await openBy(tv, '.tv-head .tv-actions button:first-child', usingPad);
  const search = tv.getByRole('dialog', { name: 'Search games' });
  await search.waitFor();
  await frames(tv);
  await openBy(tv, '.tv-dialog-search .tv-letters button:first-child', usingPad);
  await search.getByRole('status').filter({ hasText: '1' }).waitFor();
  await openBy(tv, '.tv-dialog-search .tv-keyboard .tv-actions button:nth-last-child(2)', usingPad);
  await search.getByRole('status').filter({ hasText: 'Search games' }).waitFor();
  await usingPad('back');
  await search.waitFor({ state: 'hidden' });
  await frames(tv);
  await openBy(tv, tile(second), usingPad);
  await tv.getByRole('heading', { name: second.name }).waitFor();
  await frames(tv);
  await openBy(tv, '.tv-details [data-tv-prefer]', usingPad);
  await until(async () => (await status())?.gameId === second.id, 'Second game did not start');
  await tv.waitForFunction(() => document.activeElement?.classList.contains('stage'));

  await checkDimmedPhone();
  await shot(tv, 'tv-game-1080p');
  for (const [key, code] of [['ArrowUp', -1], ['ArrowLeft', -3], ['ArrowDown', -2], ['ArrowRight', -4], ['Enter', -5], ['KeyZ', 35]]) {
    const initial = await presses(code);
    await tv.keyboard.press(key);
    await until(async () => (await presses(code)) > initial, `Sony Ericsson ${key} did not reach the game`);
  }
  await usingPad('menu');
  await menu.waitFor();
  await tv.waitForFunction(() => document.activeElement?.textContent.trim() === 'Resume');
  await phoneVolumeUp(tv);
  assert.equal(await tv.evaluate(() => document.activeElement?.textContent.trim()), 'Resume');
  await stopGame(second);
  await usingPad('menu');
  await menu.waitFor();
  await frames(tv);
  await openBy(tv, '.tv-dialog-menu > .tv-actions:last-child button:last-child', usingPad);
  await tv.waitForURL(base + '/');
  await tv.getByRole('link', { name: 'TV Mode' }).waitFor();

  const scaled = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  await scaled.goto(base + '/tv');
  await scaled.locator(tile(second)).waitFor();
  assert.ok(await scaled.evaluate(() => devicePixelRatio === 2 && document.documentElement.scrollWidth === innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: 1080p/DPR 2 layout, gamepad search and exit, Sony Ericsson arrow keys reach the emulator');
} finally {
  await browser?.close();
  const stopped = once(server, 'exit');
  const forceStop = setTimeout(() => server.kill('SIGKILL'), 5000);
  server.kill('SIGTERM');
  await stopped;
  clearTimeout(forceStop);
  rmSync(dir, { recursive: true, force: true });
}
