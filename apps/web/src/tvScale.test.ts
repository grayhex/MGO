import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lcdSize } from './tv/player';

test('TV LCD scales in physical pixels at 4K and at a high browser DPR', () => {
  assert.deepEqual(lcdSize(3600, 2040, 240, 320, 1, true), { width: 1440, height: 1920 });
  assert.deepEqual(lcdSize(1800, 1020, 240, 320, 2, true), { width: 720, height: 960 });
  assert.deepEqual(lcdSize(1800, 1020, 240, 320, 2, false), { width: 765, height: 1020 });
  assert.deepEqual(lcdSize(120, 160, 240, 320, 1, true), { width: 120, height: 160 });
});
