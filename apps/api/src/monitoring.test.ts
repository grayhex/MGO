import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryWorkingSet } from './monitoring.js';

test('reports the working set by subtracting Docker’s inactive file cache', () => {
  assert.deepEqual(memoryWorkingSet(1500, 1330), { memoryBytes: 170, memoryUsageBytes: 1500, memoryCacheBytes: 1330 });
  assert.deepEqual(memoryWorkingSet(100, null), { memoryBytes: 100, memoryUsageBytes: 100, memoryCacheBytes: null });
  assert.equal(memoryWorkingSet(100, 105).memoryBytes, 0);
});
