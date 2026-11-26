import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { SCREEN_PRESETS } from '@mgo/protocol';

export interface ScreenHint {
  width: number;
  height: number;
  source: string;
}

const sizeKey = (width: number, height: number) => `${width}x${height}`;
const knownSizes = new Set([...SCREEN_PRESETS.map(preset => sizeKey(preset.width, preset.height)), '96x65', '128x96', '128x144', '176x176', '208x208', '240x432', '352x416']);
const phones: [RegExp, number, number][] = [
  [/\b(?:s65|cx65|cx70|cx75|m65|m75)\b/i, 132, 176],
  [/\b(?:n70|n72|n-gage|nokia[ -]?(?:6600|6630|6670|6680|7610))\b/i, 176, 208],
  [/\bn90\b/i, 352, 416],
  [/\b(?:k(?:550|600|610|700|750)|w(?:550|600|610|700|800|810)|razr[ -]?v3)i?\b/i, 176, 220],
  [/\b(?:n95|n96|n73|n81|k(?:790|800|810|850)|w(?:850|880|910|995)|nokia[ -]?(?:6300|6500|5310|5320))i?\b/i, 240, 320],
  [/\bnokia[ -]?6230i\b/i, 208, 208],
  [/\b(?:nokia[ -]?(?:5800|5530)|n97)\b/i, 360, 640],
];

function dimensions(value: string): Pick<ScreenHint, 'width' | 'height'> | undefined {
  const sizes = new Map<string, Pick<ScreenHint, 'width' | 'height'>>();
  for (const match of value.matchAll(/(?<!\d)(\d{2,4})\s*[x×,]\s*(\d{2,4})(?!\d)/gi)) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width >= 64 && width <= 800 && height >= 64 && height <= 800) sizes.set(sizeKey(width, height), { width, height });
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
  for (const stem of ['midlet-screen', 'display', 'screen']) {
    const width = attrs.get(stem + '-width');
    const height = attrs.get(stem + '-height');
    if (width && height) add(`${width},${height}`, `attribute ${stem}-width/-height`);
  }
  add(fileName, 'file name');
  if (!hints.length && !/\d{2,4}\s*[x×,]\s*\d{2,4}/i.test(fileName)) {
    const labels = fileName.replaceAll('_', ' ');
    const sizes = new Map<string, { width: number; height: number }>();
    for (const [name, width, height] of phones) if (name.test(labels)) sizes.set(sizeKey(width, height), { width, height });
    const size = sizes.values().next().value;
    if (sizes.size === 1 && size) hints.push({ ...size, source: 'device label' });
  }
  return hints;
}

export function resolutionPriority(hint?: ScreenHint): number {
  if (!hint || hint.source === 'played' || hint.source === 'saved-profile') return 0;
  switch (hint.source) {
    case 'frame': return 1;
    case 'JAR images': return 2;
    case 'folder label': return 2.25;
    case 'device label': return 2.5;
    case 'file name': return 3;
    case 'J2ME Archive': return 4;
    case 'attribute Nokia-MIDlet-Original-Display-Size': return 6;
    default: return 5;
  }
}

