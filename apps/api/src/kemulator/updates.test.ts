import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { testConfig, tmpDir } from '../dev/testing.js';
import { KemulatorUpdates } from './updates.js';

const file = 'mgo-kemulator-v2.22.1-bridge1-linux-amd64.zip';
const commit = '02d5822d2dad15759666872e76249c0f77703ca1';
const jar = zipSync({
  'emulator/ui/bridge/BridgeFrontend.class': new Uint8Array([1]),
  'res/presets.xml': strToU8('<presets><preset name="240x320 (COMMON)" layout="Nokia"><define name="SCREEN_WIDTH" value="240"/><define name="SCREEN_HEIGHT" value="320"/></preset></presets>'),
});
const archive = zipSync({ 'KEM_VERSION': strToU8('2.22.1\n'), 'KEM_COMMIT': strToU8(commit), 'KEmulator.jar': jar });

function fixture(t: { after: (fn: () => void) => void }) {
  const root = tmpDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundled = path.join(root, 'bundled');
  mkdirSync(bundled);
  writeFileSync(path.join(bundled, 'KEM_COMMIT'), '9ec1005af5448bca63a420e1dfa884ef53842d0f\n');
  writeFileSync(path.join(bundled, 'KEmulator.jar'), jar);
  const config = testConfig({ dataDir: root, kemDir: bundled });
  let asset: Uint8Array = archive;
  let served: Uint8Array = archive;
  const requests: string[] = [];
  const fetcher: typeof fetch = async url => {
    requests.push(String(url));
    if (String(url).endsWith('/latest')) {
      return Response.json({ tag_name: '1.1.0', assets: [{ name: file, size: asset.length, digest: 'sha256:' + createHash('sha256').update(asset).digest('hex') }] });
    }
    return new Response(Buffer.from(served));
  };
  return { bundled, config, fetcher, requests, serve: (value: Uint8Array, declare: boolean) => { served = value; if (declare) asset = value; } };
}

test('chooses only a newer MGO Bridge build and persists activation across a restart', async t => {
  const f = fixture(t);
  const updates = new KemulatorUpdates(f.config, f.fetcher, 'http://gateway:9090');
  assert.equal(updates.status().version, '2.22');
  const release = (await updates.check())!;
  assert.equal(release.version, '2.22.1');
  await assert.rejects(updates.install('9.0.0', release.sha256), /changed/);
  const running = updates.install(release.version, release.sha256);
  await assert.rejects(updates.install(release.version, release.sha256), /already running/);
  assert.equal((await running).version, '2.22.1');
  assert.equal(await updates.check(), null);
  assert.ok(f.requests.includes(`http://gateway:9090/mgo-updates/download/1.1.0/${file}`));
  assert.ok(existsSync(path.join(f.config.kemDir, 'KEmulator.jar')));
  const restarted = { ...f.config, kemDir: f.bundled };
  const restored = new KemulatorUpdates(restarted, f.fetcher);
  assert.equal(restored.status().version, '2.22.1');
  assert.equal(restored.restoreBundled().version, '2.22');
  assert.equal(restarted.kemDir, f.bundled);
});

test('a damaged or unsafe update keeps the bundled runtime active', async t => {
  const f = fixture(t);
  const updates = new KemulatorUpdates(f.config, f.fetcher, 'http://gateway:9090');
  f.serve(new Uint8Array(archive.length), false);
  const release = (await updates.check())!;
  await assert.rejects(updates.install(release.version, release.sha256), /checksum/);
  assert.equal(f.config.kemDir, f.bundled);
  f.serve(zipSync({ '../outside': strToU8('unsafe') }), true);
  const unsafe = (await updates.check())!;
  await assert.rejects(updates.install(unsafe.version, unsafe.sha256), /Invalid KEmulator runtime archive/);
  assert.equal(f.config.kemDir, f.bundled);
  assert.equal(existsSync(path.join(f.config.dataDir, 'kemulator-runtime', 'active')), false);
});
