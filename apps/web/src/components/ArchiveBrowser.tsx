import { Fragment, useEffect, useState, type FormEvent } from 'react';
import type { ArchiveBuild, ArchiveDownload, ArchiveSearchItem, ArchiveStatus } from '@mgo/protocol';
import { api } from '../api';
import { t } from '../i18n';
import { navigate } from '../router';
import { Icon } from './Icon';
import { Modal } from './Modal';

export const archiveSite = 'https://toca-1.github.io/new-j2me-software-archive-search/';
const downloaderGuide = 'https://github.com/toca-1/new-j2me-software-archive-search/blob/main/docs/DOWNLOADER.md';
const archiveTerms = 'https://archive.org/about/terms.php';
const nameOf = (build: ArchiveBuild) => build.title || build.filename;
export const archiveSize = (bytes: number): string => bytes >= 1048576
  ? `${(bytes / 1048576).toFixed(1)} ${t('MB')}` : `${(bytes / 1024).toFixed(1)} ${t('KB')}`;

export function ArchiveFacts({ build }: { build: ArchiveBuild }) {
  return <dl className="facts archive-facts">
    {[
      ['MIDlet name', build.title], ['Vendor', build.vendor], ['Version', build.version],
      ['Original filename', build.filename], ['Collection', build.collection], ['Archive member', build.archivePath],
      ['Size', archiveSize(build.size)], ['MIDP / CLDC', `${build.midp || t('Unknown')} / ${build.cldc || t('Unknown')}`],
      ['SHA-256', build.sha256], ['SHA-1', build.sha1], ['CRC32', build.crc32],
    ].map(([label, value]) => <Fragment key={label}><dt>{t(label)}</dt><dd className={/^(SHA|CRC)/.test(label!) ? 'mono archive-digest' : ''}>{value || t('Unknown')}</dd></Fragment>)}
  </dl>;
}

export function ArchivePages({ page, more, busy, onPage }: { page: number; more: boolean; busy?: boolean; onPage: (page: number) => void }) {
  if (page === 0 && !more) return null;
  return <nav className="archive-pages" aria-label={t('Result pages')}>
    <button type="button" className="btn sm" disabled={!page || busy} onClick={() => onPage(page - 1)}>{t('Previous')}</button>
    <span className="muted small">{t('Page {n}', { n: page + 1 })}</span>
    <button type="button" className="btn sm" disabled={!more || busy} onClick={() => onPage(page + 1)}>{t('Next')}</button>
  </nav>;
}

type Detail = Awaited<ReturnType<typeof api.archiveBuild>>;
type Results = Awaited<ReturnType<typeof api.archiveSearch>>;
const phaseLabel = { fetching: 'Retrieving JAR', verifying: 'Verifying JAR', importing: 'Importing JAR', finished: 'Finished' };

