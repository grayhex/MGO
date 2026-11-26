import type { Action } from './input';

export const PHONE_REMOTE_PROFILES = ([
  { model: 'K790i', name: 'MGO790A2', width: 240, height: 320 },
  { model: 'K750i', name: 'MGO750A2', width: 176, height: 220 },
  { model: 'W995', name: 'MGO995A2', width: 240, height: 320 },
] as const).map(profile => ({ ...profile, url: `/controls/${profile.name}.hid` }));

// Match the default MGO keyboard bindings and the profile tested on the K790i.
export const SONY_ERICSSON_KEYS = {
  KEY_UP: ['up', 0x52, 'ArrowUp'],
  KEY_DOWN: ['down', 0x51, 'ArrowDown'],
  KEY_LEFT: ['left', 0x50, 'ArrowLeft'],
  KEY_RIGHT: ['right', 0x4f, 'ArrowRight'],
  KEY_JOY: ['fire', 0x28, 'Enter'],
  KEY_LSK: ['softLeft', 0x14, 'KeyQ'],
  KEY_RSK: ['softRight', 0x1a, 'KeyW'],
  KEY_1: ['d1', 0x1e, 'Digit1'],
  KEY_2: ['d2', 0x1f, 'Digit2'],
  KEY_3: ['d3', 0x20, 'Digit3'],
  KEY_4: ['d4', 0x21, 'Digit4'],
  KEY_5: ['d5', 0x22, 'Digit5'],
  KEY_6: ['d6', 0x23, 'Digit6'],
  KEY_7: ['d7', 0x24, 'Digit7'],
  KEY_8: ['d8', 0x25, 'Digit8'],
  KEY_9: ['d9', 0x26, 'Digit9'],
  KEY_STAR: ['star', 0x1b, 'KeyX'],
  KEY_0: ['d0', 0x27, 'Digit0'],
  KEY_HASH: ['pound', 0x1d, 'KeyZ'],
} satisfies Record<string, [Action, number, string]>;

const keys = new Map<string, Action>(Object.values(SONY_ERICSSON_KEYS).map(([action, , code]) => [code, action]));

// Volume up deliberately uses a separate shortcut so the game keys stay unmodified.
export const SONY_PHONE_INDICATOR = { key: 'KEY_VOL_UP', code: 'KeyP', usage: 0x13, modifiers: '07' } as const;
type Keystroke = Pick<KeyboardEvent, 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>;

const phoneChord = (event: Keystroke) => event.altKey && event.ctrlKey && event.shiftKey && !event.metaKey;
export const isPhoneIndicatorKey = (event: Keystroke) => event.code === SONY_PHONE_INDICATOR.code && phoneChord(event);

const modified = new Map<string, Action>([
  ['KeyI', 'up'], ['KeyK', 'down'], ['KeyJ', 'left'], ['KeyL', 'right'], ['KeyU', 'fire'],
  ['KeyY', 'softLeft'], ['KeyO', 'softRight'], ['KeyA', 'd1'], ['KeyS', 'd2'], ['KeyD', 'd3'],
  ['KeyF', 'd4'], ['KeyG', 'd5'], ['KeyH', 'd6'], ['KeyC', 'd7'], ['KeyV', 'd8'], ['KeyB', 'd9'],
  ['KeyR', 'star'], ['KeyN', 'd0'], ['KeyT', 'pound'],
]);
const legacyKeys: [Action, number, boolean?][] = [
  ['up', 13], ['down', 14], ['left', 15], ['right', 16], ['fire', 17],
  ['softLeft', 18], ['softRight', 19], ['d1', 18, true], ['d2', 20],
  ['d3', 19, true], ['d4', 21], ['d5', 22], ['d6', 23], ['d7', 20, true],
  ['d8', 24], ['d9', 21, true], ['star', 22, true], ['d0', 23, true], ['pound', 24, true],
];
const legacy = new Map<string, Action>(legacyKeys.map(([action, fn, shifted]) => [shifted ? `Shift+F${fn}` : `F${fn}`, action]));

export function phoneAction(event: Keystroke): Action | undefined {
  if (event.metaKey) return;
  if (phoneChord(event)) return modified.get(event.code);
  if (event.altKey || event.ctrlKey) return;
  return (event.shiftKey ? legacy.get(`Shift+${event.code}`) : undefined) ?? legacy.get(event.code);
}

export function phoneTestAction(event: Keystroke): Action | undefined {
  return phoneAction(event) ?? (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey ? keys.get(event.code) : undefined);
}

const DETECTED = 'mgo.sony-hid.detected';
export function sonyPhoneSeen(): boolean {
  try { return sessionStorage.getItem(DETECTED) === '1'; } catch { return false; }
}
export function rememberSonyPhone(): void {
  try { sessionStorage.setItem(DETECTED, '1'); } catch { /* storage is optional */ }
}
