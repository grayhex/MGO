import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { ACTIONS, InputController, codeFor, type InputSource } from './input';
import { PHONE_REMOTE_PROFILES, SONY_ERICSSON_KEYS, SONY_TV_KEYS, phoneAction, phoneMenuAction } from './phoneRemote';

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
    const image = tarMember(file, 0, `${name}.jpg`);
    assert.equal(image.data.readUInt16BE(0), 0xffd8);
    const frame = image.data.indexOf(Buffer.from([0xff, 0xc0])); // baseline JPEG frame header
    assert.ok(frame > 0);
    assert.equal(image.data.readUInt16BE(frame + 5), height);
    assert.equal(image.data.readUInt16BE(frame + 7), width);
    const configuration = tarMember(file, image.next, `${name}.kcf`);
    assert.equal(file.readUInt32BE(configuration.next), 0);
    const bindings = Array.from(configuration.data.toString('ascii').matchAll(/<(KEY_\w+)><ACTION><KEYBOARD MODIFIERS="(\d{2})" USAGEID="([0-9A-F]{2})" \/><\/ACTION><\/\1>/g));
    const allKeys = { ...SONY_ERICSSON_KEYS, ...SONY_TV_KEYS };
    assert.equal(bindings.length, Object.keys(allKeys).length);
    const actions = bindings.map(([, physical, modifiers, usage]) => {
      const [action, id, shift] = allKeys[physical as keyof typeof allKeys];
      assert.equal(Number.parseInt(usage!, 16), id);
      assert.equal(modifiers, shift ? '02' : '00');
      if (action === 'menu' || action === 'back') assert.equal(phoneMenuAction(key(`F${id - 0x3a + 1}`, { shiftKey: shift })), action);
      else assert.equal(phoneAction(key(`F${13 + id - 0x68}`, { shiftKey: shift })), action);
      return action;
    });
    assert.deepEqual(actions.sort(), [...ACTIONS.filter(action => action !== 'clear'), 'menu', 'back'].sort());
  });
}

it('forwards phone input immediately, shares held keys with other devices and releases after Shift goes up', () => {
  const events: unknown[] = [];
  const sources: InputSource[] = [];
  const input = new InputController(event => events.push(event), source => sources.push(source));
  input.layout = 'siemens';
  const up = codeFor('up', input.layout);
  input.onKeyDown(key('F13'));
  assert.deepEqual(events, [{ t: 'key', s: 'D', code: up }]);
  input.onKeyDown(key('F13', { repeat: true }));
  input.onKeyDown(key('ArrowUp'));
  input.onKeyUp(key('F13'));
  assert.equal(events.length, 1);
  input.onKeyDown(key('F21', { shiftKey: true }));
  input.onKeyUp(key('F21'));
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
  const typing = key('F13');
  Object.defineProperty(typing, 'target', { value: { tagName: 'INPUT' } });
  input.onKeyDown(typing);
  input.onKeyDown(key('F13', { ctrlKey: true }));
  input.enabled = false;
  input.onKeyDown(key('F13'));
  assert.deepEqual(sources, []);
  assert.equal(typing.defaultPrevented, false);
  input.enabled = true;
  input.bindings.fire = ['F13'];
  input.onKeyDown(key('F13'));
  assert.deepEqual([...input.heldActions()], ['fire']);
  assert.deepEqual(sources, ['keyboard']);
  input.onKeyUp(key('F13'));
  assert.deepEqual(input.heldCodes(), []);
});
