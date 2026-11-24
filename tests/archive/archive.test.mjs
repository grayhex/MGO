import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ArchiveIndex, normalized } from '../../apps/api/src/archive/index.ts';
import { folderSegments, publishJar, withDestination, writable } from '../../apps/api/src/archive/destination.ts';
import { ArchiveMatching } from '../../apps/api/src/archive/matching.ts';
import { Library } from '../../apps/api/src/library.ts';
import { makeJar, tmpDir } from '../../apps/api/src/dev/testing.ts';
import { archiveBuild, writeArchiveFixture } from '../fixtures/archive-fixture.mjs';

test('search distinguishes full hashes, matches Unicode names and vendor, and limits a result page', t => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows = Array.from({ length: 25 }, (_, i) => archiveBuild(makeJar('Гонки', { version: String(i) }), { title: 'Гонки', filename: `Pocket-Racing_${i}.jar`, version: String(i), vendor: 'Škoda' }));
  const file = path.join(dir, 'verified.sqlite');
  writeArchiveFixture(file, rows);
  const index = new ArchiveIndex(file);
  t.after(() => index.close());
  assert.equal(normalized('　ＧＯＮＫＩ!!!'), 'gonki');
  assert.equal(index.search('гон Ško', '', 0).builds.length, 20);
  assert.equal(index.search('Pocket', 'racing', 1).builds.length, 5);
  assert.deepEqual(index.search(rows[3].sha256, '', 0).builds.map(build => ({ ...build })), [rows[3]]);
  assert.deepEqual(index.search(rows[3].sha1, '', 0).builds.map(build => ({ ...build })), [rows[3]]);
  assert.equal(index.search(rows[3].crc32, 'Pocket', 0).builds.length, 20);
  assert.equal(index.search('"* ) not a raw FTS query', '', 0).more, false);
  assert.equal(index.candidates('Гонки', 'ŠKODA', rows[3].version, rows[5].sha256)[0].sha256, rows[3].sha256);
});

test('exact matching can resume across restarts and never applies candidates automatically', async t => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const exact = makeJar('Snow', { version: '' });
  const similar = makeJar('Snow', { version: '2' });
  const build = archiveBuild(exact, { title: 'Snow', version: '1' });
  const file = path.join(dir, 'index.sqlite');
  writeArchiveFixture(file, [build]);
  const index = new ArchiveIndex(file);
  t.after(() => index.close());
  let library = new Library(dir);
  const a = library.add(exact, null, 100000).game;
  library.setTitle(a.groupKey, 'Snow / locked');
  const b = library.add(similar, null, 100000).game;
  let matches = new ArchiveMatching(library);
  matches.start(index, false);
  assert.equal(matches.pause(), true);
  await matches.idle();
  assert.equal(matches.current().state, 'paused');
  library.close();

  library = new Library(dir);
  t.after(() => library.close());
  matches = new ArchiveMatching(library);
  library.enrich = game => matches.enrich(game);
  matches.start(index, true);
  await matches.idle();
  assert.equal(matches.current().state, 'preview');
  assert.equal(library.get(a.id).archiveMatch, undefined);
  assert.deepEqual(matches.rows(true, 0).rows.map(row => row.match.state).sort(), ['review']);
  matches.apply(index);
  assert.equal(library.get(a.id).name, 'Snow / locked');
  assert.equal(library.get(a.id).version, '1');
  assert.equal(library.get(b.id).version, '2');
  assert.equal(library.get(b.id).archiveMatch.build, null);
  matches.confirm(b.id, build.sha256);
  assert.equal(matches.current().review, 0);
  for (let i = 0; i < 2; i++) {
    matches.start(index, false);
    await matches.idle();
    matches.apply(index);
  }
  assert.equal(library.get(b.id).archiveMatch.state, 'manual');
  assert.equal(library.count(), 2);
  assert.equal(library.get(a.id).archiveMatch.matchedSha256, a.sha256);
});

