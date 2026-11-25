import { useEffect, useRef, useState } from 'react';
import type { ComponentResources, HealthStatus, SessionStatus, SymbianStatus, SystemStatus } from '@mgo/protocol';
import { api } from '../api';
import { t } from '../i18n';
import { KemulatorUpdatePanel } from './KemulatorUpdatePanel';
import { SystemChecks } from './SettingsForms';

const bytes = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${(n / 1048576).toFixed(1)} MB`;

function ComponentUsage({ name, readings, detail }: { name: string; readings?: ComponentResources | null; detail?: string }) {
  return <article className="system-component" aria-label={name}>
    <h3>{name}</h3>
    <div className="system-component-bars">
      <div>
        <span>CPU</span><strong>{readings?.cpuPercent == null ? '—' : `${readings.cpuPercent.toFixed(1)}%`}</strong>
        <progress max={100} value={readings?.cpuPercent ?? 0} aria-label={`${name} CPU`} aria-valuetext={readings?.cpuPercent == null ? t('Unavailable') : undefined} />
      </div>
      <div title={detail}>
        <span>{t('Memory')}</span>
        <strong>{readings ? bytes(readings.memoryBytes) : '—'}<small>{readings?.memoryLimitBytes ? ` / ${bytes(readings.memoryLimitBytes)}` : ''}</small></strong>
        <progress max={readings?.memoryLimitBytes || 1} value={readings?.memoryLimitBytes ? readings.memoryBytes : 0} aria-label={`${name} ${t('Memory')}`} aria-valuetext={readings?.memoryLimitBytes ? undefined : t('Unavailable')} />
      </div>
    </div>
  </article>;
}

export function SystemDashboard({ toast }: { toast: (kind: 'info' | 'error', text: string) => void }) {
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [symbian, setSymbian] = useState<SymbianStatus | null>(null);
  const [sessions, setSessions] = useState<SessionStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    let dead = false, loading = false; let timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      if (loading) return; loading = true;
      try {
        const [sys, h, sym, runs] = await Promise.all([api.systemStatus(), api.health(), api.symbianStatus(), api.sessions()]);
        if (!dead) { setSystem(sys); setHealth(h); setSymbian(sym); setSessions(runs.filter(s => ['running', 'starting'].includes(s.state))); setError(null); }
      } catch (e) { if (!dead) setError((e as Error).message); }
      finally { loading = false; if (!dead) timer = setTimeout(sample, 5000); }
    };
    refresh.current = () => { clearTimeout(timer); void sample(); }; void sample();
    return () => { dead = true; clearTimeout(timer); };
  }, []);
  const m = system?.monitoring;
  const memoryDetail = m?.memoryCacheBytes != null
    ? t('Accounted: {total} · inactive file cache: {cache}', { total: bytes(m.memoryUsageBytes), cache: bytes(m.memoryCacheBytes) })
    : t(m?.memoryScope === 'process' ? 'MGO process memory' : 'Memory working set');
  return <div className="system-dashboard">
    <div className="system-toolbar"><span className="badge prod">{t('Live monitoring')} · 5 s</span><span className="muted small">{system?.sampledAt ? new Date(system.sampledAt).toLocaleTimeString() : t('Connecting…')}</span><button className="btn sm" onClick={() => refresh.current()}>{t('Refresh')}</button></div>
    {error && <p className="note err" role="alert">{error}</p>}
    <div className="system-components" role="group" aria-label={t('Component resource usage')}>
      <ComponentUsage name={t('MGO app')} readings={m} detail={memoryDetail} />
      <ComponentUsage name={t('HTTPS gateway')} readings={system?.gateway} />
      <ComponentUsage name={t('Symbian service')} readings={symbian?.metrics} />
    </div>
    <div className="system-metrics">
      <article className="metric"><span>{t('Data storage')}</span><strong>{system ? bytes(system.storage.freeBytes) : '—'}</strong><small>{t('free')} · {system ? bytes(system.storage.totalBytes) : ''}</small>{system && <progress max={system.storage.totalBytes || 1} value={Math.max(0, system.storage.totalBytes - system.storage.freeBytes)} aria-label={t('Data storage')} />}</article>
      <article className="metric"><span>{t('Active sessions')}</span><strong>{sessions.length}</strong><small>{m ? `${t('Uptime')} ${Math.floor(m.uptimeSeconds / 3600)}h ${Math.floor(m.uptimeSeconds / 60) % 60}m · ${m.frames} ${t('frames')} · ${bytes(m.audioBytes)} PCM` : ''}</small></article>
    </div>
    <div className="system-engines">
      <article><h3>MGO <span className="badge prod">{t('Online')}</span></h3><code>{system?.version ?? '—'}</code><p>{m?.platform} · Node {m?.nodeVersion}</p><p className="small">{location.protocol === 'https:' ? t('HTTPS connection') : t('HTTP connection — enable HTTPS at the gateway')}</p></article>
      <article><h3>KEmulator <span className={`badge ${health?.ok ? 'prod' : 'danger'}`}>{t(health?.ok ? 'Ready' : 'Unavailable')}</span></h3><code title={health?.kemulator.commit ?? undefined}>{health?.kemulator.version ? `v${health.kemulator.version}` : '—'}</code><p>Java {health?.java.version ?? '—'}</p><KemulatorUpdatePanel onChanged={() => refresh.current()} /></article>
      <article><h3>EKA2L1 <span className={`badge ${symbian?.reachable ? 'prod' : 'danger'}`}>{t(symbian?.reachable ? symbian.busy ? 'Running' : 'Ready' : 'Unavailable')}</span></h3><code>{symbian?.emulator ?? '—'}</code><p>{symbian?.firmware.devices.length ?? 0} {t('Installed devices')}</p>{symbian?.audioDiagnostics && <p className={symbian.audioDiagnostics.ready ? 'muted' : 'note err'}>PulseAudio {symbian.audioDiagnostics.version ?? ''} · {symbian.audioDiagnostics.ready ? t('Ready') : symbian.audioDiagnostics.error} · {bytes(symbian.audioDiagnostics.bytes)} PCM</p>}<a href="/api/symbian/diagnostics" download>{t('Download Symbian diagnostics')}</a></article>
    </div>
    {sessions.map(s => <article className="system-session" key={s.id}><a href={`/play/${s.gameId}`}>{s.gameName ?? s.gameId}</a><span>{s.backend} · {s.width}×{s.height}</span><span>{s.fps.toFixed(1)} FPS</span>{s.resources && <span title={t('Session CPU usage as a percentage of one core')}>CPU {s.resources.cpuPercentNow.toFixed(0)}%</span>}<a href={`/api/sessions/${s.id}/diagnostics`} download>{t('Diagnostics')}</a></article>)}
    <details className="more system-checks">
      <summary>{t('Server checks')}</summary>
      {m && <p className="small muted system-cpu-detail">{m.cpuCores} {t('CPU cores')} · {memoryDetail}{m.oomKills ? ` · ${t('Processes killed for exceeding memory: {n}', { n: m.oomKills })}` : ''}</p>}
      <SystemChecks status={system} />
    </details>
  </div>;
}
