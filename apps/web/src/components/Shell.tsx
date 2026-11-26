import { api } from '../api';
import { t as translateUI } from '../i18n';
import type { HealthStatus, SymbianStatus } from '@mgo/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { PlatformTag } from './PlatformTag';
import { useTheme } from '../theme';
import { ThemeToggle } from './ThemeToggle';
import { LanguageSwitch } from './LanguageSwitch';
import { getLastGame, setLastGame, useLastGame } from '../lastGame';

export function Link({ to, children, className, onNavigate, ...rest }: { to: string; children: ReactNode; className?: string; onNavigate: (to: string) => void } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  return (
    <a
      {...rest}
      href={to}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onNavigate(to);
      }}
    >
      {children}
    </a>
  );
}

const COLLAPSE = 'j2me-web.sidebar';

function appVersion(version?: string): string {
  if (!version) return '—';
  const clean = version.replace(/^v(?=\d)/i, '');
  const edge = /\+edge\.([a-f0-9]+)/i.exec(clean);
  if (edge) return `Edge · ${edge[1]}`;
  return /^\d/.test(clean) ? `v${clean}` : clean;
}

export function Shell({ path, go, health, symbian, title, subtitle, children }: {
  path: string; go: (to: string) => void; health: HealthStatus | null;
  symbian?: SymbianStatus | null;
  title: string; subtitle?: string; children: ReactNode;
}) {
  const theme = useTheme();
  const lastGame = useLastGame();
  const inPlayer = path.startsWith('/play/');
  useEffect(() => {
    if (!lastGame || lastGame.platform || inPlayer) return;
    const request = new AbortController();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    void api.gameMeta(lastGame.id, signal).then(game => {
      if (!request.signal.aborted && getLastGame()?.id === game.id) setLastGame({ id: game.id, name: game.name, platform: game.platform ?? 'j2me' });
    }, () => undefined);
    return () => request.abort();
  }, [lastGame, inPlayer]);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE) === '1'; } catch { return false; } });
  const [counts, setCounts] = useState<Awaited<ReturnType<typeof api.gameCounts>> | null>(null);
  useEffect(() => {
    let request: AbortController | undefined;
    const refresh = () => {
      request?.abort();
      const pending = request = new AbortController();
      void api.gameCounts(AbortSignal.any([pending.signal, AbortSignal.timeout(5000)])).then(value => {
        if (!pending.signal.aborted) setCounts(value);
      }, () => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('j2me:library-changed', refresh);
    return () => { request?.abort(); window.clearInterval(timer); window.removeEventListener('j2me:library-changed', refresh); };
  }, [path]);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { try { localStorage.setItem(COLLAPSE, collapsed ? '1' : '0'); } catch { /* private mode */ } }, [collapsed]);
  useEffect(() => { setDrawer(false); }, [path]);
  useEffect(() => {
    if (!drawer) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [drawer]);

  const item = (to: string, icon: IconName, label: string, active: boolean) => (
    <Link to={to} onNavigate={go} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} title={translateUI(label)}>
      <Icon name={icon} />
      <span className="nav-label">{translateUI(label)}</span>
    </Link>
  );
  return (
    <div className={`app ${collapsed ? 'shell-collapsed' : ''} ${drawer ? 'shell-drawer' : ''}`}>
      <aside className="sidebar glass" aria-label={translateUI("Main navigation")}>
        <Link to="/" onNavigate={go} className="brand" aria-label={translateUI("MGO home")}>
          <img className="brand-logo" src={theme === 'dark' ? '/graphics/brand/logo-horizontal.svg' : '/graphics/brand/logo-light.svg'} alt="" />
          <img className="brand-mark-img" src="/graphics/brand/mark.svg" alt="" width={32} height={32} />
          <span className="brand-text sr-only">{translateUI("MGO")}</span>
        </Link>
        <nav className="nav">
          {item('/', 'library', 'Library', path === '/')}
          {counts && <dl className="nav-library-counts" aria-label={translateUI('Library by platform')} data-testid="library-counts">
            {([['J2ME', 'j2me'], ['N-Gage', 'ngage'], ['Symbian', 'symbian']] as const).map(([label, kind]) => <div key={kind}>
              <dt>{label}</dt><dd>{counts[kind].toLocaleString()}</dd>
            </div>)}
          </dl>}
          {lastGame && <Link to={`/play/${lastGame.id}`} onNavigate={go} data-testid="current-game" className={`nav-item current-game ${inPlayer ? 'active' : ''}`} title={lastGame.name} aria-label={translateUI('Current game: {name}', { name: lastGame.name })}>
            <Icon name="play" />
            <span className="nav-label"><small>{translateUI('Current game')}</small><strong>{lastGame.name}</strong>{lastGame.platform && <small><PlatformTag platform={lastGame.platform} size="sm" className="bare" /></small>}</span>
          </Link>}
          {item('/phones', 'phone', 'Phones', path === '/phones')}
          {item('/settings', 'sliders', 'Settings', path === '/settings')}
          {item('/tv', 'device', 'TV Mode', false)}
        </nav>
        <div className="sidebar-foot">
          <div className="runtime-list" aria-label={translateUI('Application and emulators')}>
            <div className="runtime" title={`MGO ${health?.version ?? '—'}`}><span className={`dot ${health ? '' : 'bad'}`} aria-hidden /><span className="runtime-text"><b>MGO <em>{translateUI(health ? 'Online' : 'Connecting…')}</em></b><small>{translateUI('Frontend web app')} · <span title={health?.version}>{appVersion(health?.version)}</span></small></span></div>
            <div className="runtime" title={`KEmulator ${health?.kemulator.commit ?? '—'}`}><span className={`dot ${health?.ok ? '' : 'bad'}`} aria-hidden /><span className="runtime-text"><b>KEmulator <em>{translateUI(health?.ok ? 'Ready' : 'Unavailable')}</em></b><small title={health?.kemulator.commit ?? undefined}>{translateUI('Java ME emulator')} · {health?.kemulator.version ? `v${health.kemulator.version}` : '—'}</small></span></div>
            <div className="runtime" data-testid="symbian-runtime" title={`EKA2L1 ${symbian?.emulator ?? '—'}`}><span className={`dot ${symbian?.reachable && symbian.firmware.installed ? '' : 'bad'}`} aria-hidden /><span className="runtime-text"><b>EKA2L1 <em>{translateUI(!symbian?.configured ? 'Not configured' : !symbian.reachable ? 'Unavailable' : symbian.busy ? 'Running' : symbian.firmware.installed ? 'Ready' : 'Needs firmware')}</em></b><small title={symbian?.emulator ?? undefined}>{translateUI('Symbian / N-Gage emulator')} · {symbian?.emulator?.replace(/^EKA2L1\s*/, '') ?? '—'}</small></span></div>
          </div>
          {health?.auth === 'token' && (
            <button className="nav-item" onClick={() => void api.logout().finally(() => location.reload())} title={translateUI('Sign out of this browser')} data-testid="sign-out">
              <Icon name="back" />
              <span className="nav-label">{translateUI('Sign out')}</span>
            </button>
          )}
          <button className="nav-item hide-mobile" onClick={() => setCollapsed((c) => !c)} aria-pressed={collapsed} title={translateUI(collapsed ? 'Expand sidebar' : 'Collapse sidebar')}>
            <Icon name="sidebar" />
            <span className="nav-label">{translateUI(collapsed ? 'Expand' : 'Collapse')}</span>
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setDrawer(false)} aria-hidden />
      <header className="header glass">
        <button className="btn-shell show-mobile" onClick={() => setDrawer(true)} aria-label={translateUI("Open menu")}><Icon name="menu" /></button>
        <div style={{ minWidth: 0 }}>
          <div className="header-title">{translateUI(title)}</div>
          {subtitle && <div className="header-sub">{translateUI(subtitle)}</div>}
        </div>
        <div className="header-language"><ThemeToggle /><LanguageSwitch onShell /></div>
      </header>
      <main className="content" id="main">
        <div className={`container${inPlayer ? ' wide' : ''}`}>{!inPlayer && <div className="workspace-language"><ThemeToggle /><LanguageSwitch /></div>}{children}</div>
      </main>
    </div>
  );
}
