import { PlayerResources } from './PlayerResources';
import { useNativePhone } from '../nativePhone';
import { NativeTestingPanel } from './NativeTestingPanel';
import { StartFailureCard } from './StartFailureCard';
import { t as translateUI } from '../i18n';
import { useDeveloperMode } from '../developer';
import { isPhoneId, resolvePhone, EMULATED_DEVICES, PHONE_COMPATIBILITY, skinSupportsPlatform } from '@mgo/protocol';
import { TextEditor } from './TextEditor';
import { RecordingPanel } from './RecordingPanel';
import { getLastGame, setLastGame } from '../lastGame';
import { navigate } from '../router';
import { EmulationTweaksForm } from './EmulationTweaksForm';
import { Recorder, Replayer } from '../recording';
import { downloadBlob, fileSafe, framePng } from '../snapshot';
import { GamepadPoller, loadPadProfile, type PadAction, type PadState } from '../gamepad';
import { GamepadSettings } from './GamepadSettings';
import { phoneHasTouch, KEY_LAYOUTS, SCREEN_PRESETS, type PhoneCatalog, type DevicePreset, type EmulationTweaks, type GameMeta, type HealthStatus, type LayoutId, type ServerEvent, type SessionState, type SessionStatus } from '@mgo/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError, type JarAnalysisView } from '../api';
import type { Toast } from '../App';
import { PcmAudio } from '../audio';
import { InputController } from '../input';
import { isSkinId, useCatalog, usePrefs, useSkin } from '../skin/registry';
import { keypadCrops } from '../skin/hitboxes';
import { PhoneSkin } from '../skin/PhoneSkin';
import type { LoadedSkin } from '../skin/types';
import { useHeld } from '../skin/useHeld';
import { SessionStream } from '../stream';
import { Icon } from './Icon';
import { KeyMapDialog } from './KeyMapDialog';
import { Keypad } from './Keypad';
import { Modal } from './Modal';
import { Hint, Meter, Panel, Seg, Spark, Switch } from './ui';
import { audioSettings, buzz, controlSettings, getServerSettings, useServerSettings } from '../serverSettings';
import { betterPhone, type PhoneOption } from '../betterPhone';
import { nextRotation, unrotatePoint, type Rotation } from '../skin/geometry';
import { useRotation } from '../skin/rotation';
import { VolumeSlider } from './VolumeSlider';

type Conn = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'idle';

const STATE_BADGE: Record<string, string> = { running: 'prod', starting: 'dev', stopping: 'dev', failed: 'danger', exited: '', idle: '' };
const KEYPAD_WIDTHS = ['100', '150', '200'] as const;
type KeypadWidth = typeof KEYPAD_WIDTHS[number];
function getControlPreference(key: string): string | null {
  try { return localStorage.getItem(`mgo.player.${key}`); } catch { return null; }
}
function saveControlPreference(key: string, value: string): void {
  try { localStorage.setItem(`mgo.player.${key}`, value); } catch { /* browser storage is optional */ }
}

