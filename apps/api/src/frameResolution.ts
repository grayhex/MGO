import { inflateRawSync } from 'node:zlib';
import { FRAME_ENC_DEFLATE_RAW, SCREEN_PRESETS } from '@mgo/protocol';
import type { FrameMsg } from './kemulator/adapter.js';

export function paddedGameSize(pixels: Uint8Array, width: number, height: number) {
  if (pixels.length !== width * height * 4) return null;
  const corner = pixels.length - 4;
  const background = pixels[corner]!;
  if (![...pixels.subarray(corner, corner + 3)].every(v => Math.abs(v - background) <= 2)
      || (background > 20 && background < 235)) return null;
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.abs(pixels[i]! - background) <= 2 && Math.abs(pixels[i + 1]! - background) <= 2 && Math.abs(pixels[i + 2]! - background) <= 2) continue;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  }
  // Only accept a recognisable top-left rectangle with padding on both sides.
  // Centred splash screens, softkey strips and unrelated coloured borders are insufficient.
  if (left > 2 || top > 2 || width - right < 12 || height - bottom < 12) return null;
  const preset = SCREEN_PRESETS.find(size => size.width === right && size.height === bottom);
  return preset ? { width: preset.width, height: preset.height, source: 'frame' } : null;
}

export class FrameResolution {
  private nextSample = 0;
  private remaining = 24;
  private last = '';
  private count = 0;

  sample(frame: FrameMsg, width: number, height: number, now: number) {
    const bytes = width * height * 4;
    if (!this.remaining || now < this.nextSample || bytes > 1920 * 1080 * 4) return null;
    this.nextSample = now + 900;
    this.remaining--;
    let pixels: Uint8Array;
    try {
      pixels = frame.enc === FRAME_ENC_DEFLATE_RAW ? inflateRawSync(frame.data, { maxOutputLength: bytes }) : frame.data;
    } catch {
      this.count = 0;
      return null;
    }
    const resolution = paddedGameSize(pixels, width, height);
    const key = resolution ? `${resolution.width}x${resolution.height}` : '';
    this.count = this.last === key ? this.count + 1 : 1;
    this.last = key;
    if (!resolution || this.count < 3) return null;
    this.remaining = 0;
    return resolution;
  }
}
