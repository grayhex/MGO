import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { makeJar, tmpDir } from './dev/testing.js';
import { Library } from './library.js';
import { readScreenHints, screenHintFromImages } from './analysis/screenHints.js';

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
  assert.equal(library.get(game.id)?.nativeResolution, undefined);
  library.recordGameResolution(game.id, { width: 128, height: 160, source: 'frame' });
  library.close();
  library = new Library(dir);
  const saved = library.update(game.id, { settings: { width: 360, height: 640 } });
  assert.deepEqual(saved?.playedResolution, { width: 176, height: 208, source: 'played' });
  assert.deepEqual(saved?.nativeResolution, { width: 128, height: 160, source: 'frame' });
});

test('an installed Java build can be checked without running it, and stronger evidence wins', async t => {
  const dir = tmpDir();
  const library = new Library(dir);
  t.after(() => { library.close(); rmSync(dir, { recursive: true, force: true }); });
  const pngHeader = (width: number, height: number, marker: number) => {
    const header = Buffer.alloc(32, marker);
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(header);
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return header;
  };
  const title = pngHeader(240, 320, 1);
  const jar = zipSync({ ...unzipSync(makeJar('Screen-sized images')), 'title.png': title, 'menu.png': pngHeader(240, 320, 2) });
  const assets = { width: 240, height: 320, source: 'JAR images' };
  assert.deepEqual(library.add(jar, null, 1 << 20).game.nativeResolution, assets);
  assert.equal(screenHintFromImages(zipSync({ 'title.png': title, 'menu.png': title })), undefined, 'duplicate images are not independent evidence');
  assert.equal(screenHintFromImages(zipSync({ ...unzipSync(jar), 'small.png': pngHeader(132, 176, 3) })), undefined, 'several screen sizes are ambiguous');
  assert.deepEqual(readScreenHints({}, 'Game 132x176 240x320.jar'), []);

  const game = library.list()[0]!;
  library.db.prepare('UPDATE games SET native_resolution_json = ?, screen_probed = 0 WHERE id = ?')
    .run(JSON.stringify({ width: 128, height: 128, source: 'frame' }), game.id);
  library.recordPlayedResolution(game.id, 132, 176);
  assert.deepEqual((await library.inspectGameResolution(library.get(game.id)!)).nativeResolution, assets);
  assert.equal(library.recordGameResolution(game.id, { width: 128, height: 128, source: 'frame' }), false);
  const exact = { width: 176, height: 220, source: 'J2ME Archive' };
  assert.equal(library.recordGameResolution(game.id, exact), true);
  assert.deepEqual(library.get(game.id)?.nativeResolution, exact);
  const updated = library.add(jar, Buffer.from('Nokia-MIDlet-Original-Display-Size: 320,240'), 1 << 20).game;
  assert.deepEqual(updated.nativeResolution, { width: 320, height: 240, source: 'attribute Nokia-MIDlet-Original-Display-Size' });
  assert.equal(updated.id, game.id, 'additional evidence does not create another game');
  const packed = zipSync({ ...unzipSync(makeJar('Packed art')), 'scene.bin': Buffer.concat([
    Buffer.from('GAME-DATA'), pngHeader(240, 320, 3), Buffer.alloc(100), pngHeader(240, 320, 4),
    Buffer.alloc(100), pngHeader(240, 320, 5),
  ]) });
  assert.deepEqual(screenHintFromImages(packed), assets);
  assert.deepEqual(readScreenHints({}, 'Puzzle_SE_K750i.jar')[0], { width: 176, height: 220, source: 'device label' });
  assert.deepEqual(readScreenHints({ 'MIDlet-Screen-Width': '132', 'MIDlet-Screen-Height': '176' }, 'Puzzle.jar')[0],
    { width: 132, height: 176, source: 'attribute midlet-screen-width/-height' });
});
