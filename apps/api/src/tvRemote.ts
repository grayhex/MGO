import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { TV_KEYS, type TvModeState, type TvNotice } from '@mgo/protocol';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

export const TV_RELAY = '/api/tv/relay';
export const TV_REMOTE = '/api/tv/remote';
const CODE_TTL = 120_000;
const ATTEMPT_WINDOW = 60_000;
const MAX_TVS = 32;
const MAX_REMOTES = 64;

interface Tv {
  socket: WebSocket;
  code?: { value: string; expires: number };
  pending?: { socket: WebSocket; check: string; expires: number; attempts: number };
  remote?: WebSocket;
  ticket?: string;
  mode: TvModeState;
}

function send(socket: WebSocket | undefined, message: TvNotice): void {
  if (socket?.readyState !== 1) return;
  if (socket.bufferedAmount > 64 * 1024) { socket.terminate(); return; }
  socket.send(JSON.stringify(message));
}

function fromApplication(origin: string | undefined, host: string | undefined): boolean {
  try { return !!origin && !!host && new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

function listen(socket: WebSocket, receive: (value: Record<string, unknown>) => void, done: () => void): void {
  let alive = true;
  let count = 0;
  let windowStart = Date.now();
  const heartbeat = setInterval(() => {
    if (!alive) { socket.terminate(); return; }
    alive = false;
    socket.ping();
  }, 4000);
  socket.on('pong', () => { alive = true; });
  socket.on('message', (data, binary) => {
    const now = Date.now();
    if (now - windowStart > 1000) { count = 0; windowStart = now; }
    if (binary || ++count > 100 || data.toString().length > 2048) { socket.close(1008, 'Invalid remote traffic'); return; }
    try {
      const value: unknown = JSON.parse(data.toString());
      if (value && typeof value === 'object' && !Array.isArray(value)) receive(value as Record<string, unknown>);
    } catch { socket.close(1008, 'Invalid remote message'); }
  });
  socket.on('error', () => socket.terminate());
  socket.once('close', () => { clearInterval(heartbeat); done(); });
}

export function registerTvRemote(app: FastifyInstance, now = Date.now): () => void {
  const tvs = new Set<Tv>();
  const remotes = new Set<WebSocket>();
  const attempts = new Map<string, { expiry: number; count: number }>();
  const permit = (ip: string) => {
    const time = now();
    const blocked = (key: string, limit: number) => {
      let entry = attempts.get(key);
      if (!entry || entry.expiry <= time) {
        entry = { expiry: time + ATTEMPT_WINDOW, count: 0 };
        attempts.set(key, entry);
      }
      return ++entry.count > limit;
    };
    for (const [key, entry] of attempts) if (entry.expiry <= time) attempts.delete(key);
    return !blocked(ip, 10) && !blocked('', 60);
  };
  const revoke = (tv: Tv) => {
    send(tv.socket, { t: 'release' });
    tv.pending?.socket.close(4403, 'Pairing cancelled');
    tv.remote?.close(4403, 'Controller removed');
    delete tv.code;
    delete tv.pending;
    delete tv.remote;
    delete tv.ticket;
    send(tv.socket, { t: 'unpaired' });
  };
  const approve = (tv: Tv, check: unknown) => {
    const pending = tv.pending;
    if (!pending || pending.expires <= now() || pending.check !== check || pending.socket.readyState !== 1) return false;
    delete tv.pending;
    tv.remote = pending.socket;
    tv.ticket = randomBytes(24).toString('hex');
    send(tv.remote, { t: 'paired', ticket: tv.ticket });
    send(tv.remote, { t: 'mode', mode: tv.mode });
    send(tv.socket, { t: 'paired' });
    return true;
  };

  app.get(TV_RELAY, { websocket: true }, (socket, req) => {
    if (!fromApplication(req.headers.origin, req.headers.host) || tvs.size >= MAX_TVS) { socket.close(1008); return; }
    const tv: Tv = { socket, mode: { view: 'navigation', revision: 0 } };
    tvs.add(tv);
    listen(socket, value => {
      switch (value.t) {
        case 'code': {
          if (tv.ticket || tv.pending) return;
          let code: string;
          do { code = String(randomInt(10000000, 100000000)); } while ([...tvs].some(item => item.code?.value === code));
          tv.code = { value: code, expires: now() + CODE_TTL };
          send(socket, { t: 'code', code, expires: tv.code.expires });
          break;
        }
        case 'approve': approve(tv, value.check); break;
        case 'revoke': revoke(tv); break;
        case 'mode': {
          const { view, revision } = value;
          if (view !== 'navigation' && view !== 'game' && view !== 'search' && view !== 'address') return;
          if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= tv.mode.revision) return;
          tv.mode = { view, revision };
          send(tv.remote, { t: 'mode', mode: tv.mode });
          break;
        }
      }
    }, () => { tvs.delete(tv); revoke(tv); });
  });

  app.get(TV_REMOTE, { websocket: true }, (socket, req) => {
    if (!fromApplication(req.headers.origin, req.headers.host) || remotes.size >= MAX_REMOTES) { socket.close(1008); return; }
    let tv: Tv | undefined;
    remotes.add(socket);
    let unused = setTimeout(() => socket.close(4408, 'Pairing timed out'), CODE_TTL);
    const error = (message: string) => send(socket, { t: 'error', message });
    listen(socket, value => {
      if (tv?.remote === socket) {
        const { revision, t, key, down } = value;
        if (t === 'release') send(tv.socket, { t: 'release' });
        if (revision !== tv.mode.revision) return;
        if (t === 'key' && typeof down === 'boolean' && TV_KEYS.some(allowed => allowed === key)) {
          send(tv.socket, { t: 'key', key: key as typeof TV_KEYS[number], down, revision: tv.mode.revision });
        }
        if (t === 'text' && (tv.mode.view === 'search' || tv.mode.view === 'address') && typeof value.value === 'string') {
          send(tv.socket, { t: 'text', value: value.value.slice(0, 200), revision: tv.mode.revision });
        }
        return;
      }
      if (tv) {
        if (tv.pending?.socket !== socket || value.t !== 'verify') return;
        if (approve(tv, value.check)) { clearTimeout(unused); return; }
        if (++tv.pending.attempts >= 4 || tv.pending.expires <= now()) { revoke(tv); return; }
        error('Enter the confirmation number now shown on the TV.');
        return;
      }
      if (value.t !== 'claim' && value.t !== 'resume') return;
      if (!permit(req.ip)) { socket.close(4429, 'Too many pairing attempts'); return; }
      if (value.t === 'claim') {
        const code = value.code;
        if (typeof code !== 'string' || !/^\d{8}$/.test(code)) return error('Enter the eight digits shown on the TV.');
        tv = [...tvs].find(item => item.code?.value === code && item.code.expires > now() && item.socket.readyState === 1);
        if (!tv) return error('Pairing code expired or invalid.');
        delete tv.code;
        const check = String(randomInt(100000, 1000000));
        tv.pending = { socket, check, expires: now() + CODE_TTL, attempts: 0 };
        send(tv.socket, { t: 'pending', check });
        send(socket, { t: 'pending' });
        clearTimeout(unused);
        unused = setTimeout(() => { if (tv?.pending?.socket === socket) socket.close(4408, 'Pairing timed out'); }, CODE_TTL);
        return;
      } else {
        const ticket = value.ticket;
        if (typeof ticket !== 'string' || !/^[a-f0-9]{48}$/.test(ticket)) return error('Pair this phone again.');
        const candidate = Buffer.from(ticket);
        tv = [...tvs].find(item => item.ticket && timingSafeEqual(Buffer.from(item.ticket), candidate) && item.socket.readyState === 1);
        if (!tv) return error('Pair this phone again.');
        send(tv.socket, { t: 'release' });
        tv.remote?.close(4409, 'Reconnected');
        tv.remote = socket;
        send(tv.socket, { t: 'paired' });
        send(socket, { t: 'paired' });
        send(socket, { t: 'mode', mode: tv.mode });
      }
      clearTimeout(unused);
    }, () => {
      clearTimeout(unused);
      remotes.delete(socket);
      if (tv?.pending?.socket === socket) {
        delete tv.pending;
        send(tv.socket, { t: 'unpaired' });
      }
      if (tv?.remote === socket) {
        delete tv.remote;
        send(tv.socket, { t: 'release' });
        send(tv.socket, { t: 'remote-offline' });
      }
    });
  });

  return () => {
    for (const tv of tvs) tv.socket.terminate();
    for (const socket of remotes) socket.terminate();
  };
}
