import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkControl, safeName } from './policy.mts';

describe('control policy (what a client may ask EKA2L1)', () => {
  const inputDir = '/data/run/abc/in';
  const ok = (method: string, pathname: string, body: unknown = null) => checkControl({ method, pathname, body, inputDir }) === null;
  it('allows what the adapter needs', () => {
    assert.ok(ok('GET', '/v1/status'));
    assert.ok(ok('GET', '/v1/screenshot'));
    assert.ok(ok('POST', '/v1/input/key', {}));
    assert.ok(ok('POST', '/v1/apps/0x2000A001/launch', {}));
    assert.ok(ok('POST', '/v1/devices/RM-84/boot', {}));
    assert.ok(ok('DELETE', '/v1/session'));
  });
  it('blocks host file access, configuration, card management and device install/delete', () => {
    assert.ok(!ok('GET', '/v1/files'));
    assert.ok(!ok('PUT', '/v1/files'));
    assert.ok(!ok('DELETE', '/v1/files'));
    assert.ok(!ok('GET', '/v1/config'));
    assert.ok(!ok('PATCH', '/v1/config'));
    assert.ok(!ok('PUT', '/v1/card'));
    assert.ok(!ok('POST', '/v1/devices', {}));
    assert.ok(!ok('DELETE', '/v1/devices/RM-84'));
    assert.ok(!ok('DELETE', '/v1/apps/0x2000A001'));
    assert.ok(!ok('GET', '/v2/anything'));
  });
  it('installs only from the instance upload directory, with a known type', () => {
    assert.ok(ok('POST', '/v1/apps', { path: `${inputDir}/game.sis`, type: 'sis' }));
    assert.ok(ok('POST', '/v1/apps', { path: `${inputDir}/card`, type: 'ngage' }));
    assert.ok(!ok('POST', '/v1/apps', { path: '/etc/passwd', type: 'sis' }));
    assert.ok(!ok('POST', '/v1/apps', { path: `${inputDir}/../../../etc/passwd`, type: 'sis' }));
    assert.ok(!ok('POST', '/v1/apps', { path: inputDir, type: 'sis' }));
    assert.ok(!ok('POST', '/v1/apps', { paths: [`${inputDir}/a.sis`, '/root/x.sis'], type: 'sis' }));
    assert.ok(!ok('POST', '/v1/apps', { path: `${inputDir}/a.sis`, type: 'host' }));
    assert.ok(checkControl({ method: 'POST', pathname: '/v1/apps', body: { path: `${inputDir}/a.sis` }, inputDir: null }));
  });
  it('accepts only plain file names for uploads', () => {
    assert.equal(safeName('Game (1).sis'), 'Game (1).sis');
    for (const bad of ['../x.sis', 'a/b.sis', '.hidden', 'a\\b', '', 'x'.repeat(200), 'a\0b']) assert.equal(safeName(bad), null, bad);
  });
});
