import { GAME_PLATFORM_LABELS, GENRES, generationOfOs, generationOfPackage, phoneHasTouch, profilesForSkin, type GameInfo, type GameMeta, type HealthStatus, type PhoneCatalog } from '@mgo/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Toast } from '../App';
import { EmulationTweaksForm } from '../components/EmulationTweaksForm';
import { GamepadSettings } from '../components/GamepadSettings';
import { Icon } from '../components/Icon';
import { Player } from '../components/Player';
import type { PadState } from '../gamepad';
import { t } from '../i18n';
import { InputController } from '../input';
import { navigate } from '../router';
import { controlSettings, useServerSettings } from '../serverSettings';
import { DEFAULT_SKIN, isSkinId, skinBase, useCatalog } from '../skin/registry';
import type { LoadedSkin } from '../skin/types';
import { TvCollectionCards, TvFooter, TvHome, TvNavigation, TvPhoneCards, type TvCollection, type TvSection } from './Dashboard';
import { useTvInput, type TvKey } from './Input';
import { focusTv, moveTvFocus, tvTargets } from './focus';
import { TvKeyboard } from './Keyboard';
import { GameArtwork, TvFilters, TvGameTile, tvLibrary, tvPlatform, type TvFilter, type TvGameGroup } from './Library';
import type { TvDisplay, TvPlayerHandle, TvPlayerStatus } from './player';

type Overlay = 'menu' | 'search' | 'build' | 'phone' | 'phone-info' | 'options' | 'controls' | 'confirm';
const preference = {
  read: (key: string) => { try { return localStorage.getItem('mgo.tv.' + key); } catch { return null; } },
  write: (key: string, value: string) => { try { localStorage.setItem('mgo.tv.' + key, value); } catch { /* optional */ } },
};

