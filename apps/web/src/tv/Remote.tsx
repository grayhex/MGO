import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { TvKey, TvModeState, TvNotice } from '@mgo/protocol';
import { t, useLocale } from '../i18n';
import { useTheme } from '../theme';
import { tvSocketUrl } from './relay';

const TICKET = 'mgo.tv.remote-ticket';
const initialMode: TvModeState = { view: 'navigation', revision: 0 };
const readTicket = () => {
  try { return sessionStorage.getItem(TICKET); } catch { return null; }
};
function rememberTicket(value?: string) {
  try { if (value) sessionStorage.setItem(TICKET, value); else sessionStorage.removeItem(TICKET); } catch { /* optional */ }
}

export default function Remote() {
  useLocale();
  useTheme();
  const [code, setCode] = useState(() => /^#\d{8}$/.test(location.hash) ? location.hash.slice(1) : '');
  const codeRef = useRef(code);
  const ticket = useRef(code ? null : readTicket());
  const socket = useRef<WebSocket>();
  const held = useRef(new Map<number, TvKey>());
  const [mode, setMode] = useState(initialMode);
  const modeRef = useRef(mode);
  const [status, setStatus] = useState<'offline' | 'ready' | 'pending' | 'paired'>('offline');
  const [check, setCheck] = useState('');
  const [error, setError] = useState('');
  const [value, setValue] = useState('');
  const send = (message: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  };
  const release = () => { if (held.current.size) send({ t: 'release' }); held.current.clear(); };

  useEffect(() => {
    if (location.hash) {
      if (codeRef.current) rememberTicket();
      history.replaceState(null, '', '/remote');
    }
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(tvSocketUrl('remote'));
      socket.current = ws;
      ws.onopen = () => {
        if (disposed) return;
        setStatus('ready');
        if (ticket.current) send({ t: 'resume', ticket: ticket.current });
        else if (codeRef.current) send({ t: 'claim', code: codeRef.current });
      };
      ws.onmessage = event => {
        if (disposed) return;
        const notice = JSON.parse(event.data) as TvNotice;
        if (notice.t === 'mode') {
          held.current.clear();
          modeRef.current = notice.mode;
          setMode(notice.mode);
          setValue('');
        } else if (notice.t === 'pending') {
          codeRef.current = '';
          setCheck('');
          setError('');
          setStatus('pending');
        } else if (notice.t === 'paired') {
          if (notice.ticket) { ticket.current = notice.ticket; rememberTicket(notice.ticket); }
          setError('');
          setStatus('paired');
        } else if (notice.t === 'error') {
          ticket.current = null;
          codeRef.current = '';
          rememberTicket();
          setError(notice.message);
          setStatus(current => current === 'pending' ? current : 'ready');
        }
      };
      ws.onclose = event => {
        if (disposed) return;
        held.current.clear();
        setStatus('offline');
        if (event.code === 4403 || event.code === 4409) {
          ticket.current = null;
          codeRef.current = '';
          rememberTicket();
          setError(event.code === 4409 ? 'The controller was opened in another tab.' : 'The TV ended pairing.');
        } else if (event.code === 4429) {
          setError('Too many pairing attempts. Wait one minute.');
          codeRef.current = '';
          reconnect = setTimeout(connect, 60_000);
          return;
        } else if (!ticket.current) {
          setError('Cannot connect to the TV. Check the address and trust its HTTPS certificate.');
        }
        reconnect = setTimeout(connect, 1000);
      };
    };
    const hidden = () => { if (document.hidden) release(); };
    connect();
    window.addEventListener('blur', release);
    window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      release();
      window.removeEventListener('blur', release);
      window.removeEventListener('pagehide', release);
      document.removeEventListener('visibilitychange', hidden);
      socket.current?.close();
    };
  }, []);

  function press(event: PointerEvent<HTMLButtonElement>, key: TvKey) {
    event.preventDefault();
    if (held.current.has(event.pointerId)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const already = [...held.current.values()].includes(key);
    held.current.set(event.pointerId, key);
    if (!already) send({ t: 'key', key, down: true, revision: modeRef.current.revision });
  }

  function lift(event: PointerEvent<HTMLButtonElement>) {
    const key = held.current.get(event.pointerId);
    if (!key) return;
    held.current.delete(event.pointerId);
    if (![...held.current.values()].includes(key)) send({ t: 'key', key, down: false, revision: modeRef.current.revision });
  }

  function button(key: TvKey, label: string, name = label) {
    return <button type="button" key={key} aria-label={t(name)} data-remote-key={key}
      onPointerDown={event => press(event, key)} onPointerUp={lift} onPointerCancel={lift} onLostPointerCapture={lift}
      onContextMenu={event => event.preventDefault()} onClick={event => {
        if (event.detail !== 0) return;
        const revision = modeRef.current.revision;
        send({ t: 'key', key, down: true, revision });
        send({ t: 'key', key, down: false, revision });
      }}>{t(label)}</button>;
  }

  return <main className="tv-remote">
    <header><h1>{t('MGO remote')}</h1><span role="status">{t(status === 'paired' ? 'Connected' : status === 'pending' ? 'Waiting for TV approval' : status === 'ready' ? 'Ready to pair' : 'Connecting…')}</span></header>
    {error && <p className="note warn" role="alert">{t(error)}</p>}
    {status === 'pending' ? <form onSubmit={event => { event.preventDefault(); send({ t: 'verify', check }); }}>
      <p>{t('Approve on the TV or enter the confirmation number shown there.')}</p>
      <label>{t('TV confirmation number')}<input className="input" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" value={check} onChange={event => setCheck(event.target.value.replace(/\D/g, '').slice(0, 6))} required /></label>
      <button className="btn primary" disabled={check.length !== 6}>{t('Confirm pairing')}</button>
    </form>
      : status !== 'paired' ? <form onSubmit={event => { event.preventDefault(); codeRef.current = code; send({ t: 'claim', code }); }}>
        <label>{t('Pairing code')}<input className="input" inputMode="numeric" autoComplete="off" pattern="[0-9]{8}" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))} required /></label>
        <button className="btn primary" disabled={status !== 'ready' || code.length !== 8}>{t('Pair with TV')}</button>
      </form> : <>
        <div className="remote-global">{button('menu', 'Menu')}{button('back', 'Back')}</div>
        {(mode.view === 'search' || mode.view === 'address') && <label className="remote-text">
          {t(mode.view === 'search' ? 'Search games' : 'LAN address')}
          <input className="input" value={value} maxLength={200} onChange={event => {
            setValue(event.target.value);
            send({ t: 'text', value: event.target.value, revision: mode.revision });
          }} />
        </label>}
        <div className="remote-pad" aria-label={t('Directional pad')}>
          {button('up', '▲', 'D-pad up')}{button('left', '◀', 'D-pad left')}
          {button('fire', mode.view === 'game' ? 'Fire' : 'OK')}{button('right', '▶', 'D-pad right')}{button('down', '▼', 'D-pad down')}
        </div>
        {mode.view === 'game' && <>
          <div className="remote-soft">{button('softLeft', 'Left soft key')}{button('softRight', 'Right soft key')}</div>
          <div className="remote-digits">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => button(`d${n}` as TvKey, String(n)))}
            {button('star', '*')}{button('d0', '0')}{button('pound', '#')}
          </div>
          <div className="remote-global">{button('clear', 'Clear (C)')}</div>
        </>}
      </>}
  </main>;
}