export function Player({ gameId, autoStart, onAutoStartConsumed, toast, onExit, health }: { gameId: string; autoStart: boolean; onAutoStartConsumed: () => void; toast: (k: Toast['kind'], t: string) => void; onExit: () => void; health: HealthStatus | null }) {
  const developer=useDeveloperMode();
  const [game, setGame] = useState<GameMeta | null>(null);
  const [failure, setFailure] = useState<{ failure: import('@mgo/protocol').StartFailure; sessionId: string | null } | null>(null);
  const j2me = (game?.platform ?? 'j2me') === 'j2me'; // Symbian and N-Gage games (EKA2L1) have no heap, J2ME profile or game speed
  const native = useNativePhone(game);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [state, setState] = useState<SessionState | 'idle'>('idle');
  const [conn, setConn] = useState<Conn>('idle');
  const [softkeys, setSoftkeys] = useState({ left: '', right: '' });
  const [title, setTitle] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [server, setServer] = useState<{ fps: number; dropped: number; latencyMs: number | null }>({ fps: 0, dropped: 0, latencyMs: null });
  const [client, setClient] = useState({ fps: 0, rtt: null as number | null, decode: 0, kbps: 0 });
  const [fpsHist, setFpsHist] = useState<number[]>([]);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const recorder = useRef(new Recorder()).current;
  const replayer = useRef(new Replayer()).current;
  const [link, setLink] = useState<string | null>(null);
  const [showFps, setShowFpsState] = useState(() => { try { return localStorage.getItem('j2me-web.fps') === '1'; } catch { return false; } });
  const setShowFps = (v: boolean) => { setShowFpsState(v); try { localStorage.setItem('j2me-web.fps', v ? '1' : '0'); } catch { /* storage unavailable */ } };
  const [fps, setFps] = useState(0);
  const framesSeen = useRef(0);
  const [pauseInfo, setPauseInfo] = useState<{ on: boolean; reason: 'manual' | 'hidden' } | null>(null);
  const [textArea, setTextArea] = useState<Extract<ServerEvent, { t: 'text' }>['area']>(null);
  const [menu, setMenu] = useState<Extract<ServerEvent, { t: 'menu' }> | null>(null);
  const [perm, setPerm] = useState<Extract<ServerEvent, { t: 'permission' }> | null>(null);
  // Automatic mode synchronizes the skin; Advanced keeps presentation independent.
  const [layout, setLayout] = useState<LayoutId>('nokia');
  const [res, setRes] = useState<{ width: number; height: number } | null>(null);
  const [device, setDevice] = useState('');
  const [heapMb, setHeapMb] = useState(256);
  const [tweaks, setTweaks] = useState<EmulationTweaks>({});
  const [speed, setSpeed] = useState(1);
  const [devices, setDevices] = useState<DevicePreset[]>([]);
  const [analysis, setAnalysis] = useState<{ analysis: JarAnalysisView; recommendedDevice: string | null } | null>(null);
  // Presentation
  const [prefs, setPrefs] = usePrefs();
  const [smooth, setSmooth] = useState(false);
  const [rotation, setRotation] = useRotation(gameId);
  const controls = useServerSettings()?.settings.controls ?? controlSettings();
  const [keypadOverride, setKeypadOverride] = useState<boolean | null>(() => {
    const saved = getControlPreference('keypad');
    return saved === 'on' ? true : saved === 'off' ? false : null;
  });
  const [keypadWidth, setKeypadWidth] = useState<KeypadWidth>(() => {
    const saved = getControlPreference('keypad-width');
    return saved === '100' || saved === '150' ? saved : '200';
  });
  const [gamepadVibration, setGamepadVibration] = useState(() => getControlPreference('gamepad-vibration') !== 'off');
  const vibrationEnabled = useRef(gamepadVibration); vibrationEnabled.current = gamepadVibration;
  const [keymap, setKeymap] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sessionsChecked, setSessionsChecked] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadErrors, setLoadErrors] = useState<Partial<Record<'game' | 'sessions' | 'devices', string>>>({});
  const autoStarted = useRef(false);
  const [padMenu, setPadMenu] = useState(false);
  const padMenuOpen = useRef(false); padMenuOpen.current = padMenu;
  const [padState, setPadState] = useState<PadState>({controllers:[],pressed:[]});
  const gamepad = useRef<GamepadPoller | null>(null);
  const [lights, setLights] = useState(() => { try { return localStorage.getItem('j2me-web.lights.v1') === 'true'; } catch { return false; } });
  const [awake, setAwake] = useState(true);
  const [hudMenu, setHudMenu] = useState(false);
  const [touchControls, setTouchControls] = useState(false);
  const wakeTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(()=>()=>clearTimeout(wakeTimer.current),[]);
  const { skin, error: skinError, retry: retrySkin } = useSkin(loaded ? prefs.skinId : null);
  // A touch-screen monoblock (Nokia 5800, Samsung S5230) is only a display: a "screen only" view means nothing there.
  const monoblock = skin?.config.input?.kind === 'touchscreen';
  const view: 'full' | 'screen' = monoblock && skin?.config.id !== 'nokia-n8' ? 'full' : prefs.view;
  const lightsActive = lights && view === 'screen';
  const wake = () => { setAwake(true); clearTimeout(wakeTimer.current); wakeTimer.current = setTimeout(() => setAwake(false), 2500); };
  useEffect(() => { try { localStorage.setItem('j2me-web.lights.v1', String(lights)); } catch {} }, [lights]);
  useEffect(() => {
    if (!lightsActive) return;
    wake();
    const key = (e: KeyboardEvent) => { if(e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLights(false); } };
    const changed = () => { if (!document.fullscreenElement) setLights(false); };
    window.addEventListener('keydown', key, true);document.addEventListener('fullscreenchange',changed);
    return () => { clearTimeout(wakeTimer.current);window.removeEventListener('keydown',key,true);document.removeEventListener('fullscreenchange',changed); };
  }, [lightsActive]);
  useEffect(() => {
    const key=(e:KeyboardEvent)=>{if(e.altKey && e.code==='KeyL' && !e.repeat){e.preventDefault();setPrefs({view:'screen'});setLights(v=>!v);}};
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  }, []);
  const [pad, setPad] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [frameSize, setFrameSize] = useState({ w: 240, h: 320 });
  const [vol, setVol] = useState(() => { try { return Number(localStorage.getItem('j2me-web.volume') ?? audioSettings().volume); } catch { return audioSettings().volume; } });
  const [muted, setMuted] = useState(() => !audioSettings().enabled);
  const [audioInfo, setAudioInfo] = useState({ state: 'off' as string, rms: 0, buffered: 0 });
  const audio = useMemo(() => new PcmAudio(), []);

  const canvasEl = useRef<HTMLCanvasElement | null>(null);
  const lastFrame = useRef<ImageData | null>(null);
  const card = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const streamRef = useRef<SessionStream | null>(null);
  const sessionRef = useRef<SessionStatus | null>(null);
  const input = useMemo(() => new InputController(() => undefined), []);
  const [bindings, setBindings] = useState(input.bindings);

  const shownSkin = useRef<LoadedSkin | null>(null);
  if (skin) shownSkin.current = skin;

  // The canvas element is created when the skin box has been measured and re-created when the skin component remounts:
  // whatever the emulator drew last is put back, so a static screen never goes blank.
  const setCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvasEl.current = el;
    if (el && lastFrame.current && el.width === lastFrame.current.width && el.height === lastFrame.current.height) el.getContext('2d')!.putImageData(lastFrame.current, 0, 0);
  }, []);
  useEffect(() => {
    const el = canvasEl.current;
    const f = lastFrame.current;
    if (el && f && el.width === f.width && el.height === f.height) el.getContext('2d')!.putImageData(f, 0, 0);
  }, [frameSize.w, frameSize.h, view, prefs.skinId]);

  const sendRaw = useCallback((ev: Parameters<SessionStream['send']>[0]) => streamRef.current?.send(ev), []);
  /** Everything the player does goes through here, so a recording sees it. */
  const send = useCallback((ev: Parameters<SessionStream['send']>[0]) => { recorder.push(ev); sendRaw(ev); }, [recorder, sendRaw]);
  const contacts = useRef(new Map<number, { id: number; x: number; y: number }>());
  const releasePointers = useCallback(() => {
    for (const contact of contacts.current.values()) send({ t: 'pointer', ...contact, s: 'U' });
    contacts.current.clear();
  }, [send]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) releasePointers(); };
    window.addEventListener('blur', releasePointers); document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('blur', releasePointers); document.removeEventListener('visibilitychange', hidden); releasePointers(); };
  }, [releasePointers]);
  useEffect(() => { releasePointers(); }, [prefs.skinId, view, releasePointers]);
  useEffect(() => { input.layout = session && (state === 'running' || state === 'starting') ? session.layout : layout; }, [input, layout, session?.layout, state]);

  const onEvent = useCallback((ev: ServerEvent) => {
    switch (ev.t) {
      case 'hello': setState(ev.state); setFrameSize({ w: ev.width, h: ev.height }); break;
      case 'state':
        setState(ev.state);
        if (ev.state === 'exited' || ev.state === 'failed') {
          input.releaseAll(); gamepad.current?.stopRumble(); replayer.stop(); setTextArea(null); setPauseInfo(null); setSpeed(1);
          if (ev.state === 'failed') toast('error', translateUI('Emulator stopped: {detail}', {detail:ev.detail ?? translateUI('unknown error')}));
        }
        break;
      case 'game-resolution': setGame(current => current ? { ...current, nativeResolution: ev.resolution } : current); break;
      case 'softkeys': setSoftkeys({ left: ev.left, right: ev.right }); break;
      case 'title': setTitle(ev.title); break;
      case 'log': setLog((l) => [...l.slice(-199), ev.line]); break;
      case 'stats': setServer({ fps: ev.fps, dropped: ev.dropped, latencyMs: ev.latencyMs }); break;
      case 'menu': setMenu(ev); break;
      case 'menu-close': setMenu(null); break;
      case 'text': setTextArea(ev.area); break;
      case 'speed': setSpeed(ev.modifier); break;
      case 'paused': setPauseInfo({ on: ev.on, reason: ev.reason }); if (ev.on) gamepad.current?.stopRumble(); break;
      case 'permission': setPerm(ev); break;
      case 'vibrate':
        if (ev.ms > 0) buzz(Math.min(ev.ms, 2000)); else navigator.vibrate?.(0);
        if (vibrationEnabled.current && controlSettings().gamepad && sessionRef.current?.backend === 'kemulator') gamepad.current?.rumble(ev.ms);
        break;
      case 'displayable': break; // the Bridge draws every screen into the framebuffer (patch 0006): the kind needs no UI
      case 'url': setLink(ev.url); break;
      default: break;
    }
  }, [input, toast]);

  const attach = useCallback((s: SessionStatus) => {
    // Native launch monitoring can attach before the POST response arrives.
    // Keep that viewer: reconnecting the same session releases held inputs.
    if (sessionRef.current?.id === s.id && streamRef.current) return;
    gamepad.current?.stopRumble();
    streamRef.current?.close();
    sessionRef.current = s;
    setSession(s); if (s.failure) setFailure({ failure: s.failure, sessionId: s.id }); setSpeed(s.speed ?? 1); setState(s.state); setFrameSize({ w: s.width, h: s.height }); setLog(s.logTail);
    const st = new SessionStream(s.id, {
      onEvent,
      onFrame: (img) => {
        lastFrame.current = img; framesSeen.current++;
        const c = canvasEl.current;
        if (!c) return;
        if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height; setFrameSize({ w: img.width, h: img.height }); }
        c.getContext('2d')!.putImageData(img, 0, 0);
      },
      onAudio: (pcm) => audio.push(pcm),
      onConnection: (cs, closeCode) => {
        setConn(cs);
        if(cs !== 'open') { input.releaseAll(); gamepad.current?.stopRumble(); }
        if (closeCode === 4404) {
          // The stream endpoint only sends 4404 for a missing or ended session.
          setState(current => current === 'failed' ? current : 'exited');
          void api.session(s.id, AbortSignal.timeout(5000)).then(actual => {
            if (streamRef.current === st && actual.state === 'failed') setState(actual.state);
          }, () => undefined);
        }
      },
    });
    streamRef.current = st;
    input.setSend((ev) => { recorder.push(ev as never); st.send(ev as never); });
    st.connect();
  }, [input, onEvent, audio]);

  // Reopen an existing session on reload. Neither artwork nor analysis is needed to do this.
  useEffect(() => {
    const request = new AbortController();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
    const report = (part: keyof typeof loadErrors, error: Error) => {
      if (!request.signal.aborted) setLoadErrors(current => ({ ...current, [part]: error.message }));
    };
    if (!loaded) void api.gameMeta(gameId, signal).then(g => {
      if (request.signal.aborted) return;
      setGame(g);
      setLastGame({ id: g.id, name: g.name });
      const settings = g.settings;
      setLayout(settings.layout);
      setRes({ width: settings.width, height: settings.height });
      setDevice(settings.device ?? '');
      setHeapMb(settings.heapMb);
      setTweaks(settings.emulation ?? {});
      setAdvanced(settings.profileMode === 'advanced');
      const skinId = settings.skinId ?? ((g.platform ?? 'j2me') === 'j2me' ? getServerSettings()?.settings.phone.skinId : null);
      if (isSkinId(skinId)) setPrefs({ skinId });
      setLoaded(true);
    }, (error: ApiError) => {
      if (request.signal.aborted) return;
      if (error.code === 'not_found') {
        if (getLastGame()?.id === gameId) setLastGame(null);
        toast('error', error.message);
        onExit();
      } else report('game', error);
    });
    if (!sessionsChecked) void api.sessions(signal).then(sessions => {
      if (request.signal.aborted) return;
      const existing = sessions.find(s => s.gameId === gameId && (s.state === 'running' || s.state === 'starting'));
      if (existing) attach(existing);
      setSessionsChecked(true);
    }, error => report('sessions', error));
    if (!devices.length) void api.devices(signal).then(result => {
      if (!request.signal.aborted) setDevices(result.presets);
    }, error => report('devices', error));
    return () => request.abort();
    // Preserve a game and any attached session when retrying a failed part of startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, loadAttempt]);

  const javaGameId = loaded && j2me ? gameId : null;
  useEffect(() => {
    if (!javaGameId) return;
    let disposed = false;
    void api.analysis(javaGameId).then(a => { if (!disposed) setAnalysis(a); }, () => undefined);
    return () => { disposed = true; };
  }, [javaGameId]);

  // audio: needs a user gesture, so resume on the first interaction as well as on Start
  useEffect(() => {
    const go = () => { void audio.resume(); };
    window.addEventListener('pointerdown', go, { once: true });
    window.addEventListener('keydown', go, { once: true });
    return () => { window.removeEventListener('pointerdown', go); window.removeEventListener('keydown', go); audio.close(); };
  }, [audio]);
  useEffect(() => { audio.setVolume(vol / 100); try { localStorage.setItem('j2me-web.volume', String(vol)); } catch { /* ignore */ } }, [audio, vol]);
  useEffect(() => { audio.setMuted(muted); }, [audio, muted]);

  // client stats every second, server-side resources every two
  useEffect(() => {
    const t = window.setInterval(() => {
      const s = streamRef.current?.stats; if (!s) return;
      setClient({ fps: s.fps, rtt: s.rttMs, decode: s.decodeMs, kbps: Math.round((s.bytesPerSec * 8) / 1000) });
      setFpsHist((h) => [...h.slice(-39), s.fps]);
      setAudioInfo({ state: audio.stats.state, rms: audio.stats.rms, buffered: audio.stats.bufferedMs });
    }, 1000);
    return () => window.clearInterval(t);
  }, [audio]);
  const live = state === 'running';
  // frames per second that reach this page: what the game really delivers (a small number in the corner of the screen)
  useEffect(() => {
    if (!showFps || !live) return;
    framesSeen.current = 0;
    const t = window.setInterval(() => { setFps(framesSeen.current); framesSeen.current = 0; }, 1000);
    return () => window.clearInterval(t);
  }, [showFps, live]);
  // the game is suspended while no viewer has the page in front of them (the server decides, see Session.syncPause)
  useEffect(() => {
    if (!live || conn !== 'open') return;
    const sync = () => send({ t: 'visibility', visible: !document.hidden });
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [live, conn, send]);
  useEffect(() => {
    const id = session?.id;
    if (!id || !(state === 'running' || state === 'starting')) return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { timer = setTimeout(sample, 2000); };
    const sample = async () => {
      try {
        const s = await api.session(id, AbortSignal.any([request.signal, AbortSignal.timeout(5000)]));
        if (!request.signal.aborted && sessionRef.current?.id === id) {
          sessionRef.current = s;
          setSession(s);
          if (s.resources) setCpuHist(h => [...h.slice(-39), s.resources!.cpuPercentNow]);
        }
      } catch { /* A temporarily unavailable status endpoint does not change the session. */ }
      if (!request.signal.aborted) schedule();
    };
    schedule();
    return () => { request.abort(); clearTimeout(timer); };
  }, [state, session?.id]);

  // ---- input wiring: keyboard, focus loss, gamepad
  useEffect(() => { input.enabled = live && conn === 'open' && !keymap && !menu && !perm; if (!input.enabled) input.releaseAll(); }, [input, live, conn, keymap, menu, perm]);
  useEffect(() => {
    window.addEventListener('keydown', input.onKeyDown);
    window.addEventListener('keyup', input.onKeyUp);
    const rel = () => input.releaseAll();
    const vis = () => { if (document.hidden) rel(); };
    window.addEventListener('blur', rel);
    document.addEventListener('visibilitychange', vis);
    const gp = new GamepadPoller(input, setPad, loadPadProfile(gameId));
    gamepad.current = gp;
    let previous = '';
    // the pressed buttons are shown on the on-screen keypad (it follows every input source); the state is only needed while the mapping dialog is open
    gp.onState = (s) => { if (!padMenuOpen.current) return; const serialized=JSON.stringify(s);if(serialized!==previous){previous=serialized;setPadState(s);} };
    gp.onUi = (action) => uiRef.current(action);
    if (controls.gamepad) gp.start();
    return () => {
      window.removeEventListener('keydown', input.onKeyDown); window.removeEventListener('keyup', input.onKeyUp);
      window.removeEventListener('blur', rel); document.removeEventListener('visibilitychange', vis);
      gp.stop(); input.releaseAll();
    };
  }, [input, gameId, controls.gamepad]);
  const uiRef = useRef<(action: PadAction) => void>(() => undefined);
  const closePadSettings = () => {
    setPadMenu(false);
    if (live) stage.current?.focus({ preventScroll: true });
  };
  uiRef.current = (action) => {
    wake();
    if (action === 'ui:menu') {
      if (padMenu) closePadSettings();
      else if (!live) { setLights(false); setPadMenu(true); }
      return;
    }
    if(action==='ui:back'){if(perm){send({t:'perm',id:perm.id,allow:false});setPerm(null);}setMenu(null);setKeymap(false);closePadSettings();setLights(false);return;}
    if(action==='ui:lights'){setPrefs({view:'screen'});setLights(v=>!v);return;}
    if(action==='ui:fullscreen'){fullscreen();return;}
    if(action==='up'||action==='down'||action==='left'||action==='right'){
      const root=document.querySelector('[role=dialog]') ?? document.querySelector('.player-grid');
      const controls=[...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),select,input,a[href]')??[])].filter(e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden');
      const selected=document.activeElement;
      if((action==='left'||action==='right') && selected instanceof HTMLSelectElement){selected.selectedIndex=Math.max(0,Math.min(selected.options.length-1,selected.selectedIndex+(action==='left'?-1:1)));selected.dispatchEvent(new Event('change',{bubbles:true}));return;}
      const at=controls.indexOf(document.activeElement as HTMLElement), delta=action==='up'||action==='left'?-1:1;
      controls[(at+delta+controls.length)%controls.length]?.focus();
    } else if(action==='fire') (document.activeElement as HTMLElement)?.click();
  };
  useEffect(()=>{if(gamepad.current)gamepad.current.uiMode=!live || !!menu || !!perm || keymap;},[controls.gamepad,live,menu,perm,keymap]);
  // the held-key state is shared by every control surface: changing the picture or the view lets go of everything
  useEffect(() => { input.releaseAll(); }, [input, prefs.skinId, view]);

  useEffect(() => () => { streamRef.current?.close(); }, []);

  useEffect(()=>{
    const release=()=>input.releaseAll();
    const warn=(e:BeforeUnloadEvent)=>{if(sessionRef.current && (state==='running'||state==='starting')){release();e.preventDefault();e.returnValue='';}};
    window.addEventListener('pagehide',release);window.addEventListener('beforeunload',warn);
    return()=>{window.removeEventListener('pagehide',release);window.removeEventListener('beforeunload',warn);};
  },[input,state]);
  const launchVersion = useRef(0);
  const emuPatch = Object.keys(tweaks).length ? tweaks : null;
  const emuKey = JSON.stringify(tweaks);
  const pendingFrameLimit = session?.frameRateLimit !== undefined && session.frameRateLimit !== (tweaks.frameRate ?? null);
  const start = async () => {
    if (!game || busy || !loaded || (j2me ? !advanced && !matched : !native.data?.plan.ready && !(live && session?.backend === 'eka2l1' && native.data?.plan.code === 'symbian_busy'))) return;
    const version = ++launchVersion.current;
    setBusy(true); setLog([]); setMenu(null); setPerm(null); setCpuHist([]); setFpsHist([]); setFailure(null);
    void audio.resume(); // inside the click handler: allowed by autoplay policy
    try {
      const started = await api.startSession(game.id, j2me ? { layout, heapMb, ...(res ?? {}), device: device || null, skinId: prefs.skinId, profileMode: advanced ? 'advanced' : 'auto', emulation: emuPatch } : { skinId: prefs.skinId });
      if (version === launchVersion.current) attach(started);
    } catch (e) {
      if (version !== launchVersion.current) return;
      const err = e as ApiError;
      toast('error', translateUI(err.message));
      setLog(err.message.split('\n'));
      if (err.details?.failure) setFailure({ failure: err.details.failure, sessionId: err.details.sessionId ?? null });
      if (!j2me) { setState('failed'); native.refresh(); }
    } finally { if (version === launchVersion.current) setBusy(false); }
  };

  // Observe the server's starting session while installation/first frame is still pending.
  useEffect(() => {
    if (j2me || !busy || !game) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const pending = (await api.sessions()).find(s => s.gameId === game.id && (s.state === 'starting' || s.state === 'running'));
        if (!dead && pending && sessionRef.current?.id !== pending.id) attach(pending);
      } catch { /* the launch request reports failures */ }
      if (!dead) timer = setTimeout(tick, 700);
    };
    void tick();
    return () => { dead = true; clearTimeout(timer); };
  }, [j2me, busy, game?.id, attach]);

  const stop = async () => {
    const s = sessionRef.current; if (!s || (busy && j2me)) return false;
    launchVersion.current++;
    input.releaseAll();
    setBusy(true);
    try {
      const stopped = await api.stopSession(s.id);
      sessionRef.current = stopped;
      setSession(stopped); setLog(stopped.logTail); setState(stopped.state);
      streamRef.current?.close(); setConn('idle');
      if (stopped.state === 'failed') toast('error', 'The game had to be forcibly closed. Progress not written by the game to RMS may be lost.');
      return true;
    } catch (e) {
      // A failed request is not evidence that the process stopped. Keep the viewer attached.
      toast('error', (e as Error).message);
      return false;
    } finally { setBusy(false); }
  };
  const leave = async () => { if (sessionRef.current && (state === 'running' || state === 'starting' || state === 'stopping') && !await stop()) return; onExit(); };
  const shot = async (how: 'save' | 'copy') => {
    const c = canvasEl.current;
    if (!c) return;
    try {
      const png = await framePng(c, rotation);
      if (how === 'save') downloadBlob(png, `${fileSafe(game?.name ?? 'game')}-${c.width}x${c.height}.png`);
      else {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Copying pictures needs a secure (https) page; use Save instead.');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        toast('info', 'Screenshot copied.');
      }
    } catch (e) { toast('error', (e as Error).message); }
  };
  const fullscreen = () => { const promise = document.fullscreenElement ? document.exitFullscreen() : card.current?.requestFullscreen?.(); promise?.catch(() => toast('info','Fullscreen is unavailable; Lights Out still works in this window.')); };

  const pointer = (s: 'D' | 'M' | 'U') => (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!live) return;
    if (s === 'M' && e.buttons === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const [fx, fy] = unrotatePoint((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, rotation);
    const x = Math.round(fx * frameSize.w);
    const y = Math.round(fy * frameSize.h);
    if (s === 'D') { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    if (j2me) { send({ t: 'pointer', id: 0, s, x, y }); return; }
    let contact = contacts.current.get(e.pointerId);
    if (s === 'D' && !contact) {
      const used = new Set([...contacts.current.values()].map(c => c.id));
      const id = Array.from({ length: 8 }, (_, i) => i).find(i => !used.has(i));
      if (id === undefined) return;
      contact = { id, x, y }; contacts.current.set(e.pointerId, contact);
    }
    if (!contact) return;
    contact.x = Math.max(0, Math.min(frameSize.w - 1, x)); contact.y = Math.max(0, Math.min(frameSize.h - 1, y));
    send({ t: 'pointer', ...contact, s });
    if (s === 'U') contacts.current.delete(e.pointerId);
  };

  const applyDevice = (id: string) => {
    setDevice(id);
    const p = devices.find((d) => d.id === id);
    if (p) { setRes({ width: p.width, height: p.height }); setLayout(p.layout); }
  };
  // A game made for the other way up is shown on the phone whose display is landscape; turning back restores the phone.
  const skinBeforeTurn = useRef<{ skinId: string; advanced: boolean } | null>(null);
  const turnTo = (r: Rotation) => {
    if (!j2me) { setRotation(r); return; }
    const sideways = r === 90 || r === 270;
    const portraitSkin = !!skin && skin.config.screen.height > skin.config.screen.width;
    if (sideways && portraitSkin && !skinBeforeTurn.current) {
      skinBeforeTurn.current = { skinId: prefs.skinId, advanced };
      setAdvanced(true); setPrefs({ skinId: 'nokia-e71' });
    } else if (!sideways && skinBeforeTurn.current) {
      if (isSkinId(skinBeforeTurn.current.skinId)) setPrefs({ skinId: skinBeforeTurn.current.skinId }); setAdvanced(skinBeforeTurn.current.advanced);
      skinBeforeTurn.current = null;
    }
    setRotation(r);
  };
  const sizeHint = (() => {
    const h = analysis?.analysis.screenHints[0];
    return h && res && (h.width !== res.width || h.height !== res.height) ? h : null;
  })();
  const matched = useMemo(() => {
    if (!j2me || advanced || !devices.length) return null;
    try { return resolvePhone(prefs.skinId, devices); } catch { return null; }
  }, [j2me, advanced, prefs.skinId, devices]);
  useEffect(() => {
    if (!loaded || !j2me || advanced || !matched) return;
    const { preset, layout: phoneLayout } = matched;
    setDevice(preset.id); setLayout(phoneLayout); setRes({width:preset.width,height:preset.height});
  }, [loaded,j2me,advanced,matched]);
  useEffect(() => {
    if (!loaded || !j2me || !res) return;
    if (!advanced && matched && (device !== matched.preset.id || res.width !== matched.preset.width || res.height !== matched.preset.height || layout !== matched.layout)) return;
    api.patchGame(gameId,{settings:{skinId:prefs.skinId,profileMode:advanced?'advanced':'auto',device:device || null,...res,layout,heapMb,emulation:emuPatch}}).catch(e=>toast('error',(e as Error).message));
  }, [loaded,j2me,prefs.skinId,advanced,device,res?.width,res?.height,layout,heapMb,gameId,emuKey]);
  // A Symbian / N-Gage game is shown on a phone that can host it: its own choice when that fits, otherwise the phone that matches the
  // installed firmware. The browser's J2ME phone preference (a Sony Ericsson, say) is never used for it.
  const healed = useRef<string | null>(null);
  useEffect(() => {
    const plan = native.data?.plan;
    if (!game || j2me || !plan?.skinId || !game.platform) return;
    const fits = (id?: string) => !!id && isPhoneId(id) && (plan.deviceId ? PHONE_COMPATIBILITY[id].includes(plan.deviceId) : skinSupportsPlatform(id, game.platform!, game.packageFormat));
    const shown = fits(game.settings.skinId) ? game.settings.skinId! : plan.skinId;
    if (prefs.skinId !== shown) setPrefs({ skinId: shown });
    const key = `${game.id}:${game.settings.skinId ?? ''}:${shown}`;
    if (game.settings.skinId !== shown && healed.current !== key) {
      healed.current = key;
      api.patchGame(game.id, { settings: { skinId: shown } }).then(setGame, e => toast('error', (e as Error).message));
    }
  }, [game?.id, game?.settings.skinId, j2me, native.data?.plan.skinId, native.data?.plan.deviceId, prefs.skinId]);
  // "On another phone this game looks better": only a reminder with a one-click switch, never an automatic change of a phone that works.
  const [phoneCatalog, setPhoneCatalog] = useState<PhoneCatalog | null>(null);
  useEffect(() => { if (game && !j2me) api.phones().then(setPhoneCatalog, () => undefined); }, [game?.id, j2me, native.data?.plan.firmwareCode]);
  const [tipHidden, setTipHidden] = useState<string | null>(null);
  const actualGameSize = game?.nativeResolution ?? analysis?.analysis.screenHints[0];
  const displayProfile = live && session ? { width: session.width, height: session.height } : res;
  const mismatch = j2me && actualGameSize && displayProfile &&
    (actualGameSize.width !== displayProfile.width || actualGameSize.height !== displayProfile.height);
  const { skins } = useCatalog(!!mismatch || (!j2me && !!(actualGameSize || session?.framesReceived)));
  const suggestion = useMemo(() => {
    if (!game || !skins) return null;
    const mine = getServerSettings()?.settings.myPhones;
    const options: PhoneOption[] = skins.map((k) => ({ id: k.config.id, label: `${k.config.manufacturer} ${k.config.model}`, width: k.config.screen.width, height: k.config.screen.height, preferred: mine?.includes(k.config.id as never) }));
    const wanted = actualGameSize ?? (!j2me && session?.framesReceived ? { width: frameSize.w, height: frameSize.h } : null);
    const hasFirmware = (id: string) => EMULATED_DEVICES.some((d) => d.engine === 'eka2l1' && PHONE_COMPATIBILITY[id as keyof typeof PHONE_COMPATIBILITY]?.includes(d.id) && d.platforms.includes(game.platform ?? 'j2me') && phoneCatalog?.availability.find((a) => a.deviceId === d.id)?.available);
    return betterPhone({ platform: game.platform ?? 'j2me', packageFormat: game.packageFormat, current: prefs.skinId, options, wanted, hasFirmware });
  }, [game, skins, prefs.skinId, actualGameSize, phoneCatalog, j2me, session?.framesReceived ? frameSize.w : 0, session?.framesReceived ? frameSize.h : 0]);
  const switchPhone = async (id: string) => {
    if (!game || !isSkinId(id)) return;
    setPrefs({ skinId: id });
    if (j2me) setAdvanced(false);
    else { try { setGame(await api.patchGame(game.id, { settings: { skinId: id } })); native.refresh(); } catch (e) { toast('error', (e as Error).message); } }
  };
  const running = state === 'running' || state === 'starting' || state === 'stopping';
  // A game that names the screen it was made for (manifest or JAD) is set up for it once, without asking.
  const hintApplied = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || !j2me || running || advanced || game?.nativeResolution?.source === 'frame' || !sizeHint || hintApplied.current === gameId) return;
    hintApplied.current = gameId;
    setAdvanced(true); setDevice(''); setRes({ width: sizeHint.width, height: sizeHint.height });
  }, [loaded, j2me, running, advanced, sizeHint?.width, sizeHint?.height, gameId, game?.nativeResolution?.source]);
  const canStart = !!game && loaded && sessionsChecked && !running && !busy && (j2me ? health?.ok !== false && (advanced || !!matched) : native.data?.plan.ready === true);
  useEffect(() => {
    if (!autoStart || autoStarted.current || !sessionsChecked) return;
    if (!running) {
      if (!canStart) return;
      // The resolved auto profile must have reached the launch settings before playing.
      if (matched && (res?.width !== matched.preset.width || res?.height !== matched.preset.height || layout !== matched.layout || device !== matched.preset.id)) return;
    }
    autoStarted.current = true;
    onAutoStartConsumed();
    if (!running) void start();
  });
  const resKey = res ? `${res.width}x${res.height}` : '';
  const needRestart = running && res && session && (res.width !== session.width || res.height !== session.height || device !== (session.device ?? '') || layout !== session.layout || heapMb !== session.heapMb);
  const dev = devices.find((d) => d.id === device);
  const diag = session?.diagnostics ?? [];
  const logDiag = log.filter((l) => l.startsWith('⚠'));
  const res_ = session?.resources ?? null;
  const keypadDefault = controls.keypad === 'always' || (controls.keypad === 'auto'
    && (view === 'screen' || skin?.config.input?.externalKeypad === true || matchMedia('(pointer: coarse)').matches));
  const showKeypad = keypadOverride ?? keypadDefault;
  const external = lightsActive ? touchControls : showKeypad;
  const keypadReady = loaded && (skin !== null || !!skinError) && (j2me || !!native.data || !!native.error);
  const crops = useMemo(() => skin ? keypadCrops(skin) : [], [skin]);
  const skinViews = skin?.config.views;
  const screenView = skinViews?.screen;
  const fullView = skinViews?.full;
  const keypadLayout = {
    '--keypad-scale': Number(keypadWidth) / 200,
    ...(crops.length > 0 && fullView && screenView ? {
      '--full-lcd-width-factor': (fullView.width / fullView.height) * (fullView.screenRect.width / screenView.screenRect.width),
    } : {}),
  } as CSSProperties;
  const skinScreen = skin?.config.screen;

  const loadError = loadErrors.game || loadErrors.sessions || (j2me && !advanced ? loadErrors.devices : null);
  const checking = !loaded || !sessionsChecked || (j2me && !advanced && !devices.length && health?.ok !== false);
  const overlay = loadError ? <>
    <p className="error" role="alert">{translateUI(loadError)}</p>
    <button className="btn" type="button" onClick={() => { setLoadErrors({}); setLoadAttempt(n => n + 1); }}>{translateUI('Retry')}</button>
  </> : checking ? <p role="status">{translateUI('Connecting to the player…')}</p> : !running ? (
    <>
      {game && <h2>{game.name}</h2>}
      {state === 'failed' && <p className="error">{translateUI("The emulator stopped unexpectedly. See the log.")}</p>}
      {game && game.classVersion >= 49 ? <p className="error">{translateUI("Java 5+ class files are not supported.")}</p> : (
        <button className="btn primary" disabled={!canStart} onClick={start}><Icon name="play" /> {translateUI(busy ? 'Starting…' : state === 'idle' ? 'Start' : 'Start again')}</button>
      )}
      {j2me && health?.ok === false && <p className="error">{translateUI("Emulator runtime is not ready.")}</p>}
    </>
  ) : undefined;

  return (
    <div className={`player-grid ${lightsActive ? 'lights-out' : ''} ${awake ? 'hud-awake' : ''} ${touchControls ? 'touch-controls' : ''}`} onPointerMove={wake} onPointerDown={wake}>
      <section className={`card stage-card ${view === 'screen' ? 'is-screen' : ''}`} ref={card} aria-label={translateUI("Phone")}>
        {lightsActive && (
          <div className="lights-hud">
            <button className="btn lights-opts" aria-haspopup="menu" aria-expanded={hudMenu} onClick={() => setHudMenu((v) => !v)} data-testid="lights-options"><Icon name="sliders" /> {translateUI("Options")}</button>
            {hudMenu && (
              <div className="lights-menu" role="menu" aria-label={translateUI("Options")}>
                <button className="btn" role="menuitem" onClick={() => { setHudMenu(false); setLights(false); }} aria-label={translateUI("Exit Lights Out")}><Icon name="sun" /> {translateUI("Exit Lights Out")} <kbd>Esc</kbd></button>
                <button className="btn" role="menuitem" onClick={() => { setHudMenu(false); fullscreen(); }}><Icon name="fullscreen" /> {translateUI("Fullscreen")}</button>
                <button className="btn" role="menuitemcheckbox" aria-checked={touchControls} onClick={() => setTouchControls((v) => !v)}><Icon name="keypad" /> {translateUI("On-screen keypad")} <span className="menu-state">{translateUI(touchControls ? 'on' : 'off')}</span></button>
              </div>
            )}
          </div>
        )}
        <div className="stage-bar">
          <div className="stage-left">
            <button className="btn ghost sm" onClick={leave}><Icon name="back" /> {translateUI("Library")}</button>
            <div className="title">
              <strong>{game?.name ?? '…'}</strong>
              <span>{title || game?.vendor}</span>
            </div>
          </div>
          <div className="stage-actions">
            <span className={`badge ${STATE_BADGE[state] ?? ''} ${live ? 'live' : ''}`} data-testid="state-badge"><span className="dot" />{translateUI(state === 'idle' ? 'stopped' : state)}{translateUI(conn === 'reconnecting' ? ' · reconnecting…' : '')}{pauseInfo?.on && live ? translateUI(' · paused') : ''}</span>
            {live && <button className="btn ghost sm" onClick={() => send({ t: 'pause', on: !(pauseInfo?.on && pauseInfo.reason === 'manual') })} aria-pressed={!!pauseInfo?.on && pauseInfo.reason === 'manual'} title={translateUI('Suspend the game: pauseApp is called, the picture stops')}>{translateUI(pauseInfo?.on && pauseInfo.reason === 'manual' ? '▶ Resume' : '⏸ Pause')}</button>}
            {(!monoblock || skin?.config.id === 'nokia-n8') && <Seg label={translateUI("View")} value={prefs.view} onChange={(view) => setPrefs({ view })} options={[{ value: 'full', label: <><Icon name="phone" /> {translateUI("Phone")}</>, title: 'Whole phone, body keys active' }, { value: 'screen', label: <><Icon name="zoom" /> {translateUI("Screen")}</>, title: 'Enlarged display; controls below' }]} />}
            {view === 'screen' && <button className="btn ghost sm" onClick={()=>setLights(v=>!v)} aria-label={translateUI("Lights Out")} aria-pressed={lights} title={translateUI("Lights Out · Alt+L")}>{translateUI("☾ Lights Out")}</button>}
            <button className="btn ghost sm stage-tool" onClick={() => turnTo(nextRotation(rotation))} aria-label={translateUI("Rotate the picture")} title={translateUI("Rotate the picture (for games made for landscape)")} data-testid="rotate"><Icon name="rotate" /><span>{translateUI("Rotate")}</span></button>
            <button className="btn ghost sm stage-tool" onClick={() => void shot('save')} disabled={!lastFrame.current} aria-label={translateUI("Save a screenshot")} title={translateUI("Save a screenshot (PNG, the game's own size)")} data-testid="screenshot"><Icon name="camera" /><span>{translateUI("Screenshot")}</span></button>
            <button className={`btn ghost sm stage-tool${showFps ? ' on' : ''}`} onClick={() => setShowFps(!showFps)} aria-pressed={showFps} aria-label={translateUI("Show the frame rate")} title={translateUI("Show the frame rate in the corner of the screen")} data-testid="fps-toggle"><Icon name="pulse" /><span>{translateUI("FPS")}</span></button>
            <button className="btn ghost sm stage-tool" onClick={() => void shot('copy')} disabled={!lastFrame.current} aria-label={translateUI("Copy a screenshot")} title={translateUI("Copy a screenshot to the clipboard")} data-testid="screenshot-copy"><Icon name="copy" /><span>{translateUI("Copy")}</span></button>
            <button className="btn ghost sm stage-tool" onClick={fullscreen} aria-label={translateUI("Toggle fullscreen")} title={translateUI("Fullscreen")}><Icon name="fullscreen" /><span>{translateUI("Fullscreen")}</span></button>
          </div>
        </div>

        <div className={`stage-row${external && keypadReady ? ' with-keypad' : ''}`} style={keypadLayout}>
          {external && keypadReady && (
            <div className={`stage-foot side${crops.length > 1 ? ' split-keypad' : ''}`}>
              {skin && crops.length > 0
                ? crops.map(crop => <PhoneSkin key={`${crop.x}:${crop.y}`} skin={skin} view="full" keypadCrop={crop} frame={frameSize} input={input} interactive={live} className="physical-keypad" />)
                : <Keypad input={input} softLeft={softkeys.left} softRight={softkeys.right} />}
            </div>
          )}
          <div ref={stage} tabIndex={-1} className={`stage ${view === 'screen' ? 'stage-screen' : ''} ${skin?.config.input?.kind === 'touchscreen' ? 'stage-touchscreen' : ''}`}>
            {shownSkin.current ? (
              <PhoneSkin
                skin={shownSkin.current}
                view={view}
                frame={frameSize}
                rotation={rotation}
                canvasRef={setCanvas}
                canvasProps={{ onPointerDown: pointer('D'), onPointerMove: pointer('M'), onPointerUp: pointer('U'), onPointerCancel: pointer('U') }}
                integer={prefs.integer}
                smooth={smooth}
                input={input}
                interactive={live && shownSkin.current === skin}
                lcdOverlay={overlay}
              lcdBadge={live && showFps ? <span className="fps-badge" data-testid="fps-badge">{fps}</span> : undefined}
              />
            ) : <div className="player-bare-screen">
              <canvas ref={setCanvas} width={frameSize.w} height={frameSize.h}
                className={smooth ? undefined : 'pixelated'}
                style={{ transform: `rotate(${rotation}deg)` }}
                onPointerDown={pointer('D')} onPointerMove={pointer('M')} onPointerUp={pointer('U')} onPointerCancel={pointer('U')} />
              {overlay && <div className="player-bare-controls">{overlay}</div>}
            </div>}
            {loaded && !skin && <div className="phone-load-status" role="status">
              <span>{translateUI(skinError ? 'Could not load the phone skin' : 'Loading the phone…')}</span>
              {skinError && <button className="btn sm" type="button" onClick={retrySkin}>{translateUI('Retry phone skin')}</button>}
            </div>}
          </div>
        </div>

        {textArea && live && <TextEditor key={textArea.kind} area={textArea} onText={(text) => send({ t: 'text', text })} />}
      </section>

      <aside className="ctrl-col" aria-label={translateUI("Emulator controls")}>
        <PlayerResources />
        <Panel icon="play" title={translateUI("Session")} right={<span className={`badge ${STATE_BADGE[state] ?? ''}`}>{translateUI(state === 'idle' ? 'stopped' : state)}</span>}>
          <div className="btn-row">
            {!running
              ? <button className="btn sm primary grow" disabled={!canStart} onClick={start}><Icon name="play" /> {translateUI("Start")}</button>
              : <button className="btn sm danger grow" onClick={stop} disabled={(busy && j2me) || state === 'stopping'} title={translateUI("Stop requests a safe MIDlet shutdown. An unresponsive game may be forcibly closed after 8 seconds; unsaved in-game progress can be lost. Save inside the game first.")}><Icon name="stop" /> {translateUI("Stop")}</button>}
            {running && <button className="btn sm" disabled={busy || state === 'stopping' || (!j2me && !native.data?.plan.ready && native.data?.plan.code !== 'symbian_busy')} onClick={async () => { if (await stop()) setTimeout(start, 400); }}><Icon name="restart" /> {translateUI("Restart")}</button>}
          {session && <button className="btn ghost sm icon" onClick={() => api.diagnostics(session.id).then((b) => downloadBlob(b, `mgo-diagnostics-${fileSafe(game?.name ?? 'game')}.txt`), (e) => toast('error', (e as Error).message))} title={translateUI("A text report with the settings, the emulator log and the JVM state: attach it to a bug report")} aria-label={translateUI("Download diagnostics")} data-testid="diagnostics"><Icon name="log" /></button>}
          </div>
          {game && j2me && health?.ok !== false && <div className="control-line">
            <span className="label-caps" title={translateUI('Maximum rendering rate. Games with their own frame timing can run below this limit.')}>{translateUI('FPS limit')}</span>
            <Seg className="player-seg" label="Frame limit (fps)" value={String(tweaks.frameRate ?? 'default')}
              options={[
                { value: 'default', label: 'Default' },
                { value: '30', label: '30', ariaLabel: '30 FPS limit', title: '30 FPS limit' },
                { value: '60', label: '60', ariaLabel: '60 FPS limit', title: '60 FPS limit' },
                ...(tweaks.frameRate !== undefined && ![30, 60].includes(tweaks.frameRate) ? [{ value: String(tweaks.frameRate), label: `${tweaks.frameRate} FPS` }] : []),
              ]}
              onChange={value => setTweaks(previous => {
                const next = { ...previous };
                if (value === 'default') delete next.frameRate;
                else next.frameRate = Number(value);
                return next;
              })} />
          </div>}
          {running && pendingFrameLimit && <span className="hint" role="status">{translateUI('Restart to apply the frame limit.')}</span>}
          {running && j2me && <div className="control-line"><span className="label-caps">{translateUI("Game speed")}</span>
            <Seg<string> className="player-seg" label={translateUI("Game speed")} value={String(speed)} onChange={(v) => send({ t: 'speed', modifier: Number(v) })}
              options={[{ value: '-75', label: '×0.25' }, { value: '-50', label: '×0.5' }, { value: '1', label: '×1' }, { value: '2', label: '×2' }, { value: '4', label: '×4' }]} />
            {![-75, -50, 1, 2, 4].includes(speed) && <span className="hint">{translateUI("Custom speed")}: {speed}</span>}
          </div>}
          {state === 'failed' && <div className="note err">{translateUI("The emulator stopped unexpectedly. The log below has the details.")}</div>}
          {j2me && health?.ok === false && <div className="note warn">{translateUI("The emulator runtime is not ready on this server.")}</div>}
        </Panel>
        {(mismatch || suggestion) && tipHidden !== `${game?.id}:${suggestion?.id ?? prefs.skinId}` && (
          <div className="note info phone-tip" role="status" data-testid="phone-suggestion">
            {mismatch && <p>{translateUI('Game {game} · Emulator {emulator}', { game: `${actualGameSize.width}×${actualGameSize.height}`, emulator: `${displayProfile.width}×${displayProfile.height}` })}</p>}
            {suggestion && <p>{translateUI('Better screen fit: {phone} ({w}×{h}).', { phone: suggestion.label, w: suggestion.width, h: suggestion.height })}</p>}
            <div className="btn-row">
              {suggestion && <button className="btn sm primary" type="button" onClick={() => void switchPhone(suggestion.id)} data-testid="phone-suggestion-switch">{translateUI('Switch to {phone}', { phone: suggestion.label })}</button>}
              {mismatch && !suggestion && (actualGameSize.width !== res?.width || actualGameSize.height !== res?.height) && <button className="btn sm primary" type="button" onClick={() => { setAdvanced(true); setDevice(''); setRes({ width: actualGameSize.width, height: actualGameSize.height }); }}>{translateUI('Use game resolution')}</button>}
              <button className="btn sm ghost" type="button" onClick={() => setTipHidden(`${game?.id}:${suggestion?.id ?? prefs.skinId}`)}>{translateUI('Not now')}</button>
            </div>
          </div>
        )}
        <Panel icon="volume" title={translateUI("Audio")}>
          <div className="control-line audio-controls">
          <VolumeSlider value={vol} onChange={setVol} />
          <Switch checked={muted} onChange={setMuted}>{translateUI("Mute")}</Switch>
          </div>
          {audioInfo.state !== 'running' && running && <div className="note">{translateUI("Sound is waiting for a click or key press (browser autoplay policy).")}</div>}
          <p className={developer ? "hint" : "sr-only"} data-testid="audio-status" data-audio-state={audioInfo.state} data-audio-rms={audioInfo.rms.toFixed(4)}>
            {translateUI(audioInfo.state === 'running' ? `output ${audioInfo.rms > 0.0005 ? 'active' : 'idle'} · level ${(audioInfo.rms * 100).toFixed(1)}% · buffer ${audioInfo.buffered} ms` : `audio ${audioInfo.state}`)}
          </p>
        </Panel>

        {!j2me && failure && <StartFailureCard failure={failure.failure} sessionId={failure.sessionId} />}
        {!j2me && game && <NativeTestingPanel game={game} data={native.data} error={native.error} running={running || busy} starting={busy || state === 'starting'} onChanged={setGame} onRefresh={native.refresh} onSkin={id => setPrefs({ skinId: id })} toast={toast} />}
        {j2me && (
        <Panel icon="device" title={translateUI("Emulation profile")}>
          <div className="chips" data-testid="phone-profile-match">
            {displayProfile && <span className="chip" title={translateUI("Emulator screen")}><Icon name="device" /> {displayProfile.width}×{displayProfile.height}</span>}
            <span className="chip" title={translateUI("Key layout")}><Icon name="keypad" /> {translateUI(KEY_LAYOUTS[layout]?.label.split(' / ')[0] ?? layout)}</span>
            {dev?.platform && <span className="chip" title={translateUI("Platform reported to the game")}><Icon name="cpu" /> {dev.platform}</span>}
            {matched && <span className={`chip ${matched.exact ? 'ok' : ''}`} title={`${matched.preset.name}. ${translateUI(matched.reason)}`}><Icon name={matched.exact ? 'check' : 'info'} /> {translateUI(matched.exact ? 'exact' : 'generic')}</span>}
          </div>
          <div className="control-line"><Switch checked={advanced} onChange={setAdvanced}>{translateUI("Advanced profile")}</Switch><Hint text="Advanced: choose skin and profile independently" /></div>
          <fieldset hidden={!advanced} style={{border:0,padding:0,margin:0,display:advanced?'grid':'none',gap:12}}>
          <label className="field"><span className="label-caps">{translateUI("Device preset")}</span>
            <select className="select" value={device} onChange={(e) => applyDevice(e.target.value)} aria-label={translateUI("Device preset")}>
              <option value="">{translateUI("None — resolution and layout only")}</option>
              {analysis?.recommendedDevice && <option value={analysis.recommendedDevice}>{translateUI("★ Recommended:")} {devices.find((d) => d.id === analysis.recommendedDevice)?.name ?? analysis.recommendedDevice}</option>}
              {devices.map((d) => <option key={d.id} value={d.id}>{translateUI(d.vendor === 'common' ? '' : `${d.vendor} · `)}{d.name}{translateUI(d.model ? ` (${d.model})` : '')} · {d.width}×{d.height}</option>)}
            </select>
          </label>
          <div className="field-row">
            <label className="field"><span className="label-caps">{translateUI("Resolution")}</span>
              <select className="select" aria-label={translateUI("Resolution")} value={SCREEN_PRESETS.some((p) => `${p.width}x${p.height}` === resKey) ? resKey : 'custom'} onChange={(e) => { const [w, h] = e.target.value.split('x').map(Number); if (w && h) { setRes({ width: w, height: h }); setDevice(''); } }}>
                {SCREEN_PRESETS.map((p) => <option key={p.label} value={`${p.width}x${p.height}`}>{translateUI(p.label)}</option>)}
                {res && !SCREEN_PRESETS.some((p) => `${p.width}x${p.height}` === resKey) && <option value="custom">{res.width}×{res.height}</option>}
              </select>
            </label>
            <label className="field"><span className="label-caps">{translateUI("Key layout")}</span>
              <select className="select" aria-label={translateUI("Key layout")} value={layout} onChange={(e) => { input.releaseAll(); setLayout(e.target.value as LayoutId); }}>
                {Object.entries(KEY_LAYOUTS).map(([id, l]) => <option key={id} value={id}>{translateUI(l.label)}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span className="label-caps">{translateUI("Heap (MB)")}</span><input className="input" type="number" min={64} max={1024} step={32} value={heapMb} onChange={(e) => setHeapMb(Number(e.target.value))} aria-label={translateUI("Heap in MB")} /></label>
          </fieldset>
          {needRestart && <div className="note warn" role="status">{translateUI("The running game keeps its current profile. Restart to apply the selected phone/profile.")} <button className="btn sm" disabled={busy || state === 'stopping'} onClick={async()=>{if(await stop())await start();}}>{translateUI("Restart with selected profile")}</button></div>}
        </Panel>
        )}

        {loaded && j2me && (
        <Panel icon="sliders" title={translateUI("Game compatibility options")}>
          <EmulationTweaksForm pointerDefault={phoneHasTouch(prefs.skinId)} value={tweaks} onChange={setTweaks} />
        </Panel>
        )}

        <Panel icon="layers" title={translateUI("Display")}>
          <div className="chips">
            <span className="chip" data-testid="game-resolution" title={translateUI(game?.nativeResolution?.source === 'frame' ? 'Estimated from game frames' : 'Game resolution')}><Icon name="gamepad" /> {translateUI('Game')} {actualGameSize ? `${actualGameSize.width}×${actualGameSize.height}` : '—'}</span>
            <button type="button" className="chip chip-link" onClick={() => navigate('/phones')} title={translateUI("Change the phone")} data-testid="change-phone"><Icon name="phone" /> {skin ? `${skin.config.manufacturer} ${skin.config.model}` : '…'}</button>
            <span className="chip" title={translateUI("Emulated picture")}><Icon name="zoom" /> <span data-testid="frame-size">{frameSize.w}×{frameSize.h}</span></span>
            {skinScreen && res && (res.width !== skinScreen.width || res.height !== skinScreen.height) && (
              <span className="chip" title={translateUI(`This phone’s display is ${skinScreen.width}×${skinScreen.height}; the game renders ${res.width}×${res.height}. It is shown whole, with margins, never stretched.`)}><Icon name="info" /> {skinScreen.width}×{skinScreen.height}</span>
            )}
          </div>
          <div className="switch-row">
            <Switch checked={prefs.integer} onChange={(integer) => setPrefs({ integer })}>{translateUI("Whole-number scaling")}</Switch>
            <Switch checked={smooth} onChange={setSmooth}>{translateUI("Smooth scaling")}</Switch>
          </div>
        </Panel>

        <Panel icon="gamepad" title={translateUI("Controls")}>
          <div className="control-line">
            <Switch checked={showKeypad} onChange={enabled => { setKeypadOverride(enabled); saveControlPreference('keypad', enabled ? 'on' : 'off'); }}>{translateUI("On-screen keypad")}</Switch>
            <div className="btn-row">
              <Hint text={`${translateUI("Arrows · Enter = OK · Q/W = soft keys · 0–9 · X = * · Z = #.")}${pad ? ` ${pad.slice(0, 28)}` : ''}`} />
              <button className="btn sm icon" type="button" title={translateUI("Remap keyboard")} aria-label={translateUI("Remap keyboard")} onClick={() => setKeymap(true)}><Icon name="keypad" /></button>
              <button className="btn sm icon" type="button" title={translateUI("Gamepad settings / UI navigation")} aria-label={translateUI("Gamepad settings / UI navigation")} aria-expanded={padMenu} onClick={() => { if (padMenu) closePadSettings(); else setPadMenu(true); }}><Icon name="gamepad" /></button>
            </div>
          </div>
          {showKeypad && <div className="control-line">
            <span className="label-caps">{translateUI('Keypad width')}</span>
            <Seg className="player-seg" label="Keypad width" value={keypadWidth}
              options={KEYPAD_WIDTHS.map(value => ({ value, label: `${value}%` }))}
              onChange={value => { setKeypadWidth(value); saveControlPreference('keypad-width', value); }} />
          </div>}
          {game && j2me && <Switch checked={gamepadVibration} disabled={!controls.gamepad} onChange={enabled => {
            setGamepadVibration(enabled); saveControlPreference('gamepad-vibration', enabled ? 'on' : 'off');
            if (!enabled) gamepad.current?.stopRumble();
          }}>{translateUI('Gamepad vibration')}</Switch>}
          {padMenu && <GamepadSettings gameId={gameId} poller={gamepad.current} state={padState} />}
        </Panel>

        <Panel icon="log" title={translateUI("Input recording")}>
          <RecordingPanel gameId={gameId} gameName={game?.name ?? gameId} frame={frameSize} live={live} recorder={recorder} replayer={replayer} sendRaw={sendRaw} toast={toast} />
        </Panel>

        {developer && <Panel icon="pulse" title={translateUI("Telemetry")}>
          <div className="metric"><div className="metric-head"><span className="label-caps">{translateUI("Display FPS")}</span><span className="metric-value">{client.fps.toFixed(1)}</span></div><Spark values={fpsHist} label={translateUI("Display frames per second")} /></div>
          <div className="metric"><div className="metric-head"><span className="label-caps">{translateUI("Emulator CPU")}</span><span className="metric-value">{translateUI(res_ ? `${res_.cpuPercentNow.toFixed(0)}%` : '—')}</span></div><Spark values={cpuHist} max={Math.max(100, ...cpuHist)} label={translateUI("CPU use")} /></div>
          <div className="metric"><div className="metric-head"><span className="label-caps">{translateUI("Memory")}</span><span className="small mono">{translateUI(res_ ? `${res_.rssMb.toFixed(0)} MB (peak ${res_.peakRssMb.toFixed(0)})` : '—')}</span></div><Meter value={res_?.rssMb ?? 0} max={Math.max(512, heapMb * 2)} label={translateUI("Memory use")} /></div>
          <dl className="kv stats">
            <dt>{translateUI("Display FPS")}</dt><dd>{client.fps.toFixed(1)}</dd>
            <dt>{translateUI("Emulator FPS")}</dt><dd>{server.fps.toFixed(1)}</dd>
            <dt>{translateUI("Round trip")}</dt><dd>{client.rtt ?? '—'} {translateUI("ms")}</dd>
            <dt>{translateUI("Adapter→API")}</dt><dd>{translateUI(server.latencyMs === null ? '—' : `${server.latencyMs.toFixed(0)} ms`)}</dd>
            <dt>{translateUI("Decode")}</dt><dd>{client.decode} {translateUI("ms")}</dd>
            <dt>{translateUI("Bandwidth")}</dt><dd>{client.kbps} {translateUI("kbit/s")}</dd>
            <dt>{translateUI("Dropped")}</dt><dd>{server.dropped}</dd>
            <dt>{translateUI("First frame")}</dt><dd>{translateUI(session?.firstFrameMs != null ? `${session.firstFrameMs} ms` : '—')}</dd>
            <dt>{translateUI("Sound")}</dt><dd>{translateUI(session ? (session.audioBytes > 0 ? `${(session.audioBytes / 1024).toFixed(0)} KB` : 'none yet') : '—')}</dd>
            <dt>{translateUI("Frame")}</dt><dd>{frameSize.w}×{frameSize.h} · {session?.encoding ?? '—'}</dd>
          </dl>
          {[...new Set([...diag, ...logDiag.map((l) => l.slice(2))])].map((d) => <div className="note warn" key={d}>{d}</div>)}
        </Panel>}

        {developer && analysis && (
          <Panel icon="shield" title={translateUI("Compatibility")} right={<span className={`badge ${analysis.analysis.risk === 'low' ? 'prod' : analysis.analysis.risk === 'medium' ? 'mock' : 'danger'}`}>{analysis.analysis.risk} {translateUI("risk")}</span>}>
            <dl className="kv"><dt>{translateUI("Platform")}</dt><dd>{analysis.analysis.platform.family}</dd><dt>{translateUI("3D (M3G / Mascot)")}</dt><dd>{translateUI(analysis.analysis.needs3d ? 'yes' : 'no')}</dd><dt>{translateUI("Classes")}</dt><dd>{analysis.analysis.classCount}</dd></dl>
            {analysis.analysis.apis.length > 0 && (
              <div className="table-wrap"><table className="table compact"><thead><tr><th>{translateUI("API")}</th><th>{translateUI("Classes")}</th><th>{translateUI("Missing")}</th></tr></thead>
                <tbody>{analysis.analysis.apis.map((a) => <tr key={a.id}><td>{translateUI(a.label)}</td><td>{a.classes}</td><td>{a.missing.length || '—'}</td></tr>)}</tbody></table></div>
            )}
            {analysis.analysis.findings.map((f) => <div key={f.code + f.message} className={`note ${f.level === 'error' ? 'err' : f.level === 'warn' ? 'warn' : ''}`}>{f.message}</div>)}
            {analysis.recommendedDevice && advanced && !running && device !== analysis.recommendedDevice && <button className="btn sm" onClick={() => applyDevice(analysis.recommendedDevice!)}>{translateUI("Use the recommended device preset")}</button>}
          </Panel>
        )}

        {(developer || state === 'failed') && <Panel icon="log" title={translateUI(`Emulator log (${log.length})`)}>
          <pre className="log" tabIndex={0}>{log.slice(-120).join('\n') || '—'}</pre>
        </Panel>}
      </aside>

      {keymap && <KeyMapDialog bindings={bindings} onClose={() => setKeymap(false)} onSave={(b) => { input.bindings = b; setBindings(b); }} />}
      {menu && (
        <Modal title={translateUI("Menu")} onClose={() => { setMenu(null); }}>
          <ul className="menu-list">
            {menu.items.map((i) => <li key={i.id}><button className="btn block" onClick={() => { send({ t: 'cmd', id: i.id }); setMenu(null); }}>{translateUI(i.kind === 'radio-selected' ? '◉ ' : i.kind === 'radio' ? '○ ' : '')}{i.text}</button></li>)}
          </ul>
        </Modal>
      )}
      {link && (
        <Modal title={translateUI("The game wants to open a link")} onClose={() => setLink(null)}>
          <p>{translateUI("Open this address only if you trust it:")}</p>
          <p><code className="link-url" data-testid="game-link">{link}</code></p>
          <div className="modal-actions">
            <span className="spacer" />
            <button className="btn" onClick={() => setLink(null)}>{translateUI("Cancel")}</button>
            <a className="btn primary" href={link} target="_blank" rel="noopener noreferrer" onClick={() => setLink(null)}>{translateUI("Open")}</a>
          </div>
        </Modal>
      )}
      {perm && (
        <Modal title={translateUI("Permission request")} onClose={() => { send({ t: 'perm', id: perm.id, allow: false }); setPerm(null); }}>
          <p>{perm.message}</p>
          <div className="modal-actions">
            <span className="spacer" />
            <button className="btn" onClick={() => { send({ t: 'perm', id: perm.id, allow: false }); setPerm(null); }}>{translateUI("Deny")}</button>
            <button className="btn primary" onClick={() => { send({ t: 'perm', id: perm.id, allow: true }); setPerm(null); }}>{translateUI("Allow")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

