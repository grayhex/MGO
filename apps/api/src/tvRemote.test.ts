import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { TvNotice } from '@mgo/protocol';
import { WebSocket } from 'ws';
import { registerTvRemote, TV_RELAY, TV_REMOTE } from './tvRemote.js';

test('TV controller codes expire, require approval, are session-specific and release keys on reconnect and revocation', async () => {
  let now = Date.now();
  const app = fastify();
  await app.register(websocket);
  const stop = registerTvRemote(app, () => now);
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const connect = async (route: string) => {
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + route, { origin });
    const inbox: TvNotice[] = [];
    ws.on('message', data => inbox.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    return {
      ws, inbox, send: (value: object) => ws.send(JSON.stringify(value)),
      async next<T extends TvNotice['t']>(type: T) {
        for (let i = 0; i < 100; i++) {
          const found = inbox.findIndex(item => item.t === type);
          if (found >= 0) return inbox.splice(found, 1)[0] as Extract<TvNotice, { t: T }>;
          await sleep(10);
        }
        throw Error(`Did not receive ${type}; received ${inbox.map(item => item.t).join(', ')}`);
      },
    };
  };
  try {
    const tv1 = await connect(TV_RELAY);
    const tv2 = await connect(TV_RELAY);
    const remote = await connect(TV_REMOTE);
    tv1.send({ t: 'code' });
    const stale = await tv1.next('code');
    now += 121_000;
    remote.send({ t: 'claim', code: stale.code });
    assert.match((await remote.next('error')).message, /expired/);
    tv1.send({ t: 'code' });
    tv2.send({ t: 'code' });
    const { code } = await tv1.next('code');
    const other = await tv2.next('code');
    assert.notEqual(code, other.code);
    tv1.send({ t: 'mode', view: 'game', revision: 4 });
    remote.send({ t: 'claim', code });
    const { check } = await tv1.next('pending');
    assert.match(check ?? '', /^\d{6}$/);
    assert.equal((await remote.next('pending')).check, undefined, 'the second code is only visible on the TV');
    const imposter = await connect(TV_REMOTE);
    imposter.send({ t: 'claim', code });
    await imposter.next('error');
    remote.send({ t: 'key', key: 'fire', down: true, revision: 4 });
    remote.send({ t: 'verify', check: 'wrong' });
    await remote.next('error');
    assert.equal(tv1.inbox.some(event => event.t === 'key'), false);
    remote.send({ t: 'verify', check });
    await tv1.next('paired');
    const registered = await remote.next('paired');
    assert.match(registered.ticket ?? '', /^[a-f0-9]{48}$/);
    assert.deepEqual((await remote.next('mode')).mode, { view: 'game', revision: 4 });
    remote.send({ t: 'key', key: 'fire', down: true, revision: 3 });
    remote.send({ t: 'key', key: 'raw', down: true, revision: 4 });
    remote.send({ t: 'key', key: 'd9', down: true, revision: 4 });
    assert.equal((await tv1.next('key')).key, 'd9');
    assert.equal(tv2.inbox.length, 0);
    remote.ws.close();
    await tv1.next('release');
    await tv1.next('remote-offline');

    const resumed = await connect(TV_REMOTE);
    resumed.send({ t: 'resume', ticket: registered.ticket });
    await resumed.next('paired');
    await tv1.next('release');
    assert.deepEqual((await resumed.next('mode')).mode, { view: 'game', revision: 4 });
    assert.equal(tv1.inbox.some(event => event.t === 'key'), false, 'reconnection replays no held key');
    tv1.send({ t: 'revoke' });
    await tv1.next('unpaired');
    const revoked = await connect(TV_REMOTE);
    revoked.send({ t: 'resume', ticket: registered.ticket });
    assert.match((await revoked.next('error')).message, /again/);
    const crossSite = new WebSocket(origin.replace(/^http/, 'ws') + TV_REMOTE, { origin: 'http://some-other-host.test' });
    assert.equal((await once(crossSite, 'close'))[0], 1008);
  } finally { stop(); await app.close(); }
});
