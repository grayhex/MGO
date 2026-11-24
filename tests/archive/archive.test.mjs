import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ArchiveIndex, normalized } from '../../apps/api/src/archive/index.ts';
import { folderSegments, publishJar, withDestination, writable } from '../../apps/api/src/archive/destination.ts';
import { ArchiveMatching } from '../../apps/api/src/archive/matching.ts';
import { JarMirror } from '../../apps/api/src/archive/mirror.ts';
import { JavaCatalog } from '../../apps/api/src/archive/catalog.ts';
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
  const existing = makeJar('Arkanoid', { vendor: 'TAITO' });
  const alternate = makeJar('Arkanoid', { vendor: 'Electronic Arts', version: '1.8.6' });
  const arkanoid = archiveBuild(alternate, { title: 'Arkanoid', vendor: 'Electronic Arts' });
  const bejeweledJar = makeJar('Bejeweled', { vendor: 'Electronic Arts' });
  const bejeweled = archiveBuild(bejeweledJar, { title: 'Bejeweled', vendor: 'Electronic Arts' });
  const worker = archiveFixtureWorker([build, arkanoid, bejeweled], new Map([[build.sha256, bytes], [arkanoid.sha256, alternate], [bejeweled.sha256, bejeweledJar]]));
  const transferring = Promise.withResolvers();
  const canFinish = Promise.withResolvers();
  const app = await buildApp(testConfig({ dataDir: path.join(dir, 'data'), runDir: path.join(dir, 'run'), roots: [java] }), {
    archiveWorker: async (...args) => {
      if (args[0][0] === 'download' && args[0][1] === bejeweled.sha256) {
        transferring.resolve();
        await canFinish.promise;
      }
      return worker(...args);
    },
  });
  t.after(async () => { canFinish.resolve(); await app.close(); rmSync(dir, { recursive: true, force: true }); });

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
  const before = (await app.fastify.inject('/api/archive/curated/preview')).json().titles;
  assert.equal(before.find(row => row.title === 'Arkanoid').installedGameId, undefined);
  const local = app.library.add(existing, null, 1000000).game;
  const after = (await app.fastify.inject('/api/archive/curated/preview')).json().titles;
  assert.equal(after.find(row => row.title === 'Arkanoid').installedGameId, local.id);
  const selection = [build, arkanoid, bejeweled].map(({ title, sha256 }) => ({ title, sha256 }));
  const start = await app.fastify.inject({ url: '/api/archive/curated', method: 'POST', payload: { confirmed: true, selection } });
  assert.equal(start.statusCode, 202, start.body);
  await transferring.promise;
  app.library.add(makeJar('Bejeweled', { vendor: 'PopCap' }), null, 1000000);
  canFinish.resolve();
  await waitFor(async () => (await app.fastify.inject('/api/archive/curated')).json().job?.state === 'done');
  const job = (await app.fastify.inject('/api/archive/curated')).json().job;
  assert.equal(job.imported, 1, JSON.stringify(job.failed));
  assert.equal(job.duplicates, 2);
  const destination = path.join(java, 'Downloads/Curated');
  const [file] = readdirSync(destination);
  assert.deepEqual(readFileSync(path.join(destination, file)), Buffer.from(bytes));
  const downloaded = app.library.findBySha(build.sha256);
  assert.equal(app.library.get(downloaded.id).fileName, file);
  assert.equal(downloaded.downloadedFrom, 'J2ME Archive');
  app.scan.start('update');
  await app.scan.idle();
  assert.equal(app.library.count(), 3);
  assert.equal(app.library.sourcesOf(app.library.findBySha(build.sha256).id)[0].missing, 0);
  const remove = id => app.fastify.inject({ method: 'DELETE', url: `/api/games/${id}?downloaded=1` });
  assert.equal((await remove(local.id)).statusCode, 409);
  writeFileSync(path.join(destination, file), 'replaced by the owner');
  assert.equal((await remove(downloaded.id)).statusCode, 409);
  assert.equal(readFileSync(path.join(destination, file), 'utf8'), 'replaced by the owner');
  writeFileSync(path.join(destination, file), bytes);
  assert.equal((await remove(downloaded.id)).statusCode, 204);
  app.scan.start('full');
  await app.scan.idle();
  assert.equal(app.library.count(), 2);
  assert.deepEqual(readdirSync(destination), []);
});

