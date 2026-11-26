import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { ACTIONS, DEFAULT_BINDINGS, InputController, codeFor, type InputSource } from './input';
import { PHONE_REMOTE_PROFILES, SONY_ERICSSON_KEYS, SONY_PHONE_INDICATOR, isPhoneIndicatorKey, phoneAction, phoneTestAction } from './phoneRemote';

const modifiers = { altKey: true, ctrlKey: true, shiftKey: true };

function key(code: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return Object.assign(new Event('key', { cancelable: true }), { code }, options) as KeyboardEvent;
}

function tarMember(archive: Buffer, offset: number, name: string) {
  assert.equal(archive.toString('ascii', offset, offset + 100).replace(/\0.*$/, ''), name);
  assert.equal(archive.toString('ascii', offset + 257, offset + 262), 'ustar');
  const size = Number.parseInt(archive.toString('ascii', offset + 124, offset + 136), 8);
  const start = offset + 512;
  return { data: archive.subarray(start, start + size), next: start + Math.ceil(size / 512) * 512 };
}

for (const { model, name, url, width, height } of PHONE_REMOTE_PROFILES) {
  it(`ships a ${model} profile with a correctly sized screen and the supported keys`, () => {
    const file = readFileSync(new URL(`../public${url}`, import.meta.url));
    const configuration = tarMember(file, 0, `${name}.kcf`);
    const image = tarMember(file, configuration.next, `${name}.jpg`);
    assert.equal(image.data.readUInt16BE(0), 0xffd8);
    const frame = image.data.indexOf(Buffer.from([0xff, 0xc0])); // baseline JPEG frame header
    assert.ok(frame > 0);
    assert.equal(image.data.readUInt16BE(frame + 5), height);
    assert.equal(image.data.readUInt16BE(frame + 7), width);
    assert.equal(file.readUInt32BE(image.next), 0);
    const bindings = Array.from(configuration.data.toString('ascii').matchAll(/<(KEY_\w+)>\s*<ACTION>\s*<KEYBOARD MODIFIERS = "(\d{2})" USAGEID = "([0-9A-F]{2})"\/>\s*<\/ACTION>\s*<\/\1>/g));
    const indicator = bindings.pop();
    assert.deepEqual(indicator?.slice(1), [SONY_PHONE_INDICATOR.key, SONY_PHONE_INDICATOR.modifiers, '13']);
    const codes = new Map<number, string>([
      [0x52, 'ArrowUp'], [0x51, 'ArrowDown'], [0x50, 'ArrowLeft'], [0x4f, 'ArrowRight'],
      [0x28, 'Enter'], [0x14, 'KeyQ'], [0x1a, 'KeyW'], [0x1b, 'KeyX'], [0x1d, 'KeyZ'], [0x27, 'Digit0'],
      ...Array.from({ length: 9 }, (_, i): [number, string] => [0x1e + i, `Digit${i + 1}`]),
    ]);
    const actions = bindings.map(([, physical, mask, usage]) => {
      const [action, id, code] = SONY_ERICSSON_KEYS[physical as keyof typeof SONY_ERICSSON_KEYS];
      assert.equal(Number.parseInt(usage!, 16), id);
      assert.equal(codes.get(id), code);
      assert.equal(mask, '00');
      assert.ok(DEFAULT_BINDINGS[action].includes(code));
      assert.equal(phoneTestAction(key(code)), action);
      return action;
    });
    assert.deepEqual(actions.sort(), ACTIONS.filter(action => action !== 'clear').sort());
  });
}

it('recognizes the volume-up signal from the A2 profile without sending a game key', () => {
  const events: unknown[] = [];
  const sources: InputSource[] = [];
  const input = new InputController(event => events.push(event), source => sources.push(source));
  input.enabled = false;
  const volume = key('KeyP', modifiers);
  assert.ok(isPhoneIndicatorKey(volume));
  assert.ok(!isPhoneIndicatorKey(key('KeyP')));
  input.onKeyDown(key('KeyP'));
  assert.deepEqual(sources, []);
  input.onKeyDown(volume);
  input.onKeyUp(key('KeyP'));
  assert.ok(volume.defaultPrevented);
  assert.deepEqual(sources, ['phone']);
  assert.deepEqual(events, []);
});

it('forwards phone input immediately, shares held keys with other devices and releases after modifiers go up', () => {
  const events: unknown[] = [];
  const sources: InputSource[] = [];
  const input = new InputController(event => events.push(event), source => sources.push(source));
  input.layout = 'siemens';
  const up = codeFor('up', input.layout);
  input.onKeyDown(key('KeyI', modifiers));
  assert.deepEqual(events, [{ t: 'key', s: 'D', code: up }]);
  input.onKeyDown(key('KeyI', { ...modifiers, repeat: true }));
  input.onKeyDown(key('ArrowUp'));
  input.onKeyUp(key('KeyI'));
  assert.equal(events.length, 1);
  input.onKeyDown(key('KeyB', modifiers));
  input.onKeyUp(key('KeyB'));
  input.onKeyUp(key('ArrowUp'));
  input.press('pad:0:fire', 'fire');
  assert.deepEqual(events.slice(1, 4), [
    { t: 'key', s: 'D', code: 57 }, { t: 'key', s: 'U', code: 57 }, { t: 'key', s: 'U', code: up },
  ]);
  assert.deepEqual(sources, ['phone', 'keyboard', 'phone', 'gamepad']);
  input.releaseAll();
  assert.deepEqual(input.heldCodes(), []);
});

it('ignores phone events while typing or disabled and honors explicit keyboard bindings', () => {
  const sources: InputSource[] = [];
  const input = new InputController(() => undefined, source => sources.push(source));
  const typing = key('KeyI', modifiers);
  Object.defineProperty(typing, 'target', { value: { tagName: 'INPUT' } });
  input.onKeyDown(typing);
  input.onKeyDown(key('KeyI', { ctrlKey: true }));
  input.enabled = false;
  input.onKeyDown(key('KeyI', modifiers));
  assert.deepEqual(sources, []);
  assert.equal(typing.defaultPrevented, false);
  input.enabled = true;
  input.bindings.fire = ['F13'];
  assert.equal(phoneAction(key('F13')), 'up', 'existing profiles still play when the OS exposes these keys');
  input.onKeyDown(key('F13'));
  assert.deepEqual([...input.heldActions()], ['fire']);
  assert.deepEqual(sources, ['keyboard']);
  input.onKeyUp(key('F13'));
  assert.deepEqual(input.heldCodes(), []);
});