export default function TvMode({ health, toast, exit }: { health: HealthStatus | null; toast: (kind: Toast['kind'], text: string) => void; exit: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const libraryScroll = useRef(0);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [games, setGames] = useState<GameMeta[]>();
  const [libraryError, setLibraryError] = useState('');
  const [reload, setReload] = useState(0);
  const [section, setSection] = useState<TvSection>('home');
  const [highlighted, setHighlighted] = useState('');
  const [viewedPhone, setViewedPhone] = useState<LoadedSkin>();
  const [filter, setFilter] = useState<TvFilter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<GameMeta | null>(null);
  const [builds, setBuilds] = useState<GameMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [lastGroup, setLastGroup] = useState('');
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [playerStatus, report] = useState<TvPlayerStatus>('opening');
  const [info, setInfo] = useState<GameInfo | null>(null);
  const [picture, setPicture] = useState(0);
  const [nativeWarning, setNativeWarning] = useState('');
  const [phoneCatalog, setPhoneCatalog] = useState<PhoneCatalog | null>(null);
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [display, setDisplay] = useState<TvDisplay>(() => {
    const saved = preference.read('display');
    return saved === 'screen' || saved === 'full' || saved === 'bare' ? saved : 'lights';
  });
  const [integer, setInteger] = useState(() => preference.read('integer') !== 'off');
  const [volume, setVolume] = useState(() => {
    const saved = Number(preference.read('volume') ?? 80);
    return Number.isFinite(saved) ? Math.min(100, Math.max(0, saved)) : 80;
  });
  const [vibration, setVibration] = useState(() => preference.read('vibration') !== 'off');
  const [padState, setPadState] = useState<PadState>({ controllers: [], pressed: [] });
  const input = useMemo(() => new InputController(() => undefined), []);
  const handle = useRef<TvPlayerHandle | null>(null);
  const afterStop = useRef<'library' | 'desktop'>('library');
  const [stopTarget, setStopTarget] = useState<'library' | 'desktop'>('library');
  const [stopping, setStopping] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const gameplay = active !== null && playerStatus === 'game' && !overlay;
  const settings = useServerSettings()?.settings;
  const { skins, error: skinsError } = useCatalog(overlay === 'phone' || (!active && (section === 'home' || section === 'phones')));
  const rememberOverlay = (next: Overlay) => {
    if (!overlay && document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
    input.releaseAll();
    setActionError('');
    setOverlay(next);
  };

  useEffect(() => {
    preference.write('mode', 'on');
    document.documentElement.classList.add('mgo-tv');
    return () => document.documentElement.classList.remove('mgo-tv');
  }, []);
  useEffect(() => {
    let keep = true;
    void api.games().then(items => { if (keep) { setGames(items); setLibraryError(''); } }, error => { if (keep) setLibraryError(error.message); });
    return () => { keep = false; };
  }, [reload]);
  useEffect(() => {
    if (!selected) return;
    let keep = true;
    setInfo(null); setPicture(0); setNativeWarning('');
    void api.gameInfo(selected.id).then(data => { if (keep) setInfo(data); }, () => undefined);
    if (tvPlatform(selected) !== 'j2me') {
      void api.phonePlan(selected.id).then(({ plan }) => {
        if (keep && !plan.ready && plan.code !== 'symbian_busy') setNativeWarning(plan.message);
      }, error => { if (keep) setNativeWarning(error.message); });
    }
    return () => { keep = false; };
  }, [selected?.id, selected?.settings.skinId]);
  useEffect(() => {
    if (overlay !== 'phone' || !selected || tvPlatform(selected) === 'j2me') return;
    let current = true;
    setPhoneCatalog(null);
    void api.phones().then(data => { if (current) setPhoneCatalog(data); }, error => { if (current) setActionError(error.message); });
    return () => { current = false; };
  }, [overlay, selected?.id]);

  const groupList = useMemo(() => tvLibrary(games ?? [], filter, query), [games, filter, query]);
  const groups = useMemo(() => tvLibrary(games ?? [], 'all', ''), [games]);
  const recentlyPlayed = useMemo(() => tvLibrary(games ?? [], 'recent', ''), [games]);
  const recentlyAdded = useMemo(() => tvLibrary(games ?? [], 'added', ''), [games]);
  const highlights = (recentlyPlayed.length ? recentlyPlayed : recentlyAdded).slice(0, 5);
  const spotlight = highlights.find(group => group.id === highlighted) ?? highlights[0];
  const addedShelf = recentlyAdded.filter(group => !highlights.some(highlight => highlight.id === group.id)).slice(0, 6);
  const collections = useMemo<TvCollection[]>(() => [
    { filter: 'favorites', label: 'Favorites', icon: 'star', count: groups.filter(group => group.builds.some(game => game.favorite)).length },
    { filter: 'recent', label: 'Recently played', icon: 'clock', count: recentlyPlayed.length },
    ...GENRES.flatMap((genre): TvCollection[] => {
      const count = groups.filter(({ game }) => game.classification?.primaryGenre === genre).length;
      return count ? [{ filter: `genre:${genre}`, label: genre, icon: 'layers', count }] : [];
    }).sort((a, b) => b.count - a.count),
  ], [groups, recentlyPlayed.length]);
  const defaultPhone = isSkinId(settings?.phone.skinId) ? settings.phone.skinId : DEFAULT_SKIN;
  const phoneOrder = [defaultPhone, ...(settings?.myPhones ?? [])];
  const phones = [...(skins ?? [])].sort((a, b) => {
    const priority = (id: string) => isSkinId(id) && phoneOrder.includes(id) ? phoneOrder.indexOf(id) : phoneOrder.length;
    return priority(a.config.id) - priority(b.config.id);
  });
  const platform = spotlight && tvPlatform(spotlight.game);
  const spotlightPhone = phones.find(({ config }) => config.id === (spotlight?.game.settings.skinId ??
    (platform === 'j2me' ? defaultPhone : platform && settings?.nativePhones?.[platform])));
  const selectGroup = (group: TvGameGroup, preferred = group.game) => {
    libraryScroll.current = body.current?.scrollTop ?? 0;
    setLastGroup(group.id);
    const allBuilds = (games ?? []).filter(g => tvPlatform(g) === tvPlatform(preferred) &&
      (g.groupKey || g.id) === (preferred.groupKey || preferred.id) && !g.sourceMissing);
    setBuilds(allBuilds.length ? allBuilds : group.builds);
    setSelected(preferred);
  };
  const leaveDesktop = () => {
    preference.write('mode', 'off');
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    exit();
  };
  const showSection = (next: TvSection, libraryFilter: TvFilter = 'all') => {
    if (body.current) body.current.scrollTop = 0;
    setLastGroup('');
    setSelected(null);
    setSection(next);
    if (next === 'library') { setFilter(libraryFilter); setQuery(''); }
  };
  const showPhone = (phone: LoadedSkin) => { setViewedPhone(phone); rememberOverlay('phone-info'); };
  const managePhones = () => {
    preference.write('mode', 'off');
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    navigate('/settings#phone');
  };
  const closeOverlay = () => { setActionError(''); setOverlay(null); };
  const onBack = () => {
    if (overlay === 'confirm' || overlay === 'controls') { setOverlay('menu'); return; }
    if (overlay) { closeOverlay(); return; }
    if (active) {
      const modal = body.current?.querySelector<HTMLElement>('[role="dialog"]');
      if (modal && playerStatus === 'blocked') { modal.dispatchEvent(new Event('mgo:tv-back')); return; }
      rememberOverlay('menu');
      return;
    }
    if (selected) { setSelected(null); return; }
    if (section !== 'home') { showSection('home'); return; }
    rememberOverlay('menu');
  };
  const scope = () => overlay ? dialog.current : body.current?.querySelector<HTMLElement>('[role="dialog"]') ?? body.current;
  const ui = (key: TvKey) => {
    if (key === 'menu') { if (overlay === 'menu') closeOverlay(); else rememberOverlay('menu'); return; }
    if (key === 'back') { onBack(); return; }
    if (gameplay) return;
    const target = scope();
    if (target) moveTvFocus(target, key);
  };
  const gamepad = useTvInput(input, selected?.id ?? active, gameplay, controlSettings().gamepad, ui, state => {
    if (overlay === 'controls') setPadState(old => JSON.stringify(old) === JSON.stringify(state) ? old : state);
  });

  useLayoutEffect(() => {
    if (!body.current) return;
    body.current.inert = !!overlay;
    if (active && playerStatus === 'blocked' && !overlay) {
      const popup = body.current.querySelector<HTMLElement>('[role="dialog"]');
      if (popup) {
        const frame = requestAnimationFrame(() => focusTv(tvTargets(popup)[0]));
        return () => cancelAnimationFrame(frame);
      }
    }
    if (overlay) {
      const frame = requestAnimationFrame(() => {
        const panel = dialog.current;
        if (panel) focusTv(panel.querySelector<HTMLElement>('[data-tv-prefer]') ?? tvTargets(panel)[0]);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (active && playerStatus === 'game') {
      body.current.querySelector<HTMLElement>('.stage')?.focus({ preventScroll: true });
      return;
    }
    const frame = requestAnimationFrame(() => {
      const page = body.current;
      if (!page) return;
      if (previousFocus.current?.isConnected && page.contains(previousFocus.current)) {
        focusTv(previousFocus.current);
        previousFocus.current = null;
        return;
      }
      if (lastGroup && !selected && !active) {
        page.scrollTop = libraryScroll.current;
        const tile = Array.from(page.querySelectorAll<HTMLElement>('[data-tv-game]')).find(el => el.dataset.tvGame === lastGroup);
        if (tile) { focusTv(tile); return; }
      }
      focusTv(page.querySelector<HTMLElement>('[data-tv-prefer]:not(:disabled)') ??
        page.querySelector<HTMLElement>('.tv-nav [aria-current="page"]') ?? tvTargets(page)[0]);
    });
    return () => cancelAnimationFrame(frame);
  }, [overlay, selected?.id, active, playerStatus, !!games, section]);

  async function updateGame(patch: Parameters<typeof api.patchGame>[1]) {
    if (!selected || saving) return;
    setSaving(true); setActionError('');
    try {
      const result = await api.patchGame(selected.id, patch);
      setSelected(game => game?.id === result.id ? result : game);
      setGames(list => list?.map(game => game.id === result.id ? result : game));
      if (overlay === 'phone') closeOverlay();
    } catch (error) { setActionError((error as Error).message); }
    finally { setSaving(false); }
  }

  const selectDisplay = (mode: TvDisplay) => { setDisplay(mode); preference.write('display', mode); };
  const start = (game: GameMeta) => { setActionError(''); report('opening'); setActive(game.id); };
  const playSpotlight = (lights?: boolean) => {
    if (!spotlight) return;
    if (lights) selectDisplay('lights');
    selectGroup(spotlight);
    start(spotlight.game);
  };
  const shuffle = () => {
    const candidates = groups.filter(group => group.id !== spotlight?.id);
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    if (choice) selectGroup(choice);
  };
  const stopped = () => {
    setOverlay(null); setActive(null); setSelected(null); report('opening'); setReload(n => n + 1);
    if (section !== 'library') { setFilter('all'); setQuery(''); setSection('library'); }
    if (afterStop.current === 'desktop') leaveDesktop();
    afterStop.current = 'library';
  };
  const fullscreen = async () => {
    setFullscreenError('');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch { setFullscreenError('Fullscreen needs a browser gesture. Chromium kiosk can open /tv in fullscreen.'); }
  };
  const exitRequest = (target: 'library' | 'desktop') => {
    if (!active) { leaveDesktop(); return; }
    setStopTarget(target); rememberOverlay('confirm');
  };
  const confirmStop = async () => {
    if (playerStatus === 'opening') { setActionError('Wait for the game to finish opening first.'); return; }
    if (stopping) return;
    afterStop.current = stopTarget;
    setStopping(true);
    try { await handle.current?.leave(); } finally { setStopping(false); }
  };

  const screenshots = info?.screenshots || selected?.info?.screenshots || selected?.javaCatalog?.screenshots || 0;
  const title: Record<Overlay, string> = { menu: 'TV menu', search: 'Search games',
    build: 'Choose a build', phone: 'Choose a phone', 'phone-info': viewedPhone?.config.model ?? 'Phone',
    options: 'Game compatibility options', controls: 'Controller mapping', confirm: 'Stop game?' };
  const libraryStatus = libraryError ? <div role="alert"><p>{t(libraryError)}</p><button type="button" onClick={() => setReload(n => n + 1)}>{t('Retry')}</button></div>
    : !games ? <p role="status">{t('Loading…')}</p> : null;

  return <div ref={root} className={`tv ${active ? 'tv-playing' : ''}`} data-testid="tv-mode">
    <div ref={body} className="tv-body">
      {!active && <TvNavigation section={section} onSelect={showSection} onSettings={() => rememberOverlay('menu')} />}
      {active ? <>
        {playerStatus !== 'game' && <div className="tv-player-nav"><button type="button" onClick={() => rememberOverlay('menu')}><Icon name="menu" />{t('Menu')}</button></div>}
        <Player key={active} gameId={active} autoStart onAutoStartConsumed={() => undefined} toast={toast} onExit={stopped} health={health}
          tv={{ input, gamepad, handle, report, blocked: !!overlay, display, integer, volume, vibration }} />
      </> : selected ? <main className="tv-details">
        <button type="button" className="tv-details-back" onClick={() => setSelected(null)}><Icon name="back" />{t('Back')}</button>
        <div className="tv-gallery">
          <GameArtwork game={selected} picture={picture} />
          {screenshots > 0 && <div className="tv-actions">
            <button type="button" onClick={() => setPicture((picture + screenshots) % (screenshots + 1))} aria-label={t('Previous screenshot')}>‹</button>
            <span aria-live="polite">{picture + 1}/{screenshots + 1}</span>
            <button type="button" onClick={() => setPicture((picture + 1) % (screenshots + 1))} aria-label={t('Next screenshot')}>›</button>
          </div>}
        </div>
        <article>
          <p className="tv-platform">{GAME_PLATFORM_LABELS[tvPlatform(selected)]}</p>
          <h1>{selected.name}</h1>
          <p className="muted">{[selected.vendor, selected.nativeResolution && `${selected.nativeResolution.width}×${selected.nativeResolution.height}`, selected.version && `v${selected.version}`].filter(Boolean).join(' · ')}</p>
          {info?.description && <p className="tv-description" data-tv-focus tabIndex={0}>{info.description}</p>}
          {info?.description && info.attribution && <small className="muted">{info.attribution}</small>}
          {nativeWarning && <p className="note warn" role="status">{t(nativeWarning)}</p>}
          {actionError && <p className="error" role="alert">{t(actionError)}</p>}
          <div className="tv-actions">
            <button type="button" className="tv-primary" data-tv-prefer onClick={() => start(selected)}><Icon name="play" />{t(selected.lastPlayedAt ? 'Play again / Resume' : 'Play')}</button>
            <button type="button" onClick={() => rememberOverlay('phone')}><Icon name="phone" />{t('Choose a phone')}</button>
            {builds.length > 1 && <button type="button" onClick={() => rememberOverlay('build')}>{t('Choose a build')}</button>}
            {tvPlatform(selected) === 'j2me' && <button type="button" onClick={() => rememberOverlay('options')}>{t('Compatibility')}</button>}
            <button type="button" aria-pressed={selected.favorite} disabled={saving} onClick={() => void updateGame({ favorite: !selected.favorite })}><Icon name="star" />{t('Favorite')}</button>
          </div>
        </article>
      </main> : section === 'home' ? libraryStatus ?? <TvHome highlights={highlights} spotlight={spotlight} played={recentlyPlayed.length > 0}
        added={addedShelf} collections={collections} phones={phones} phone={spotlightPhone} activePhone={defaultPhone}
        shuffle={groups.length > 1 ? shuffle : undefined} onHighlight={setHighlighted} onOpen={selectGroup} onPlay={playSpotlight}
        onChoosePhone={() => { if (spotlight) { selectGroup(spotlight); rememberOverlay('phone'); } }}
        onLibrary={value => showSection('library', value)} onSection={showSection} onPhone={showPhone} />
        : section === 'collections' ? <main className="tv-catalog">
          <h1>{t('Collections')}</h1>
          {libraryStatus ?? <TvCollectionCards collections={collections} onSelect={value => showSection('library', value)} />}
        </main> : section === 'phones' ? <main className="tv-catalog">
          <div className="tv-library-head"><h1>{t('Phones')}</h1><button type="button" onClick={managePhones}>{t('My phones')}</button></div>
          {skinsError ? <p role="alert">{skinsError}</p> : !skins ? <p role="status">{t('Loading…')}</p>
            : <TvPhoneCards phones={phones} active={defaultPhone} onView={showPhone} />}
        </main> : <main className="tv-library">
        <div className="tv-library-head"><h1>{t('Library')}</h1>
          <button type="button" data-tv-prefer onClick={() => rememberOverlay('search')}><Icon name="search" />{query || t('Search games')}</button>
        </div>
        <TvFilters selected={filter} onSelect={setFilter} />
        {filter.startsWith('genre:') && <h2 className="tv-filter-heading">{t(filter.slice(6))}</h2>}
        {libraryStatus ?? (groupList.length === 0 ? <p>{t('No games match these filters.')}</p>
          : <div className="tv-grid">{groupList.map(group => <TvGameTile key={group.id} group={group} onOpen={() => selectGroup(group)} />)}</div>)}
      </main>}
    </div>
    {!active && <TvFooter />}
    {overlay && <div className="tv-veil">
      <div className={`tv-dialog tv-dialog-${overlay}`} role="dialog" aria-modal="true" aria-label={t(title[overlay])} ref={dialog}>
        <header><h2>{t(title[overlay])}</h2><button type="button" onClick={onBack}>{t('Back')}</button></header>
        {actionError && <p className="error" role="alert">{t(actionError)}</p>}
        {overlay === 'search' && <TvKeyboard label={t('Search games')} value={query} onChange={setQuery} onDone={closeOverlay} />}
        {overlay === 'phone-info' && viewedPhone && <div className="tv-handset-info">
          <img src={skinBase(viewedPhone.config.id) + 'preview.webp'} alt="" />
          <div><p>{viewedPhone.config.manufacturer} · {viewedPhone.config.year}</p>
            <p>{t('Display')} · {viewedPhone.config.screen.width}×{viewedPhone.config.screen.height}</p></div>
        </div>}
        {overlay === 'build' && <div className="tv-choices">{builds.map(build =>
          <button type="button" key={build.id} aria-pressed={selected?.id === build.id} onClick={() => { setSelected(build); closeOverlay(); }}>
            {build.fileName || build.name} · {build.version || '—'}{build.nativeResolution && ` · ${build.nativeResolution.width}×${build.nativeResolution.height}`}
          </button>)}</div>}
        {overlay === 'phone' && selected && <div className="tv-phone-grid">{skinsError ? <p role="alert">{skinsError}</p> : !skins ? <p>{t('Loading…')}</p> :
          skins.flatMap(skin => {
            const { id, manufacturer, model } = skin.config;
            const java = tvPlatform(selected) === 'j2me';
            if (!isSkinId(id)) return [];
            const preview = <img alt="" src={skinBase(id) + 'preview.webp'} loading="lazy" />;
            const name = manufacturer + ' ' + model;
            if (java) return <button type="button" key={id} disabled={saving} aria-pressed={selected.settings.skinId === id}
              onClick={() => void updateGame({ settings: { skinId: id } })}>{preview}<span>{name}</span></button>;
            const generation = generationOfPackage(selected.packageFormat);
            const profiles = profilesForSkin(id, tvPlatform(selected)).filter(device => device.engine === 'eka2l1' && (!generation || generationOfOs(device.os) === generation));
            return profiles.map(device => {
              if (device.engine !== 'eka2l1') return null;
              const available = phoneCatalog?.availability.some(item => item.deviceId === device.id && item.available);
              const current = selected.settings.skinId === id && (!selected.settings.emulatedDeviceId || selected.settings.emulatedDeviceId === device.id);
              return <button type="button" key={device.id} disabled={!available || saving} aria-pressed={current}
                onClick={() => void updateGame({ settings: { skinId: id, emulatedDeviceId: device.id, symbianDevice: device.firmware.product } })}>
                {preview}<span>{name}{profiles.length > 1 ? ` · ${device.firmware.product}` : ''}{phoneCatalog && !available ? ` · ${t('Needs firmware')}` : ''}</span>
              </button>;
            });
          })}</div>}
        {overlay === 'options' && selected && <EmulationTweaksForm value={selected.settings.emulation ?? {}}
          onChange={emulation => void updateGame({ settings: { emulation } })}
          pointerDefault={phoneHasTouch(selected.settings.skinId)} fullscreenDefault={false} />}
        {overlay === 'controls' && <GamepadSettings gameId={selected?.id} state={padState} poller={gamepad.current} />}
        {overlay === 'confirm' && <>
          <p>{t('Save inside the game first. Progress that the game has not saved may be lost.')}</p>
          <button type="button" disabled={stopping} onClick={() => void confirmStop()}>{t(stopping ? 'Stopping…' : stopTarget === 'desktop' ? 'Stop and exit TV Mode' : 'Stop and return to library')}</button>
        </>}
        {overlay === 'menu' && <>
          <div className="tv-actions">
            {active && <button type="button" data-tv-prefer onClick={() => { handle.current?.resume(); closeOverlay(); }}>{t('Resume')}</button>}
            <button type="button" onClick={() => setOverlay('controls')}>{t('Controller mapping')}</button>
            <button type="button" onClick={() => void fullscreen()}>{t('Toggle fullscreen')}</button>
          </div>
          {fullscreenError && <p className="note warn">{t(fullscreenError)}</p>}
          <div className="tv-setting">
            <span>{t('Display')}</span><div className="tv-actions">{([['lights', 'Lights Out'], ['screen', 'Screen'], ['full', 'Phone'], ['bare', 'Game only']] as const).map(([value, label]) =>
              <button type="button" key={value} aria-pressed={display === value} onClick={() => selectDisplay(value)}>{t(label)}</button>)}</div>
          </div>
          <div className="tv-setting">
            <button type="button" aria-pressed={integer} onClick={() => { setInteger(!integer); preference.write('integer', integer ? 'off' : 'on'); }}>{t('Whole-number scaling')}</button>
            <button type="button" aria-pressed={vibration} onClick={() => { setVibration(!vibration); preference.write('vibration', vibration ? 'off' : 'on'); gamepad.current?.stopRumble(); }}>{t('Gamepad vibration')}</button>
          </div>
          <div className="tv-setting">
            <span>{t('Volume')} {volume}%</span>
            <button type="button" aria-label={t('Lower volume')} onClick={() => { const value = Math.max(0, volume - 10); setVolume(value); preference.write('volume', String(value)); }}>−</button>
            <button type="button" aria-label={t('Raise volume')} onClick={() => { const value = Math.min(100, volume + 10); setVolume(value); preference.write('volume', String(value)); }}>+</button>
          </div>
          <div className="tv-actions">
            {active && <button type="button" onClick={() => exitRequest('library')}>{t('Stop and return to library')}</button>}
            <button type="button" onClick={() => exitRequest('desktop')}>{t('Exit TV Mode')}</button>
          </div>
        </>}
      </div>
    </div>}
  </div>;
}