test('the direct mirror retrieves only the indexed JAR and verifies it across permitted redirects', async () => {
  const jar = Buffer.from(makeJar('Example'));
  const build = archiveBuild(jar, { title: 'Example', filename: 'Example.jar' });
  const requests = [];
  let wrong = false;
  const mirror = new JarMirror(async url => {
    requests.push(url.href);
    if (url.pathname.startsWith('/api/datasets/')) {
      return Response.json([{ type: 'file', size: jar.length, path: 'Games/Example.jar', lfs: { oid: build.sha256, size: jar.length } }]);
    }
    if (url.hostname === 'huggingface.co') return Response.redirect('https://us.aws.cdn.hf.co/xet-bridge-us/fixture/fixture?signature');
    return new Response(wrong ? Buffer.alloc(jar.length) : jar);
  });
  assert.deepEqual(await mirror.download(build, new AbortController().signal), jar);
  assert.equal(requests.length, 3);
  wrong = true;
  assert.equal(await mirror.download(build, new AbortController().signal), null);
  assert.equal(requests.length, 5, 'the listing is shared across transfers');
});

test('free metadata uses Java ME screenshots and only a verified build for display size', async t => {
  const dir = tmpDir();
  const library = new Library(dir);
  t.after(() => { library.close(); rmSync(dir, { recursive: true, force: true }); });
  const bytes = makeJar('Asphalt3');
  const game = library.add(bytes, null, 1000000).game;
  const entry = archiveBuild(bytes, { title: 'Asphalt 3: Street Rules', filename: 'Street Rules 240x320.jar' });
  const shot = '/media/screenshots/a/street-rules/demo.png';
  const validPng = Buffer.from('89504e470d0a1a0a0000000d', 'hex');
  const service = new JavaCatalog(library, sha => sha === entry.sha256 ? entry : null, async url => {
    if (url.hostname === 'raw.githubusercontent.com') return Response.json({ entries: [
      { id: 'ma:asphalt-3-street-rules-w1t', title: 'Asphalt 3: Street Rules', genres: ['Racing'], listed_year: '2007', resolutions_as_labeled: ['128x160'] },
      { id: 'ma:asphalt-3-3d-street-rules-vx0', title: 'Asphalt 3 3D: Street Rules' },
    ] });
    if (url.pathname === shot) return new Response(validPng);
    assert.equal(url.pathname, '/game/asphalt-3-street-rules-w1t');
    return new Response(`<meta name="description" content="A J2ME racing game &amp; sequel">
      <script>const platformGalleries = ${JSON.stringify({ DOS: { items: [{ src: '/media/screenshots/a/pc.png' }] },
        J2ME: { items: [{ src: shot }, { src: 'https://outside.invalid/unsafe.png' }] } })};</script>`);
  });
  t.after(() => service.close());
  assert.deepEqual(await service.lookup(game), { title: 'Asphalt 3: Street Rules',
    sourceUrl: 'https://www.myabandonware.com/game/asphalt-3-street-rules-w1t', genres: ['Racing'], description: 'A J2ME racing game & sequel', year: 2007, screenshots: 1 });
  assert.deepEqual(library.get(game.id).nativeResolution, { width: 240, height: 320, source: 'J2ME Archive' });
  assert.deepEqual(await service.screenshot(game, 1), { bytes: validPng, type: 'image/png' });
  assert.equal(await service.screenshot(game, 2), null);
});

test('an unavailable metadata provider keeps index facts and the next lookup can be cancelled and retried', async t => {
  const dir = tmpDir();
  const library = new Library(dir);
  const game = library.add(makeJar('Example Puzzle'), null, 1000000).game;
  const fetching = Promise.withResolvers();
  let mode = 'denied';
  const service = new JavaCatalog(library, () => null, async (url, init) => {
    if (url.hostname === 'raw.githubusercontent.com') return new Response(null, { status: 502 });
    if (url.hostname === 'wakkatobakka.github.io') return Response.json({ entries: [
      { id: 'ma:example-puzzle-demo', title: 'Example Puzzle', genres: ['Puzzle'], listed_year: '2008' },
    ] });
    if (mode === 'denied') return new Response(null, { status: 403 });
    if (mode === 'waiting') {
      fetching.resolve();
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    return new Response('<meta name="description" content="A J2ME puzzle game">');
  });
  library.enrich = item => service.enrich(item);
  t.after(async () => { await service.close(); library.close(); rmSync(dir, { recursive: true, force: true }); });
  const wait = async () => {
    for (let i = 0; service.status()?.state === 'running' && i < 200; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // Give the job's own finally callback time to release the worker.
    await new Promise(resolve => setImmediate(resolve));
    return service.status();
  };
  service.start();
  const partial = await wait();
  assert.equal(partial.state, 'done');
  assert.equal(partial.partial, 1);
  assert.equal(partial.error, 'My Abandonware · HTTP 403');
  assert.equal(service.info(game).partial, true);
  assert.deepEqual(service.info(game).genres, ['Puzzle']);
  mode = 'waiting';
  service.start();
  await fetching.promise;
  assert.equal(service.cancel(), true);
  assert.equal((await wait()).state, 'cancelled');
  assert.equal(service.info(game).partial, true);
  mode = 'working';
  service.start();
  assert.equal((await wait()).matched, 1);
  assert.equal(service.info(game).partial, undefined);
  assert.equal(service.info(game).description, 'A J2ME puzzle game');
});
