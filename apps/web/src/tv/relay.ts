import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TvModeState, TvNotice, TvRemoteInput, TvView } from '@mgo/protocol';

export const tvSocketUrl = (kind: 'relay' | 'remote') =>
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/tv/${kind}`;

export function pairingUrl(origin: string, code?: string): string | null {
  try {
    const address = new URL(origin);
    const host = address.hostname.toLowerCase().replace(/\.$/, '');
    if (!/^https?:$/.test(address.protocol) || address.username || address.password || address.pathname !== '/' ||
        address.search || address.hash || !host || host === 'localhost' || host.endsWith('.localhost') ||
        /^(127\.|0\.|\[::)/.test(host)) return null;
    return new URL('/remote' + (code ? `#${code}` : ''), address.origin).href;
  } catch { return null; }
}

export function useTvRelay(view: TvView, onInput: (input: TvRemoteInput) => void) {
  const socket = useRef<WebSocket | null>(null);
  const receive = useRef(onInput);
  receive.current = onInput;
  const mode = useRef<TvModeState>({ view, revision: 1 });
  const [online, setOnline] = useState(false);
  const [notice, setNotice] = useState<TvNotice>({ t: 'unpaired' });
  const send = useCallback((message: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  useLayoutEffect(() => {
    mode.current = { view, revision: mode.current.revision + 1 };
    send({ t: 'mode', ...mode.current });
  }, [view, send]);

  useEffect(() => {
    let disposing = false;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(tvSocketUrl('relay'));
      socket.current = ws;
      ws.onopen = () => { if (!disposing) { setOnline(true); send({ t: 'mode', ...mode.current }); } };
      ws.onmessage = event => {
        if (disposing) return;
        const next = JSON.parse(event.data) as TvNotice;
        if (next.t === 'release') receive.current(next);
        else if (next.t === 'key' || next.t === 'text') {
          if (next.revision === mode.current.revision) receive.current(next);
        } else setNotice(next);
      };
      ws.onclose = () => {
        if (disposing) return;
        receive.current({ t: 'release' });
        setNotice({ t: 'unpaired' });
        setOnline(false);
        timer = setTimeout(connect, 1200);
      };
    };
    connect();
    return () => {
      disposing = true;
      clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
    };
  }, [send]);

  return { online, notice, send };
}
