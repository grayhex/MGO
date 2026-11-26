import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { chromium } from 'playwright';

const dir = mkdtempSync(path.join(tmpdir(), 'mgo-tv-'));
const port = 19400 + Math.floor(Math.random() * 250);
const local = `http://127.0.0.1:${port}`;
const accessToken = 'mgo-tv-test-installation-token';
const headers = { Authorization: 'Bearer ' + accessToken };
const server = spawn('node', ['apps/api/dist/server.js'], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AUTH_TOKEN: accessToken, DATA_DIR: dir, LOG_LEVEL: 'warn' },
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
const hidCode = { up: 'F13', down: 'F14', left: 'F15', right: 'F16', fire: 'F17', menu: 'F11', back: 'F12' };
const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
async function pad(page, key) {
  await page.evaluate(index => { window.tvButtons = [index]; }, padIndex[key]);
  await frames(page);
  await page.evaluate(() => { window.tvButtons = []; });
  await frames(page);
}
async function hid(page, key, shiftKey = false) {
  const code = hidCode[key] ?? key;
  await page.evaluate(({ code, shiftKey }) => {
    const target = document.activeElement;
    const init = { code, shiftKey, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }, { code, shiftKey: shiftKey || key === 'menu' || key === 'back' });
}

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
let gateway;
const connections = new Set();
try {
  await until(async () => (await fetch(local + '/api/health')).ok, 'API did not start');
  await fetch(local + '/api/setup/skip', { method: 'POST', headers });
  const fixtures = ['tests/fixtures/testmidlet/build/kemtest.jar', 'tests/fixtures/testmidlet/build/kemtest2.jar'];
  const games = [];
  for (const fixture of fixtures) {
    const body = new FormData();
    body.append('jar', new Blob([readFileSync(fixture)]), path.basename(fixture));
    const response = await fetch(local + '/api/games', { method: 'POST', body, headers });
    assert.equal(response.status, 201);
    games.push((await response.json()).game);
  }
  const [first, second] = games;
  const certificate = path.join(dir, 'tv.crt');
  const privateKey = path.join(dir, 'tv.key');
  execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=mgo-tv.local',
    '-addext', 'subjectAltName=DNS:mgo-tv.local', '-keyout', privateKey, '-out', certificate], { stdio: 'ignore' });
  const forward = incoming => request({ hostname: '127.0.0.1', port, path: incoming.url, method: incoming.method, headers: { ...incoming.headers, 'x-forwarded-proto': 'https' } });
  gateway = createServer({ key: readFileSync(privateKey), cert: readFileSync(certificate) }, (incoming, outgoing) => {
    const upstream = forward(incoming);
    upstream.on('response', response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  gateway.on('upgrade', (incoming, client, initial) => {
    const upstream = forward(incoming);
    upstream.on('upgrade', (response, socket, preserved) => {
      const headers = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (initial.length) socket.write(initial);
      if (preserved.length) client.write(preserved);
      socket.on('error', () => client.destroy());
      client.on('error', () => socket.destroy());
      socket.once('close', () => client.destroy());
      client.once('close', () => socket.destroy());
      client.pipe(socket).pipe(client);
    });
    upstream.on('response', response => { response.resume(); client.destroy(); });
    upstream.on('error', () => client.destroy());
    upstream.end();
  });
  gateway.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const lan = `https://mgo-tv.local:${gateway.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP mgo-tv.local 127.0.0.1'] });
  const untrusted = await browser.newPage();
  await assert.rejects(untrusted.goto(lan + '/remote'), /ERR_CERT_AUTHORITY_INVALID/);
  await untrusted.close();
  const tv = await browser.newPage({ viewport: { width: 3840, height: 2160 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const login = async page => {
    await page.goto(lan + '/tv');
    const code = await page.evaluate(async token => (await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).status, accessToken);
    assert.equal(code, 200);
  };
  await login(tv);
  const errors = [];
  tv.on('pageerror', error => errors.push(error.message));
  await tv.addInitScript(() => {
    window.tvButtons = [];
    Object.defineProperty(navigator, 'getGamepads', { value: () => [{
      id: 'TV test pad', index: 0, mapping: 'standard', connected: true, axes: [0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: window.tvButtons.includes(i), value: Number(window.tvButtons.includes(i)) })),
    }] });
  });
  await tv.goto(lan + '/tv');
  const pair = tv.getByRole('dialog', { name: 'Phone controller' });
  await pair.waitFor();
  await pair.getByRole('img', { name: 'Pairing QR code' }).waitFor();
  await tv.waitForFunction(() => document.activeElement?.textContent === 'Back');
  await pad(tv, 'fire');
  await tv.locator(tile(first)).waitFor();
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
    const sessions = await fetch(local + '/api/sessions', { headers }).then(response => response.json());
    const instance = sessions.find(item => item.state === 'running');
    return instance && fetch(local + '/api/sessions/' + instance.id, { headers }).then(response => response.json());
  };
  async function presses(code) {
    const running = await status();
    return running?.logTail.filter(line => line.includes(`KEY_DOWN ${code}`)).length ?? 0;
  }
  await until(async () => (await status())?.gameId === first.id, 'First game did not start');
  await tv.locator('.tv-player .player-bare-screen canvas').waitFor();
  for (let i = 0; i < 8 && !(await presses(-5)); i++) { await usingPad('fire'); await delay(150); }
  assert.ok(await presses(-5), 'pad input reaches KEmulator');
  const lcd = await tv.locator('.tv-player canvas').evaluate(canvas => ({ width: canvas.clientWidth, height: canvas.clientHeight, w: canvas.width, h: canvas.height }));
  assert.equal(lcd.width / lcd.w, lcd.height / lcd.h);
  assert.equal(lcd.width % lcd.w, 0);
  await shot(tv, 'tv-game-4k');
  await usingPad('menu');
  const menu = tv.getByRole('dialog', { name: 'TV menu' });
  await menu.waitFor();
  await shot(tv, 'tv-menu-4k');
  await frames(tv);
  const stopSelector = '.tv-dialog-menu > .tv-actions:last-child button:first-child';
  await openBy(tv, stopSelector, usingPad);
  await tv.getByRole('dialog', { name: 'Stop game?' }).waitFor();
  await frames(tv);
  await openBy(tv, '.tv-dialog-confirm > button', usingPad);
  await tv.locator(tile(first)).waitFor();
  await tv.waitForFunction(selector => document.activeElement === document.querySelector(selector), tile(first));
  console.log('PASS: gamepad end-to-end, 4K layout, phone selection, integer scaling, stop and focus restoration');

  // Real TV layout at 1080p and a simulated early Sony Ericsson HID profile.
  await tv.setViewportSize({ width: 1920, height: 1080 });
  await hid(tv, 'menu');
  await menu.waitFor();
  await hid(tv, 'back');
  await menu.waitFor({ state: 'hidden' });
  const usingHid = key => hid(tv, key);
  await frames(tv);
  await openBy(tv, tile(first), usingHid);
  await tv.getByRole('heading', { name: first.name }).waitFor();
  await frames(tv);
  await openBy(tv, '.tv-details [data-tv-prefer]', usingHid);
  await until(async () => (await status())?.gameId === first.id, 'HID game did not start');
  for (let i = 0; i < 8 && !(await presses(-5)); i++) { await usingHid('fire'); await delay(150); }
  assert.ok(await presses(-5), 'phone HID input reaches KEmulator');
  await usingHid('menu');
  await menu.waitFor();
  await frames(tv);
  await openBy(tv, stopSelector, usingHid);
  await tv.getByRole('dialog', { name: 'Stop game?' }).waitFor();
  await frames(tv);
  await openBy(tv, '.tv-dialog-confirm > button', usingHid);
  await tv.locator(tile(first)).waitFor();
  assert.ok(await tv.evaluate(() => document.documentElement.scrollWidth === 1920));
  console.log('PASS: Sony Ericsson HID navigation, game input and menu at 1080p');

  await usingHid('menu');
  await menu.waitFor();
  await frames(tv);
  await openBy(tv, '.tv-dialog-menu > .tv-actions button:first-child', usingHid);
  await pair.waitFor();
  const code = await pair.getByTestId('pairing-code').textContent();
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  const phone = await phoneContext.newPage();
  phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(lan + '/remote#' + code);
  await phone.getByRole('status').filter({ hasText: 'Waiting for TV approval' }).waitFor();
  const check = await pair.locator('.tv-code').textContent();
  await phone.getByLabel('TV confirmation number').fill(check);
  await phone.getByRole('button', { name: 'Confirm pairing' }).tap();
  await phone.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
  assert.equal(await phone.evaluate(async () => (await fetch('/api/games')).status), 401);
  assert.equal(await phone.evaluate(() => new Promise(resolve => {
    const host = new WebSocket(`wss://${location.host}/api/tv/relay`);
    host.onopen = () => { host.close(); resolve(false); };
    host.onerror = () => resolve(true);
  })), true);
  const usingPhone = async key => {
    await phone.locator(`[data-remote-key="${key}"]`).tap();
    await frames(tv);
  };
  await usingPhone('back');
  await pair.waitFor({ state: 'hidden' });
  await frames(tv);
  await openBy(tv, '.tv-head .tv-actions button:first-child', usingPhone);
  await tv.getByRole('dialog', { name: 'Search games' }).waitFor();
  await phone.getByLabel('Search games').fill(second.name);
  await tv.getByRole('status').filter({ hasText: second.name }).waitFor();
  await usingPhone('back');
  await tv.locator(tile(second)).waitFor();
  assert.equal(await tv.locator(tile(first)).count(), 0);
  await frames(tv);
  await openBy(tv, tile(second), usingPhone);
  await tv.getByRole('heading', { name: second.name }).waitFor();
  await frames(tv);
  await openBy(tv, '.tv-details [data-tv-prefer]', usingPhone);
  await until(async () => (await status())?.gameId === second.id, 'Remote game did not start');
  await phone.locator('[data-remote-key="pound"]').waitFor();
  for (const key of ['up', 'down', 'left', 'right', 'fire', 'softLeft', 'softRight', 'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'star', 'pound']) {
    await phone.locator(`[data-remote-key="${key}"]`).waitFor();
  }
  await usingPhone('d9');
  await until(async () => (await status())?.logTail.some(line => line.includes('KEY_UP 57')), 'Network keypad press/release did not reach KEmulator');
  const cdp = await phoneContext.newCDPSession(phone);
  const touchPoints = [];
  for (const key of ['left', 'fire']) {
    const box = await phone.locator(`[data-remote-key="${key}"]`).boundingBox();
    touchPoints.push({ id: touchPoints.length, x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  await until(async () => (await presses(-3)) && (await presses(-5)), 'Multitouch did not reach the emulator');
  await phone.reload();
  await phone.locator('[data-remote-key="pound"]').waitFor();
  await until(async () => {
    const log = (await status())?.logTail ?? [];
    return log.some(line => line.includes('KEY_UP -3')) && log.some(line => line.includes('KEY_UP -5'));
  }, 'Reconnecting left a game key held');
  await shot(phone, 'tv-mobile-remote');
  await usingPhone('menu');
  await menu.waitFor();
  await frames(tv);
  await openBy(tv, stopSelector, usingPhone);
  await tv.getByRole('dialog', { name: 'Stop game?' }).waitFor();
  await frames(tv);
  await openBy(tv, '.tv-dialog-confirm > button', usingPhone);
  await tv.locator(tile(second)).waitFor();
  await tv.waitForFunction(selector => document.activeElement === document.querySelector(selector), tile(second));
  await usingPhone('menu');
  await menu.waitFor();
  await frames(tv);
  await openBy(tv, '.tv-dialog-menu > .tv-actions:last-child button:last-child', usingPhone);
  await tv.waitForURL(lan + '/');
  const scaled = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
  await login(scaled);
  await scaled.goto(lan + '/tv');
  await scaled.getByRole('dialog', { name: 'Phone controller' }).getByRole('button', { name: 'Back' }).click();
  await scaled.locator(tile(second)).waitFor();
  assert.ok(await scaled.evaluate(() => devicePixelRatio === 2 && document.documentElement.scrollWidth === innerWidth));
  await scaled.close();
  assert.deepEqual(errors, []);
  console.log('PASS: HTTPS and untrusted certificate handling, TV-code pairing, phone search, multitouch and reconnect, stop and desktop exit');
} finally {
  await browser?.close();
  for (const socket of connections) socket.destroy();
  gateway?.close();
  const stopped = once(server, 'exit');
  server.kill('SIGTERM');
  await stopped;
  rmSync(dir, { recursive: true, force: true });
}
