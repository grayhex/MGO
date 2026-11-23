import { useCallback, useEffect, useState } from 'react';
import type { ArchiveMatchState, ArchiveReviewItem, ArchiveStatus } from '@mgo/protocol';
import { api } from '../api';
import { t } from '../i18n';
import { archiveSite, archiveSize, ArchivePages } from './ArchiveBrowser';
import { Icon } from './Icon';

export const archiveMatchLabel: Record<ArchiveMatchState, string> = {
  exact: 'Archive matched', manual: 'Manually linked', review: 'Needs review', unknown: 'Unmatched',
};

export function ArchiveSettings({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<{ rows: ArchiveReviewItem[]; more: boolean } | null>(null);
  const [preview, setPreview] = useState(false);
  const [page, setPage] = useState(0);
  const refresh = useCallback(async () => { setStatus(await api.archiveStatus()); }, []);
  useEffect(() => { void refresh().catch(e => setError((e as Error).message)); }, [refresh]);
  const active = status?.indexJob?.state === 'running' || status?.matchJob?.state === 'running';
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void refresh().catch(() => {}), 900);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const act = async (action: () => Promise<unknown>, changed = false) => {
    setBusy(true);
    setError('');
    try { await action(); await refresh(); if (changed) onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const show = async (isPreview: boolean, next: number) => {
    setRows(await api.archiveReview(isPreview, next));
    setPage(next);
    setPreview(isPreview);
  };
  const newMatch = (resume: boolean) => void act(async () => { await api.archiveMatch(resume); setRows(null); });
  const index = status?.index;
  const install = status?.indexJob;
  const match = status?.matchJob;

  return <section className="archive-settings" aria-label={t('J2ME Archive')}>
    <div className="archive-settings-head">
      <div><h3><Icon name="library" /> J2ME Archive</h3><p className="muted small">{t('Identify exact Java ME builds and find individual JARs.')}</p></div>
      <a href={archiveSite} target="_blank" rel="noreferrer">toca-1 ↗</a>
    </div>
    <div className="archive-setting-row">
      <div><strong>{t('Local index')}</strong>
        <small className="muted">{index
          ? t('{version} · {count} builds · {size}', { version: index.version, count: index.builds.toLocaleString(), size: archiveSize(index.bytes) })
          : t('Index not installed')}</small>
        {index && <small className="muted">{t('Last synced')} {new Date(index.builtAt).toLocaleString()}</small>}
      </div>
      <div className="btn-row">
        {install?.state === 'running' ? <button className="btn sm" type="button" disabled={busy} onClick={() => void act(api.archiveCancelIndex)}>{t('Cancel index installation')}</button> : <>
          <button className="btn sm primary" type="button" disabled={busy || active || !status} onClick={() => void act(api.archiveIndex)}>{t(index ? 'Update index' : 'Install index')}</button>
          {index && <button className="btn sm" type="button" disabled={busy || active} onClick={() => {
            if (window.confirm(t('Remove the local archive index? Saved matches stay in the library.'))) void act(api.archiveRemoveIndex);
          }}>{t('Remove index')}</button>}
        </>}
      </div>
    </div>
    {status && <small className="muted">{t('Available snapshot {version} · download about 157 MB · index quota {quota}', { version: status.availableVersion, quota: archiveSize(status.maxIndexBytes) })}</small>}
    {install?.state === 'running' && <progress aria-label={t('Index progress')} max={install.total ?? 1} value={install.processed || undefined} />}
    {install?.state === 'failed' && <p className="note err" role="alert">{t(install.message ?? 'Archive source is unavailable')}</p>}
    <div className="archive-setting-row">
      <div><strong>{t('Match library with J2ME Archive')}</strong><small className="muted">{t('Preview first. Only fill missing fields.')}</small></div>
      <div className="btn-row">
        {match?.state === 'running'
          ? <button className="btn sm" type="button" disabled={busy} onClick={() => void act(api.archivePause)}>{t('Pause matching')}</button>
          : <>
            {match?.state === 'paused' && <button className="btn sm primary" type="button" disabled={busy || active || !index} onClick={() => newMatch(true)}>{t('Resume matching')}</button>}
            <button className="btn sm" type="button" disabled={busy || active || !index} onClick={() => newMatch(false)}>{t('Start preview')}</button>
          </>}
      </div>
    </div>
    {match && <div className="archive-progress" aria-live="polite">
      <div className="archive-counts">
        {[
          ['JAR files', match.total], ['Exact matches', match.exact], ['Needs review', match.review],
          ['Unmatched', match.unknown], ['Skipped', match.skipped], ['Errors', match.errors],
        ].map(([label, count]) => <span className="chip" key={label}><strong>{count}</strong> {t(label)}</span>)}
      </div>
      {match.state === 'running' && <progress max={Math.max(1, match.total)} value={match.processed} aria-label={t('Matching progress')} />}
      {match.state === 'paused' && <span className="hint">{t('Matching paused')}</span>}
      {match.error && <p className="note err">{t(match.error)}</p>}
      {match.state === 'preview' && <div className="btn-row">
        <button className="btn sm" disabled={busy} onClick={() => void act(() => show(true, 0))}>{t('View preview')}</button>
        {rows && preview && <button className="btn sm primary" disabled={busy || !index} onClick={() => void act(async () => {
          await api.archiveApply();
          await show(false, 0);
        }, true)}>{t('Apply archive matches')}</button>}
      </div>}
      {match.state === 'applied' && <div className="btn-row"><span className="badge prod">{t('Matches applied')}</span>
        {match.review > 0 && <button className="btn sm" disabled={busy} onClick={() => void act(() => show(false, 0))}>{t('Review possible matches')}</button>}
      </div>}
    </div>}
    {rows && <div className="archive-review">
      {!rows.rows.length && <p className="muted">{t('Nothing to review.')}</p>}
      {rows.rows.map(item => {
        const fillVendor = item.vendor === 'Unknown' && item.match.build?.vendor;
        const fillVersion = !item.version && item.match.build?.version;
        return <details key={item.gameId}>
        <summary><strong>{item.name}</strong><span className="badge plain">{t(archiveMatchLabel[item.match.state])}</span></summary>
        <code className="archive-digest">{item.sha256}</code>
        {item.match.build && <div className="stack">
          <p className="hint">{t('Exact SHA-256. Provenance will be saved.')}</p>
          {fillVendor && <span className="small">{t('Vendor')} · {fillVendor}</span>}
          {fillVersion && <span className="small">{t('Version')} · {fillVersion}</span>}
        </div>}
        {item.candidates.length > 0 && <ul className="archive-candidates">{item.candidates.map(build => <li key={build.sha256}>
          <span><strong>{build.title || build.filename}</strong><small className="muted">{build.vendor} · {build.version || t('Unknown')} · {build.sha256.slice(0, 16)}…</small></span>
          {!preview && <button className="btn sm" disabled={busy} onClick={() => void act(async () => {
            await api.archiveConfirm(item.gameId, build.sha256);
            await show(false, page);
          }, true)}>{t('Confirm related build')}</button>}
        </li>)}</ul>}
        {!preview && <button className="btn sm ghost" disabled={busy} onClick={() => void act(async () => {
          await api.archiveConfirm(item.gameId, null);
          await show(false, page);
        }, true)}>{t('Keep unmatched')}</button>}
      </details>; })}
      <ArchivePages page={page} more={rows.more} busy={busy} onPage={p => void act(() => show(preview, p))} />
    </div>}
    {error && <p className="note err" role="alert">{t(error)}</p>}
  </section>;
}
