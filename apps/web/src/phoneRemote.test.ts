import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { ACTIONS, InputController, codeFor, type InputSource } from './input';
import { K790I_KEYS, K790I_PROFILE_FILE, phoneAction } from './phoneRemote';

function key(code: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return Object.assign(new Event('key', { cancelable: true }), { code }, options) as KeyboardEvent;
}

it('ships a Sony configuration for each supported physical key and decodes its HID usage', () => {
  const file = readFileSync(new URL(`../public${K790I_PROFILE_FILE}`, import.meta.url));
  assert.equal(file.toString('ascii', 257, 262), 'ustar');
  const bindings = Array.from(file.toString('latin1').matchAll(/<(KEY_\w+)><ACTION><KEYBOARD MODIFIERS="(\d{2})" USAGEID="([0-9A-F]{2})" \/><\/ACTION><\/\1>/g));
  assert.equal(bindings.length, Object.keys(K790I_KEYS).length);
  const actions = bindings.map(([, physical, modifiers, usage]) => {
    const [action, id, shift] = K790I_KEYS[physical as keyof typeof K790I_KEYS];
    assert.equal(Number.parseInt(usage!, 16), id);
    assert.equal(modifiers, shift ? '02' : '00');
    assert.equal(phoneAction(key(`F${13 + id - 0x68}`, { shiftKey: shift })), action);
    return action;
  });
  assert.deepEqual(actions.sort(), ACTIONS.filter(action => action !== 'clear').sort());
});

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
