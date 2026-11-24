import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { makeJar, tmpDir } from './dev/testing.js';
import { Library } from './library.js';

test('target resolution comes from package evidence and survives a database upgrade and profile changes', t => {
  const dir = tmpDir();
  let library = new Library(dir);
  t.after(() => { library.close(); rmSync(dir, { recursive: true, force: true }); });
  const jar = makeJar('Declared size', { extra: 'Nokia-MIDlet-Original-Display-Size: 176,208\nNokia-MIDlet-Display-Size: 240,320' });
  const declared = library.add(jar, null, 1 << 20, { fileName: 'Game 240x320.jar' }).game;
  const fromName = library.add(makeJar('Filename size'), null, 1 << 20, { fileName: 'Filename size 128X160.jar' }).game;
  const unknown = library.add(makeJar('Unknown size'), null, 1 << 20).game;
  const card = library.addPackage(Buffer.from('PK\x03\x04demo'), 'Demo.zip', 'ngage', 1 << 20).game;
  assert.deepEqual(declared.nativeResolution, { width: 176, height: 208, source: 'attribute Nokia-MIDlet-Original-Display-Size' });
  assert.deepEqual(fromName.nativeResolution, { width: 128, height: 160, source: 'file name' });
  assert.equal(unknown.nativeResolution, undefined);
  assert.deepEqual(card.nativeResolution, { width: 176, height: 208, source: 'N-Gage display' });

  library.db.exec('ALTER TABLE games DROP COLUMN native_resolution_json');
  library.close();
  library = new Library(dir);
  const changed = library.update(declared.id, { settings: { width: 360, height: 640 } });
  assert.equal(changed?.settings.height, 640);
  assert.deepEqual(changed?.nativeResolution, declared.nativeResolution);
  assert.equal(library.list().find(game => game.id === unknown.id)?.nativeResolution, undefined);
});

test('last output resolution remains separate from the target and from old profile estimates', t => {
  const dir = tmpDir();
  let library = new Library(dir);
  t.after(() => { library.close(); rmSync(dir, { recursive: true, force: true }); });
  const game = library.add(makeJar('Display test'), null, 1 << 20, { defaults: { width: 240, height: 320 } }).game;
  assert.equal(game.playedResolution, undefined);
  library.touchPlayed(game.id);
  library.addPlayTime(game.id, 15);
  assert.deepEqual(library.get(game.id)?.playedResolution, { width: 240, height: 320, source: 'saved-profile' });
  library.recordPlayedResolution(game.id, 176, 208);
  library.recordGameResolution(game.id, { width: 128, height: 160, source: 'frame' });
  library.close();
  library = new Library(dir);
  const saved = library.update(game.id, { settings: { width: 360, height: 640 } });
  assert.deepEqual(saved?.playedResolution, { width: 176, height: 208, source: 'played' });
  assert.deepEqual(saved?.nativeResolution, { width: 128, height: 160, source: 'frame' });
});
