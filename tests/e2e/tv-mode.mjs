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

const padIndex = { up: 12, down: 13, left: 14, right: 15, fire: 0, menu: 9, back: 8, lb: 4, rb: 5 };
function installGamepad() {
  window.tvButtons = [];
  window.rightStick = 0;
  Object.defineProperty(navigator, 'getGamepads', { value: () => [{
    id: 'TV test pad', index: 0, mapping: 'standard', connected: true, axes: [0, 0, 0, window.rightStick],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: window.tvButtons.includes(i), value: Number(window.tvButtons.includes(i)) })),
  }] });
}
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
      const row = horizontal && items[from].closest('[data-tv-row]');
      let best = -1;
      let distance = Infinity;
      for (let i = 0; i < box.length; i++) {
        if (i === from || (row && !row.contains(items[i]))) continue;
        const b = box[i];
        const dx = (b.left + b.right - a.left - a.right) / 2;
        const dy = (b.top + b.bottom - a.top - a.bottom) / 2;
        const primary = (horizontal ? dx : dy) * sign;
        const secondary = Math.abs(horizontal ? dy : dx);
        const cross = horizontal ? Math.max(0, a.top - b.bottom, b.top - a.bottom) : Math.max(0, a.left - b.right, b.left - a.right);
        const score = primary + .45 * secondary + 3 * cross;
        if (primary > 2 && (!row || cross <= 2) && score < distance) { best = i; distance = score; }
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
  await tv.addInitScript(installGamepad);
  await tv.addInitScript(() => localStorage.setItem('mgo.tv.display', 'screen'));
  await tv.goto(base + '/tv');
  await tv.locator(tile(first)).waitFor();
  await tv.waitForFunction(() => document.activeElement?.matches('.tv-spotlight-cards .tv-game-tile'));
  assert.equal(await tv.getByRole('button', { name: 'Home', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await tv.getByRole('dialog').count(), 0, 'TV opens directly to the dashboard');
  const legacySockets = await tv.evaluate(() => Promise.all(['relay', 'remote'].map(path => new Promise(resolve => {
    const socket = new WebSocket(`ws://${location.host}/api/tv/${path}`);
    socket.onopen = () => { socket.close(); resolve(true); };
    socket.onerror = () => resolve(false);
  }))));
  assert.deepEqual(legacySockets, [false, false]);

  const usingPad = key => pad(tv, key);
  const initialHighlight = await tv.locator('.tv-spotlight-title h1').textContent();
  await usingPad('right');
  const focus = await tv.evaluate(() => ({
    label: document.activeElement?.textContent,
    game: document.activeElement?.querySelector('strong')?.textContent,
    tiles: Array.from(document.querySelectorAll('.tv-spotlight-cards .tv-game-tile strong'), tile => tile.textContent),
  }));
  assert.ok(focus.game && focus.tiles.includes(focus.game) && focus.game !== initialHighlight, JSON.stringify(focus));
  assert.equal(await tv.locator('.tv-spotlight-title h1').textContent(), focus.game);
  await phoneVolumeUp(tv);
  assert.equal(await tv.getByRole('dialog').count(), 0);
  await openBy(tv, tile(first), usingPad);
  await tv.waitForFunction(() => document.activeElement?.textContent.trim() === 'Play');
  await usingPad('right');
  assert.equal(await tv.evaluate(() => document.activeElement?.textContent.trim()), 'Choose a phone');
  await usingPad('back');
  const currentTab = await tv.locator('.tv-nav [aria-current="page"]').textContent();
  assert.equal(currentTab, 'Library', await tv.locator('.tv-body main').getAttribute('class'));
  await tv.locator('.tv-grid ' + tile(first)).waitFor();
  await tv.waitForFunction(selector => document.activeElement === document.querySelector(selector), tile(first));
  await shot(tv, 'tv-library-4k');
  assert.ok(await tv.evaluate(() => document.documentElement.scrollWidth === innerWidth));

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
    const background = stage && getComputedStyle(stage);
    return image?.complete && image.naturalWidth > 0 && getComputedStyle(image).opacity === '0.36' &&
      canvas && getComputedStyle(canvas).opacity === '1' && background?.backgroundImage === 'none' &&
      background.backgroundColor === 'rgb(0, 0, 0)';
  });
  await checkDimmedPhone();
  assert.equal(await tv.evaluate(() => localStorage.getItem('mgo.tv.display')), 'screen', 'legacy Screen is read as Lights Out');
  await tv.waitForFunction(() => document.activeElement?.classList.contains('stage'));
  for (const [button, code] of [['fire', 53], ['up', 50], ['left', 52], ['right', 54], ['down', 56], ['lb', -6], ['rb', -7]]) {
    const initial = await presses(code);
    await usingPad(button);
    await until(async () => (await presses(code)) > initial, `${button} sends phone key ${code}`);
  }
  await shot(tv, 'tv-game-4k');

  const menu = tv.getByRole('dialog', { name: 'TV menu' });
  await usingPad('menu');
  await menu.waitFor();
  await until(async () => (await status())?.paused, 'TV menu suspends the running game');
  await delay(200);
  const frozen = (await status()).framesReceived;
  await delay(350);
  assert.equal((await status()).framesReceived, frozen, 'the emulator stops drawing while the menu is open');
  const display = menu.getByRole('group', { name: 'Display' });
  assert.deepEqual(await display.getByRole('button').allTextContents(), ['Phone', 'Lights Out', 'Game only']);
  await shot(tv, 'tv-menu-4k');
  await menu.getByRole('button', { name: 'Mute', exact: true }).click();
  assert.equal(await menu.getByRole('button', { name: 'Mute', exact: true }).getAttribute('aria-pressed'), 'true');
  await display.getByRole('button', { name: 'Phone', exact: true }).click();
  await usingPad('back');
  await menu.waitFor({ state: 'hidden' });
  await until(async () => !(await status())?.paused && (await status())?.framesReceived > frozen, 'closing TV menu resumes the same game');
  await tv.locator('.tv-player .skin-box[data-view="full"]').waitFor();
  assert.deepEqual(await tv.locator('.tv-player .stage').evaluate(el => {
    const css = getComputedStyle(el);
    return [css.backgroundColor, css.backgroundImage];
  }), ['rgb(0, 0, 0)', 'none']);
  await usingPad('menu');
  await menu.waitFor();
  assert.ok(await menu.getByText('Volume 80%', { exact: true }).isVisible());
  assert.equal(await menu.getByRole('button', { name: 'Mute', exact: true }).getAttribute('aria-pressed'), 'true');
  await menu.getByRole('button', { name: 'Mute', exact: true }).click();
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
  await openBy(tv, '.tv-nav button:first-child', usingPad);
  await tv.getByRole('heading', { name: 'Continue playing' }).waitFor();
  await tv.locator('.tv-added-grid ' + tile(second)).waitFor();
  await tv.locator('.tv-home .tv-handset-card').first().waitFor();
  await shot(tv, 'tv-home-4k');
  await openBy(tv, '.tv-nav button:nth-child(3)', usingPad);
  await tv.locator('.tv-catalog .tv-collection-card').last().waitFor();
  await openBy(tv, '.tv-catalog .tv-collection-card:nth-child(2)', usingPad);
  await tv.locator('.tv-filters button[aria-pressed="true"]').filter({ hasText: 'Recently played' }).waitFor();
  assert.equal(await tv.locator('.tv-grid .tv-game-tile').count(), 1);
  await tv.locator('.tv-filters').getByRole('button', { name: 'All', exact: true }).click();

  await tv.setViewportSize({ width: 1920, height: 1080 });
  await openBy(tv, '.tv-library-head button', usingPad);
  const search = tv.getByRole('dialog', { name: 'Search games' });
  await search.waitFor();
  await frames(tv);
  await openBy(tv, '.tv-dialog-search .tv-letters button:first-child', usingPad);
  await search.getByRole('status').filter({ hasText: '1' }).waitFor();
  await openBy(tv, '.tv-dialog-search .tv-keyboard .tv-actions button:nth-last-child(2)', usingPad);
  await search.getByRole('status').filter({ hasText: 'Search games' }).waitFor();
  await usingPad('back');
  await search.waitFor({ state: 'hidden' });
  await tv.getByRole('navigation', { name: 'TV navigation' }).getByRole('button', { name: 'Phones' }).click();
  await tv.locator('.tv-handset-card').filter({ hasText: 'K790i' }).click();
  await tv.getByRole('dialog', { name: 'K790i' }).getByRole('button', { name: 'Use this phone' }).click();
  await tv.locator('.tv-handset-card[data-selected="true"]').filter({ hasText: 'K790i' }).waitFor();
  await tv.getByRole('navigation', { name: 'TV navigation' }).getByRole('button', { name: 'Library' }).click();
  await frames(tv);
  await openBy(tv, tile(second), usingPad);
  await tv.getByRole('heading', { name: second.name }).waitFor();
  await frames(tv);
  await openBy(tv, '.tv-details [data-tv-prefer]', usingPad);
  await until(async () => (await status())?.gameId === second.id, 'Second game did not start');
  await tv.waitForFunction(() => document.activeElement?.classList.contains('stage'));

  await checkDimmedPhone();
  await tv.locator('.tv-player .skin-box[data-skin="sony-ericsson-k790i"]').waitFor();
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
  await scaled.addInitScript(installGamepad);
  await scaled.addInitScript(() => localStorage.setItem('mgo.theme', 'light'));
  await scaled.goto(base + '/tv');
  await scaled.locator(tile(second)).waitFor();
  assert.ok(await scaled.evaluate(() => devicePixelRatio === 2 && document.documentElement.scrollWidth === innerWidth));
  assert.equal(await scaled.locator('.tv').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(244, 247, 245)');
  await scaled.getByRole('navigation', { name: 'TV navigation' }).getByRole('button', { name: 'Phones' }).click();
  await scaled.locator('.tv-catalog .tv-handset-card').first().click();
  await scaled.getByRole('dialog').getByText(/Display · \d+×\d+/).waitFor();
  await scaled.getByRole('dialog').getByRole('button', { name: 'Back' }).click();
  await scaled.getByRole('navigation', { name: 'TV navigation' }).getByRole('button', { name: 'Home' }).click();
  await scaled.locator('.tv-home .tv-handset-card').first().waitFor();
  await shot(scaled, 'tv-home-light-1080p');
  await scaled.setViewportSize({ width: 390, height: 844 });
  assert.equal(await scaled.locator('.tv-body').evaluate(body => body.scrollWidth <= body.clientWidth + 1), true);
  await scaled.setViewportSize({ width: 1280, height: 720 });
  await scaled.route(base + '/api/games', async route => {
    const response = await route.fetch();
    const entries = await response.json();
    const examples = Array.from({ length: 72 }, (_, i) => ({
      ...first, id: `page-${i}`, groupKey: `page-${i}`, name: `Page fixture ${i}`, lastPlayedAt: null,
      classification: { primaryGenre: i % 2 ? 'Adventure' : 'Simulation' },
    }));
    await route.fulfill({ response, json: entries.concat(examples) });
  });
  await scaled.reload();
  const nav = scaled.getByRole('navigation', { name: 'TV navigation' });
  await nav.getByRole('button', { name: 'Collections' }).click();
  for (const genre of ['Adventure', 'Simulation']) {
    const label = scaled.locator('.tv-collection-card').filter({ hasText: genre }).locator('span');
    assert.ok(await label.evaluate(el => getComputedStyle(el).whiteSpace === 'nowrap' && el.scrollWidth <= el.clientWidth + 1));
  }
  await nav.getByRole('button', { name: 'Library' }).click();
  await scaled.locator('.tv-grid .tv-game-tile').last().waitFor();
  await scaled.evaluate(() => { window.rightStick = .95; });
  await scaled.waitForFunction(() => document.querySelector('.tv-body').scrollTop > 400);
  await scaled.evaluate(() => { window.rightStick = 0; });
  await frames(scaled);
  assert.ok(await scaled.evaluate(() => document.activeElement?.matches('.tv-grid .tv-game-tile')));
  const scrolled = await scaled.locator('.tv-body').evaluate(el => el.scrollTop);
  await scaled.evaluate(() => { window.rightStick = -.95; });
  await scaled.waitForFunction(before => document.querySelector('.tv-body').scrollTop < before, scrolled);
  await scaled.evaluate(() => { window.rightStick = 0; });
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
