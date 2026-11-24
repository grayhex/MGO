import { useEffect, useState } from 'react';
import type { ArchiveStatus, CuratedImport, CuratedTitle, CuratedDestination } from '@mgo/protocol';
import { api } from '../api';
import { t } from '../i18n';
import { Icon } from './Icon';
import { setServerSettings, useServerSettings } from '../serverSettings';
import { archiveSize } from './ArchiveBrowser';

export function CuratedSetup() {
  const savedFolder = useServerSettings()?.settings.archiveDownloadFolder ?? 'Curated Java ME';
  const [folder, setFolder] = useState(savedFolder);
  const [destination, setDestination] = useState<CuratedDestination | null>(null);
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [job, setJob] = useState<CuratedImport | null>(null);
  const [titles, setTitles] = useState<CuratedTitle[] | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [reviewAll, setReviewAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    const [archive, curated] = await Promise.all([api.archiveStatus(), api.curatedStatus()]);
    setStatus(archive); setJob(curated.job); setDestination(curated.destination);
  }
  useEffect(() => { setFolder(savedFolder); }, [savedFolder]);
  const installing = status?.indexJob?.state === 'running';
  const running = job?.state === 'running';
  useEffect(() => {
    void refresh().catch(e => setError((e as Error).message));
  }, []);
  useEffect(() => {
    if (!installing && !running) return;
    const timer = window.setInterval(() => void refresh().catch(() => {}), 1200);
    return () => window.clearInterval(timer);
  }, [installing, running]);
  useEffect(() => {
    if (job?.state && job.state !== 'running' && job.imported) window.dispatchEvent(new Event('j2me:library-changed'));
  }, [job?.state, job?.imported]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const preview = () => act(async () => {
    const { titles } = await api.curatedPreview();
    setTitles(titles);
    setSelected(Object.fromEntries(titles.flatMap(row => {
      const proposed = row.builds.find(b => b.sha256 === row.suggested);
      return proposed && !proposed.gameId && !proposed.otherBuildsInLibrary ? [[row.title, proposed.sha256]] : [];
    })));
  });
  const selection = Object.entries(selected).filter(([, sha256]) => sha256).map(([title, sha256]) => ({ title, sha256 }));
  const selectedBytes = selection.reduce((sum, b) => sum + (titles?.find(row => row.title === b.title)?.builds.find(build => build.sha256 === b.sha256)?.size ?? 0), 0);
  const needsReview = titles?.filter(row => !row.suggested && row.builds.length).length ?? 0;
  const missing = titles?.filter(row => !row.builds.length).length ?? 0;

  return <section className="archive-settings" aria-label={t('Curated Java ME library')}>
    <div className="archive-settings-head"><div>
      <h3><Icon name="library" /> {t('Curated Java ME library')}</h3>
      <p className="muted small">{t('Choose builds from the curated list to create your library.')} <a href="https://github.com/grayhex/MGO/blob/main/apps/api/archive-tools/java_curated_top.txt" target="_blank" rel="noreferrer">{t('View the game list')} ↗</a></p>
    </div></div>
    <form className="curated-destination" onSubmit={event => {
      event.preventDefault();
      void act(async () => {
        setServerSettings(await api.patchSettings({ archiveDownloadFolder: folder.trim() }));
        await refresh();
      });
    }}>
      <label className="field">
        <span>{t('Download subfolder')}</span>
        <input className="input" value={folder} onChange={event => setFolder(event.target.value)} maxLength={512} required disabled={running} />
      </label>
      <button className="btn sm" type="submit" disabled={running || busy || folder.trim() === savedFolder}>{t('Save')}</button>
      {destination && <p className="small">{t('Destination')} <code>{destination.path}</code></p>}
      {destination && !destination.writable && <p className="small error">{t('The Java ME folder is read-only. Give MGO write access to download here.')}</p>}
    </form>
    {status && !status.index && <div className="btn-row">
      <button className="btn sm primary" type="button" disabled={busy || installing} onClick={() => void act(async () => { await api.archiveIndex(); await refresh(); })}>{t(installing ? 'Installing archive index…' : 'Install index')}</button>
      {installing && <button className="btn sm" type="button" onClick={() => void act(async () => { await api.archiveCancelIndex(); await refresh(); })}>{t('Cancel index installation')}</button>}
    </div>}
    {installing && <progress aria-label={t('Index progress')} max={status?.indexJob?.total ?? 1} value={status?.indexJob?.processed || undefined} />}
    {status?.indexJob?.state === 'failed' && <p className="note err">{t(status.indexJob.message ?? 'Archive source is unavailable')}</p>}
    {status?.index && !running && !titles && <div><button className="btn sm primary" type="button" disabled={busy} onClick={() => void preview()}>{t(busy ? 'Searching…' : 'Find curated builds')}</button></div>}
    {titles && !running && <>
      <div className="btn-row">
        <span className="chip">{t('{n} selected', { n: selection.length })} · {archiveSize(selectedBytes)}</span>
        <span className="chip">{t('{n} to review', { n: needsReview })}</span>
        <span className="chip">{t('{n} not found', { n: missing })}</span>
        <button className="btn sm ghost" type="button" onClick={() => setReviewAll(value => !value)}>{t(reviewAll ? 'Show selected builds' : 'Review all titles')}</button>
      </div>
      <ul className="curated-rows">
        {titles.filter(row => reviewAll || selected[row.title]).map(row => <li key={row.title}>
          <label className="field">
            <span>{row.title}</span>
            {row.builds.length ? <select className="select" value={selected[row.title] ?? ''} onChange={e => setSelected(previous => ({ ...previous, [row.title]: e.target.value }))}>
              <option value="">{t('Skip')}</option>
              {row.builds.map(build => <option key={build.sha256} value={build.sha256}>{build.title || build.filename} · {build.vendor || t('Unknown')} · {build.version || '—'} · {build.sha256.slice(0, 8)}{build.gameId ? ' · ' + t('Already in library') : ''}</option>)}
            </select> : <small className="muted">{t('No archive builds found.')}</small>}
          </label>
        </li>)}
      </ul>
      <p className="hint">{t('Some builds are stored in shared 7z blocks. Retrieving one small JAR may require downloading and unpacking a much larger block.')}</p>
      <div><button className="btn sm primary" type="button" disabled={busy || !selection.length || !destination?.writable || folder.trim() !== savedFolder} onClick={() => void act(async () => { setJob(await api.curatedImport(selection)); setTitles(null); })}>{t('Download {n} selected games', { n: selection.length })}</button></div>
    </>}
    {job && <div className="archive-progress">
      <div className="btn-row">
        <span role="status">{t('{done}/{total} imported · {duplicates} already installed · {errors} failed', { done: job.imported, total: job.total, duplicates: job.duplicates, errors: job.failed.length })}</span>
        {running && <button className="btn sm" type="button" disabled={busy} onClick={() => void act(async () => { await api.curatedCancel(); await refresh(); })}>{t('Cancel download')}</button>}
      </div>
      {running && <><progress aria-label={t('Download progress')} max={job.total} value={job.imported + job.duplicates + job.failed.length} /><p className="small"><strong>{job.current}</strong>{job.currentBytes ? ` · ${archiveSize(job.currentBytes)} JAR` : ''}</p>
        <p className="hint">{blockProgress(job.progress)}</p></>}
      {job.destination && <p className="small muted">{t('Destination')} <code>{job.destination}</code></p>}
      {!!job.failed.length && <details className="more"><summary>{t('Errors')} ({job.failed.length})</summary><ul>{job.failed.map(failure => <li key={failure.title}>{failure.title} · {t(failure.message)}</li>)}</ul></details>}
    </div>}
    {error && <p className="note err" role="alert">{t(error)}</p>}
  </section>;
}


function blockProgress(line: string | null): string {
  const values = line && /^Decoded\s+([\d.]+)%\s*\|\s*([\d.]+)\/([\d.]+) MiB \| downloaded ([\d.]+) MiB \| cached ([\d.]+) MiB/.exec(line);
  return values ? t('Unpacked {done}/{total} MiB · downloaded {received} MiB · reused {cached} MiB', {
    done: values[2]!, total: values[3]!, received: values[4]!, cached: values[5]!,
  }) : t('Preparing archive data…');
}
