import { PHONE_SKIN_IDS, skinSupportsPlatform, type GamePlatform, type PackageFormat, type PhoneSkinId } from '@mgo/protocol';

export interface PhoneOption { id: string; label: string; width: number; height: number; preferred?: boolean }

/**
 * A phone that shows this game better than the current one, or null. "Better" is only ever about the picture (the resolution):
 *  - a Java ME game that names the screen it was made for: a phone with that screen or a closer one with similar proportions;
 *  - a Symbian / N-Gage game: a phone that can run it (its kind, its package generation, firmware installed) with a larger screen.
 * `options` are the phones to choose from (the owner's phones, or all of them); a phone that cannot run the game is never offered.
 */
export function betterPhone(input: {
  platform: GamePlatform;
  packageFormat?: PackageFormat | undefined;
  current: string | null;
  options: readonly PhoneOption[];
  /** Java ME: the screen the game was made for. */
  wanted?: { width: number; height: number } | null;
  /** Native games: has this phone a firmware installed that runs the game? */
  hasFirmware?: (id: PhoneSkinId) => boolean;
}): PhoneOption | null {
  const cur = input.options.find((o) => o.id === input.current);
  if (!cur) return null;
  const runs = (o: PhoneOption) => input.platform === 'j2me' ||
    ((PHONE_SKIN_IDS as readonly string[]).includes(o.id) && skinSupportsPlatform(o.id as PhoneSkinId, input.platform, input.packageFormat) && (input.hasFirmware?.(o.id as PhoneSkinId) ?? true));
  if (input.wanted) {
    const { width, height } = input.wanted;
    const fit = (o: PhoneOption) => {
      const x = Math.log(o.width / width), y = Math.log(o.height / height);
      return Math.max(Math.abs(x), Math.abs(y)) + Math.abs(x - y);
    };
    const score = fit(cur);
    if (score === 0 && runs(cur)) return null;
    return input.options.filter(o => o.id !== cur.id && runs(o) && fit(o) <= Math.log(1.6) &&
      (!runs(cur) || fit(o) + 0.02 < score))
      .sort((a, b) => fit(a) - fit(b) || Number(!!b.preferred) - Number(!!a.preferred))[0] ?? null;
  }
  if (input.platform === 'j2me') return null;
  let best: PhoneOption | null = null;
  for (const o of input.options) {
    if (o.id === cur.id || !runs(o)) continue;
    if (o.width * o.height <= cur.width * cur.height) continue;
    if (!best || o.width * o.height > best.width * best.height) best = o;
  }
  return best;
}
