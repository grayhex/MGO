import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { FRAME_ENC_DEFLATE_RAW } from '@mgo/protocol';
import { FrameResolution, paddedGameSize } from './frameResolution.js';

const width = 240, height = 320;
const resolution = { width: 176, height: 220, source: 'frame' };
function frame(x: number, y: number, w: number, h: number) {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let row = y; row < y + h; row++) {
    data.fill(60, (row * width + x) * 4, (row * width + x + w) * 4);
  }
  return data;
}

test('infers only a stable, top-left, standard game viewport', () => {
  const pixels = frame(0, 0, 176, 220);
  assert.deepEqual(paddedGameSize(pixels, width, height), resolution);
  for (const input of [frame(32, 50, 176, 220), frame(0, 0, 173, 217), frame(0, 0, 240, 320), frame(0, 0, 0, 0)]) {
    assert.equal(paddedGameSize(input, width, height), null);
  }
  const detector = new FrameResolution();
  const compressed = (data: Buffer) => ({ seq: 1, tsUs: 1, enc: FRAME_ENC_DEFLATE_RAW, data: deflateRawSync(data) });
  assert.equal(detector.sample(compressed(pixels), width, height, 0), null);
  assert.equal(detector.sample(compressed(frame(0, 0, 240, 320)), width, height, 1000), null);
  assert.equal(detector.sample(compressed(pixels), width, height, 2000), null);
  assert.equal(detector.sample(compressed(pixels), width, height, 3000), null);
  assert.deepEqual(detector.sample(compressed(pixels), width, height, 4000), resolution);
});
