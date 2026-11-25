import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { SCREEN_PRESETS } from '@mgo/protocol';
import { sniffImage } from '../image.js';

export interface ScreenHint {
  width: number;
  height: number;
  source: string;
}

function dimensions(value: string): Pick<ScreenHint, 'width' | 'height'> | undefined {
  const sizes = new Map<string, Pick<ScreenHint, 'width' | 'height'>>();
  for (const match of value.matchAll(/(?<!\d)(\d{2,4})\s*[x×,]\s*(\d{2,4})(?!\d)/gi)) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width >= 64 && width <= 800 && height >= 64 && height <= 800) sizes.set(`${width}x${height}`, { width, height });
  }
  return sizes.size === 1 ? sizes.values().next().value : undefined;
}

export function readScreenHints(attributes: Record<string, string>, fileName: string): ScreenHint[] {
  const hints: ScreenHint[] = [];
  const add = (value: string, source: string) => {
    const size = dimensions(value);
    if (size) hints.push({ ...size, source });
  };
  const attrs = new Map(Object.entries(attributes).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ['Nokia-MIDlet-Original-Display-Size', 'SEMC-Screen-Size', 'MIDxlet-ScreenSize', 'Nokia-MIDlet-Display-Size']) {
    const value = attrs.get(key.toLowerCase());
    if (value) add(value, `attribute ${key}`);
  }
  add(fileName, 'file name');
  return hints;
}

export function resolutionPriority(hint?: ScreenHint): number {
  if (!hint || hint.source === 'played' || hint.source === 'saved-profile') return 0;
  switch (hint.source) {
    case 'frame': return 1;
    case 'JAR images': return 2;
    case 'file name': return 3;
    case 'J2ME Archive': return 4;
    case 'attribute Nokia-MIDlet-Original-Display-Size': return 6;
    default: return 5;
  }
}

/** Estimate a fixed-size build from distinct, screen-sized images. Mixed sizes are inconclusive. */
export function screenHintFromImages(jar: Uint8Array): ScreenHint | undefined {
  const maxImageBytes = 256 * 1024;
  let budget = 512 * 1024;
  let count = 0;
  let images: Record<string, Uint8Array>;
  try {
    images = unzipSync(jar, { filter: entry => {
      if (!/\.(?:png|gif)$/i.test(entry.name) || /(?:^|[/_.-])icons?(?:[/_.-]|\d|$)/i.test(entry.name)) return false;
      if (entry.originalSize > maxImageBytes || entry.originalSize > budget || entry.size > maxImageBytes || count >= 24) return false;
      budget -= entry.originalSize;
      count++;
      return true;
    } });
  } catch { return undefined; }
  let size: Pick<ScreenHint, 'width' | 'height'> | undefined;
  let fullScreenName = false;
  const distinct = new Set<string>();
  for (const [name, image] of Object.entries(images)) {
    if (image.byteLength < 24) continue;
    const data = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const type = sniffImage(image);
    const pngHeader = type === 'png' && data.getUint32(8) === 13 && data.getUint32(12) === 0x49484452;
    if (!pngHeader && type !== 'gif') continue;
    const width = pngHeader ? data.getUint32(16) : data.getUint16(6, true);
    const height = pngHeader ? data.getUint32(20) : data.getUint16(8, true);
    if (!SCREEN_PRESETS.some(preset => preset.width === width && preset.height === height)) continue;
    if (size && (size.width !== width || size.height !== height)) return undefined;
    size = { width, height };
    distinct.add(createHash('sha256').update(image).digest('hex'));
    if (/(?:title|splash|background|menu|loading)/i.test(name)) fullScreenName = true;
  }
  if (size && distinct.size >= (fullScreenName ? 2 : 3)) return { ...size, source: 'JAR images' };
}
