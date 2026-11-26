import type { Action } from './input';

export const PHONE_REMOTE_PROFILES = ([
  { model: 'K790i', width: 240, height: 320 },
  { model: 'K750i', width: 176, height: 220 },
  { model: 'W995', width: 240, height: 320 },
] as const).map(profile => {
  const name = `MGO-${profile.model}`;
  return { ...profile, name, url: `/controls/${name}.hid` };
});

// Use ordinary letter usages with Left Control, Shift and Alt. macOS can reserve
// the extended function keys for brightness and other system functions.
export const SONY_REMOTE_MODIFIERS = '07';
export const SONY_ERICSSON_KEYS = {
  KEY_UP: ['up', 0x0c, 'KeyI'],
  KEY_DOWN: ['down', 0x0e, 'KeyK'],
  KEY_LEFT: ['left', 0x0d, 'KeyJ'],
  KEY_RIGHT: ['right', 0x0f, 'KeyL'],
  KEY_JOY: ['fire', 0x18, 'KeyU'],
  KEY_LSK: ['softLeft', 0x1c, 'KeyY'],
  KEY_RSK: ['softRight', 0x12, 'KeyO'],
  KEY_1: ['d1', 0x04, 'KeyA'],
  KEY_2: ['d2', 0x16, 'KeyS'],
  KEY_3: ['d3', 0x07, 'KeyD'],
  KEY_4: ['d4', 0x09, 'KeyF'],
  KEY_5: ['d5', 0x0a, 'KeyG'],
  KEY_6: ['d6', 0x0b, 'KeyH'],
  KEY_7: ['d7', 0x06, 'KeyC'],
  KEY_8: ['d8', 0x19, 'KeyV'],
  KEY_9: ['d9', 0x05, 'KeyB'],
  KEY_STAR: ['star', 0x15, 'KeyR'],
  KEY_0: ['d0', 0x11, 'KeyN'],
  KEY_HASH: ['pound', 0x17, 'KeyT'],
} satisfies Record<string, [Action, number, string]>;

const keys = new Map<string, Action>(Object.values(SONY_ERICSSON_KEYS).map(([action, , code]) => [code, action]));

// Existing installed profiles can still play on hosts that deliver extended keys.
const legacyKeys: [Action, number, boolean?][] = [
  ['up', 13], ['down', 14], ['left', 15], ['right', 16], ['fire', 17],
  ['softLeft', 18], ['softRight', 19], ['d1', 18, true], ['d2', 20],
  ['d3', 19, true], ['d4', 21], ['d5', 22], ['d6', 23], ['d7', 20, true],
  ['d8', 24], ['d9', 21, true], ['star', 22, true], ['d0', 23, true], ['pound', 24, true],
];
const legacy = new Map<string, Action>(legacyKeys.map(([action, fn, shifted]) => [shifted ? `Shift+F${fn}` : `F${fn}`, action]));

export function phoneAction(event: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): Action | undefined {
  if (event.metaKey) return;
  if (event.altKey && event.ctrlKey && event.shiftKey) return keys.get(event.code);
  if (event.altKey || event.ctrlKey) return;
  return (event.shiftKey ? legacy.get(`Shift+${event.code}`) : undefined) ?? legacy.get(event.code);
}
