import type { Action } from './input';
import type { TvKey } from '@mgo/protocol';

export const PHONE_REMOTE_PROFILES = ([
  { model: 'K790i', width: 240, height: 320 },
  { model: 'K750i', width: 176, height: 220 },
  { model: 'W995', width: 240, height: 320 },
] as const).map(profile => {
  const name = `MGO-${profile.model}`;
  return { ...profile, name, url: `/controls/${name}.hid` };
});

// Sony Ericsson key names → MGO actions and USB keyboard Usage IDs (F13–F24).
// The joystick has its own unshifted codes, so the shifted keypad still works with it held.
export const SONY_ERICSSON_KEYS = {
  KEY_UP: ['up', 0x68],
  KEY_DOWN: ['down', 0x69],
  KEY_LEFT: ['left', 0x6a],
  KEY_RIGHT: ['right', 0x6b],
  KEY_JOY: ['fire', 0x6c],
  KEY_LSK: ['softLeft', 0x6d],
  KEY_RSK: ['softRight', 0x6e],
  KEY_1: ['d1', 0x6d, true],
  KEY_2: ['d2', 0x6f],
  KEY_3: ['d3', 0x6e, true],
  KEY_4: ['d4', 0x70],
  KEY_5: ['d5', 0x71],
  KEY_6: ['d6', 0x72],
  KEY_7: ['d7', 0x6f, true],
  KEY_8: ['d8', 0x73],
  KEY_9: ['d9', 0x70, true],
  KEY_STAR: ['star', 0x71, true],
  KEY_0: ['d0', 0x72, true],
  KEY_HASH: ['pound', 0x73, true],
} satisfies Record<string, [Action, number, boolean?]>;

export const SONY_TV_KEYS = {
  KEY_VOL_UP: ['menu', 0x44, true],
  KEY_VOL_DOWN: ['back', 0x45, true],
} satisfies Record<string, [Extract<TvKey, 'menu' | 'back'>, number, boolean]>;

const keys = new Map<string, Action>();
for (const [action, usage, shifted] of Object.values(SONY_ERICSSON_KEYS)) {
  const code = `F${13 + usage - 0x68}`;
  keys.set(shifted ? `Shift+${code}` : code, action);
}

export function phoneAction(event: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): Action | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  return (event.shiftKey ? keys.get(`Shift+${event.code}`) : undefined) ?? keys.get(event.code);
}

export function phoneMenuAction(event: Parameters<typeof phoneAction>[0]): 'menu' | 'back' | undefined {
  if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  return event.code === 'F11' ? 'menu' : event.code === 'F12' ? 'back' : undefined;
}