export function folderScreenHint(folder?: string): ScreenHint | undefined {
  if (!folder) return;
  const label = readScreenHints({}, folder)[0];
  if (label && knownSizes.has(sizeKey(label.width, label.height))) return { ...label, source: 'folder label' };
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
const imageNames = /\.(?:png|gif|jpe?g|bmp)$/i;
const screenName = /(?:title|splash|background|menu|loading|full[-_ ]?screen)/i;
const strongName = /(?:title[-_ ]?screen|splash|full[-_ ]?screen)/i;

function imageSize(image: Buffer, offset = 0): [number, number] | undefined {
  if (offset + 24 > image.length) return;
  if (image.subarray(offset, offset + 8).equals(png) && image.readUInt32BE(offset + 8) === 13 && image.toString('ascii', offset + 12, offset + 16) === 'IHDR')
    return [image.readUInt32BE(offset + 16), image.readUInt32BE(offset + 20)];
  if (offset) return;
  if (image.toString('ascii', 0, 6) === 'GIF89a' || image.toString('ascii', 0, 6) === 'GIF87a') return [image.readUInt16LE(6), image.readUInt16LE(8)];
  if (image.length >= 26 && image.toString('ascii', 0, 2) === 'BM' && image.readUInt32LE(14) >= 40) return [image.readInt32LE(18), Math.abs(image.readInt32LE(22))];
  if (image.readUInt16BE(0) !== 0xffd8) return;
  for (let marker = 2; marker + 9 <= Math.min(image.length, 64 * 1024) && image[marker] === 0xff;) {
    const tag = image[marker + 1]!;
    if (tag === 0xff) { marker++; continue; }
    if (tag === 0xda || tag === 0xd9) return;
    const length = image.readUInt16BE(marker + 2);
    if (length < 2 || marker + 2 + length > image.length) return;
    if (tag >= 0xc0 && tag <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(tag) && length >= 8)
      return [image.readUInt16BE(marker + 7), image.readUInt16BE(marker + 5)];
    marker += length + 2;
  }
}

/** Inspect named art and embedded PNGs with a fixed decompression budget. */
export function screenHintFromImages(jar: Uint8Array): ScreenHint | undefined {
  const entries: { name: string; size: number; rank: number }[] = [];
  let images: Record<string, Uint8Array>;
  try {
    unzipSync(jar, { filter: entry => {
      if (entry.originalSize < 24 || entry.originalSize > 384 * 1024 || entry.size > 384 * 1024 ||
          /(?:^|[/_.-])icons?(?:[/_.-]|\d|$)/i.test(entry.name) || /(?:\.class$|^META-INF\/)/i.test(entry.name)) return false;
      const image = imageNames.test(entry.name);
      const packed = /\.(?:bin|dat|pak|res|gfx|raw|[a-z0-9]{1,2})$/i.test(entry.name) || !entry.name.split('/').at(-1)?.includes('.');
      if (image || packed) entries.push({ name: entry.name, size: entry.originalSize, rank: screenName.test(entry.name) ? 2 : image ? 1 : 0 });
      return false;
    } });
    const selected = new Set<string>();
    let budget = 1536 * 1024;
    let packed = 0;
    for (const entry of entries.sort((a, b) => b.rank - a.rank)) {
      if (selected.size >= 112) break;
      if (entry.size > budget || (!entry.rank && packed >= 12)) continue;
      selected.add(entry.name);
      budget -= entry.size;
      if (!entry.rank) packed++;
    }
    if (!selected.size) return;
    images = unzipSync(jar, { filter: entry => selected.delete(entry.name) && entry.originalSize <= 384 * 1024 && entry.size <= 384 * 1024 });
  } catch { return undefined; }
  const votes = new Map<string, { width: number; height: number; samples: Set<string>; named: boolean; strong: boolean }>();
  for (const [name, bytes] of Object.entries(images)) {
    const image = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const standalone = imageNames.test(name);
    let offset = standalone ? 0 : image.indexOf(png);
    for (let inspected = 0; offset >= 0 && inspected < 64; inspected++) {
      const size = imageSize(image, offset);
      if (size && knownSizes.has(sizeKey(...size))) {
        const [width, height] = size;
        const key = sizeKey(width, height);
        const vote = votes.get(key) ?? { width, height, samples: new Set<string>(), named: false, strong: false };
        const payload = standalone ? image : image.subarray(offset, offset + 96);
        vote.samples.add(createHash('sha256').update(payload).digest('hex'));
        if (standalone) {
          vote.named ||= screenName.test(name);
          vote.strong ||= strongName.test(name);
        }
        votes.set(key, vote);
      }
      if (standalone) break;
      offset = image.indexOf(png, offset + png.length);
    }
  }
  const candidates = [...votes.values()];
  const supported = candidates.filter(vote => vote.strong || vote.samples.size >= (vote.named ? 2 : 3));
  if (supported.length !== 1) return;
  const [winner] = supported;
  // A single unlabeled 128×128 sprite atlas can coexist with art made for a portrait display.
  if (!winner || candidates.some(vote => vote !== winner && (vote.width !== 128 || vote.height !== 128 || vote.named || vote.samples.size > 1))) return;
  return { width: winner.width, height: winner.height, source: 'JAR images' };
}