test('writable destinations reject traversal, symlinks and unavailable roots; publish never overwrites', t => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => folderSegments('/absolute'));
  assert.throws(() => folderSegments('a/../b'));
  assert.throws(() => withDestination(path.join(dir, 'unmounted'), ['JAR'], () => null), { code: 'archive_read_only' });
  const blocked = path.join(dir, 'blocked');
  mkdirSync(blocked, { mode: 0o555 });
  if (process.getuid?.() !== 0) assert.equal(writable(blocked), false);
  chmodSync(blocked, 0o755);
  symlinkSync(dir, path.join(dir, 'alias'), 'dir');
  assert.throws(() => withDestination(dir, ['alias', 'x'], () => null), { code: 'archive_bad_folder' });
  const sha = 'a'.repeat(64);
  withDestination(dir, ['JAR'], folder => {
    writeFileSync(path.join(folder, 'Racer [aaaaaaaaaaaa].jar'), 'unrelated');
    const name = publishJar(folder, 'Racer.jar', sha, Buffer.from('fixture'), name => name);
    assert.equal(name, 'Racer [aaaaaaaaaaaa-2].jar');
    assert.equal(readFileSync(path.join(folder, name), 'utf8'), 'fixture');
    assert.equal(readFileSync(path.join(folder, 'Racer [aaaaaaaaaaaa].jar'), 'utf8'), 'unrelated');
    assert.throws(() => publishJar(folder, 'Broken.jar', sha, Buffer.from('fixture'), () => { throw Error('insertion error'); }), /insertion error/);
    assert.deepEqual(readdirSync(folder).sort(), [name, 'Racer [aaaaaaaaaaaa].jar'].sort());
  });
});

test('curated downloads publish into the configured Java subfolder and are recognised by a rescan', async t => {
  const { buildApp } = await import('../../apps/api/src/server.ts');
  const { testConfig } = await import('../../apps/api/src/dev/testing.ts');
  const { archiveFixtureWorker } = await import('../fixtures/archive-fixture.mjs');
  const dir = tmpDir();
  const java = path.join(dir, 'Shared', 'Java');
  mkdirSync(java, { recursive: true });
  const bytes = makeJar('3D Bomberman');
  const build = archiveBuild(bytes, { title: '3D Bomberman', filename: 'Bomberman.jar' });
  const app = await buildApp(testConfig({ dataDir: path.join(dir, 'data'), runDir: path.join(dir, 'run'), roots: [java] }), {
    archiveWorker: archiveFixtureWorker([build], new Map([[build.sha256, bytes]])),
  });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

  const patch = payload => app.fastify.inject({ url: '/api/settings', method: 'PATCH', payload });
  assert.equal((await patch({ archiveDownloadFolder: '../escape' })).statusCode, 400);
  assert.equal((await patch({ libraryPaths: { j2me: java }, archiveDownloadFolder: 'Downloads/Curated' })).statusCode, 200);
  assert.equal((await app.fastify.inject('/api/archive/curated')).json().destination.path, path.join(java, 'Downloads/Curated'));
  await app.fastify.inject({ url: '/api/archive/index', method: 'POST' });
  const waitFor = async fn => {
    for (let i = 0; i < 200; i++) {
      if (await fn()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Timed out waiting for the archive job');
  };
  await waitFor(async () => !!(await app.fastify.inject('/api/archive')).json().index);
  const selection = [{ title: build.title, sha256: build.sha256 }];
  const start = await app.fastify.inject({ url: '/api/archive/curated', method: 'POST', payload: { confirmed: true, selection } });
  assert.equal(start.statusCode, 202, start.body);
  await waitFor(async () => (await app.fastify.inject('/api/archive/curated')).json().job?.state === 'done');
  const job = (await app.fastify.inject('/api/archive/curated')).json().job;
  assert.equal(job.imported, 1, JSON.stringify(job.failed));
  const destination = path.join(java, 'Downloads/Curated');
  const [file] = readdirSync(destination);
  assert.deepEqual(readFileSync(path.join(destination, file)), Buffer.from(bytes));
  assert.equal(app.library.get(app.library.findBySha(build.sha256).id).fileName, file);
  app.scan.start('update');
  await app.scan.idle();
  assert.equal(app.library.count(), 1);
  assert.equal(app.library.sourcesOf(app.library.findBySha(build.sha256).id)[0].missing, 0);
});