export function ArchiveBrowser({ onClose, onImported, onPlay, initial, initialSha }: { onClose: () => void; onImported: () => void; onPlay: (id: string) => void; initial?: string; initialSha?: string }) {
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [q, setQ] = useState(initial ?? '');
  const [within, setWithin] = useState('');
  const [last, setLast] = useState({ q: initial ?? '', within: '', page: 0 });
  const [results, setResults] = useState<Results | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [root, setRoot] = useState('managed');
  const [folder, setFolder] = useState('J2ME Archive');
  const [job, setJob] = useState<ArchiveDownload | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([api.archiveStatus(), api.archiveDownload()]).then(async ([value, { job }]) => {
      if (!active) return;
      setStatus(value);
      setJob(job?.state === 'running' ? job : null);
      if (!value.index) return;
      if (initialSha) {
        const build = await api.archiveBuild(initialSha);
        if (active) setDetail(build);
      } else if (initial) {
        const found = await api.archiveSearch(initial, '', 0);
        if (active) setResults(found);
      }
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [initial, initialSha]);
  useEffect(() => {
    if (job?.state !== 'running') return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.archiveDownload().then(({ job }) => {
        if (!active) return;
        setJob(job);
        if (job?.state === 'done') { setConfirm(false); onImported(); }
      }, () => { /* A temporary disconnect does not cancel the transfer. */ });
    }, 900);
    return () => { active = false; window.clearInterval(timer); };
  }, [job?.state, onImported]);

  const act = async (action: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const search = (query: string, refinement: string, page: number) => act(async () => {
    const found = await api.archiveSearch(query, refinement, page);
    setLast({ q: query, within: refinement, page });
    setDetail(null);
    setConfirm(false);
    setResults(found);
  });
  const show = (sha: string) => act(async () => {
    setDetail(await api.archiveBuild(sha));
    setConfirm(false);
  });
  const submit = (event: FormEvent) => { event.preventDefault(); void search(q, within, 0); };
  const running = job?.state === 'running';
  const completed = job?.state === 'done' && (!detail || job.sha256 === detail.build.sha256) ? job : null;
  const destination = status?.writableRoots.find(option => option.id === root);
  const showSetup = () => { onClose(); navigate('/settings#mobygames'); };
  const sourceLink = detail?.build.collection.toLowerCase().includes('mini') ? 'https://archive.org/details/96x65pixels_j2me_mini' : 'https://archive.org/details/96x65pixels_j2me';

  return <Modal title={t('Find games in J2ME Archive')} onClose={onClose} wide>
    {status && !status.index && <div className="archive-unavailable">
      <p>{t('Install the archive index to search and match games locally.')}</p>
      <button type="button" className="btn sm primary" onClick={showSetup}><Icon name="sliders" />{t('Archive settings')}</button>
    </div>}
    {status?.index && <div className="archive-browser">
      <form className="archive-search" onSubmit={submit}>
        <label className="field"><span className="label-caps">{t('Title, filename, vendor or hash')}</span><input className="input" type="search" aria-label={t('Search the archive')} value={q} onChange={e => setQ(e.target.value)} maxLength={160} required /></label>
        <label className="field"><span className="label-caps">{t('Refine results')}</span><input className="input" type="search" value={within} onChange={e => setWithin(e.target.value)} maxLength={100} /></label>
        <button className="btn primary" type="submit" disabled={busy || q.trim().length < 2}><Icon name="search" />{t('Search')}</button>
      </form>

      {detail ? <section className="archive-detail">
        {results && <button className="btn ghost sm" type="button" onClick={() => { setDetail(null); setConfirm(false); }}><Icon name="back" />{t('Search results')}</button>}
        <h3>{nameOf(detail.build)}</h3>
        <div className="btn-row"><span className="badge plain">{detail.indexVersion}</span>{detail.build.gameId && <span className="badge prod">{t('Already in library')}</span>}</div>
        <ArchiveFacts build={detail.build} />
        <div className="archive-links">
          <a href={sourceLink} target="_blank" rel="noreferrer">Internet Archive ↗</a>
          <a href={archiveSite + '?sha256=' + detail.build.sha256} target="_blank" rel="noreferrer">{t('Archive search')} ↗</a>
          <a href={downloaderGuide} target="_blank" rel="noreferrer">{t('Downloader guide')} ↗</a>
          <button className="btn sm ghost" type="button" title={t('Copy download command')} onClick={() => void act(async () => {
            await navigator.clipboard.writeText(`python3 jarchive_download.py ${detail.build.sha256}`);
          })}><Icon name="copy" />{t('Copy command')}</button>
        </div>
        {!confirm && !completed && <div className="btn-row">
          {detail.build.gameId ? <button type="button" className="btn primary" onClick={() => onPlay(detail.build.gameId!)}><Icon name="play" />{t('Open game')}</button>
            : <button type="button" className="btn primary" disabled={running || busy} onClick={() => setConfirm(true)}><Icon name="download" />{t('Download to my library…')}</button>}
        </div>}
        {confirm && <form className="archive-confirm" onSubmit={e => {
          e.preventDefault();
          void act(async () => {
            const download = await api.archiveStartDownload(detail.build.sha256, root, folder.trim());
            setJob(download);
            if (download.state === 'done') { setConfirm(false); onImported(); }
          });
        }}>
          <div className="field-row">
            <label className="field"><span className="label-caps">{t('Writable library')}</span><select className="select" value={root} disabled={running} onChange={e => setRoot(e.target.value)}>{status.writableRoots.map(option => <option key={option.id} value={option.id} disabled={!option.writable}>{t(option.label)}{option.writable ? '' : ' · ' + t('Read-only')}</option>)}</select></label>
            <label className="field"><span className="label-caps">{t('Destination subfolder')}</span><input className="input" value={folder} disabled={running} onChange={e => setFolder(e.target.value)} required maxLength={300} /></label>
          </div>
          <p className="hint">{t('Download this JAR only if you have the right to use it.')} <a href={archiveTerms} target="_blank" rel="noreferrer">{t('Internet Archive terms')} ↗</a></p>
          {!destination?.writable && <p className="note warn">{t('The archive destination is unavailable or read-only')}</p>}
          <button type="submit" className="btn primary" disabled={running || busy || !folder.trim() || !destination?.writable}>{t(job?.sha256 === detail.build.sha256 && job.state !== 'running' ? 'Retry download' : 'Confirm download')}</button>
        </form>}
        {detail.alternatives.length > 0 && <details className="archive-alternatives"><summary>{t('Possible alternate builds')} ({detail.alternatives.length})</summary><ul className="archive-results">{detail.alternatives.map(build => <Result key={build.sha256} build={build} onSelect={() => void show(build.sha256)} disabled={busy} />)}</ul></details>}
      </section> : results && <>
        {results.builds.length > 0 ? <ul className="archive-results">{results.builds.map(build => <Result key={build.sha256} build={build} onSelect={() => void show(build.sha256)} disabled={busy} />)}</ul>
          : <p className="muted">{t('No archive builds found.')}</p>}
        <ArchivePages page={last.page} more={results.more} busy={busy} onPage={p => void search(last.q, last.within, p)} />
      </>}
    </div>}
    {running && <div className="archive-progress" role="status">
      <strong>{t(phaseLabel[job.phase])}</strong><progress aria-label={t('Download progress')} />
      {job.message && <small className="muted">{job.message}</small>}
      <button className="btn sm" type="button" onClick={() => void act(async () => { await api.archiveCancelDownload(); })}>{t('Cancel download')}</button>
    </div>}
    {job?.state === 'cancelled' && <p className="note">{t('Download cancelled. Retry to resume cached ranges.')}</p>}
    {job?.state === 'failed' && <p className="note err" role="alert">{t(job.message ?? 'Archive source is unavailable')}</p>}
    {completed && <div className="archive-success" role="status"><span><Icon name="check" /> {t(completed.duplicate ? 'Already installed' : 'JAR verified and imported')}</span>
      {completed.gameId && <button type="button" className="btn sm primary" onClick={() => onPlay(completed.gameId!)}>{t('Open game')}</button>}
    </div>}
    {error && <p className="note err" role="alert">{t(error)}</p>}
    <div className="modal-actions"><span className="spacer" /><button className="btn sm" type="button" onClick={onClose}>{t('Close')}</button></div>
  </Modal>;
}

function Result({ build, onSelect, disabled }: { build: ArchiveSearchItem; onSelect: () => void; disabled?: boolean }) {
  return <li><button type="button" className="archive-result" disabled={disabled} onClick={onSelect}>
    <span className="archive-result-main"><strong>{nameOf(build)}</strong><small>{[build.vendor || t('Unknown'), build.version, build.collection, archiveSize(build.size)].filter(Boolean).join(' · ')}</small><small>{build.filename}</small><small className="mono">{build.sha256.slice(0, 16)}…</small></span>
    <span className="archive-result-side">{build.gameId && <span className="badge prod">{t('Already in library')}</span>}{build.otherBuildsInLibrary > 0 && <small>{t('{n} other builds installed', { n: build.otherBuildsInLibrary })}</small>}</span>
    <Icon name="chevron" />
  </button></li>;
}
