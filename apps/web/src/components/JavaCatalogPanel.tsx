import { useEffect, useState } from 'react';
import type { JavaCatalogJob } from '@mgo/protocol';
import { api } from '../api';
import { t } from '../i18n';
import { Icon } from './Icon';

export function JavaCatalogPanel({ onChanged }: { onChanged: () => void }) {
  const [job, setJob] = useState<JavaCatalogJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void api.javaCatalogStatus().then(data => setJob(data.job), () => undefined); }, []);
  const running = job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void api.javaCatalogStatus().then(({ job: current }) => {
        setJob(current);
        if (current && current.state !== 'running' && current.matched) onChanged();
      }, () => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [running, onChanged]);
  async function start() {
    setBusy(true); setError('');
    try { setJob(await api.javaCatalogStart()); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true); setError('');
    try { await api.javaCatalogCancel(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="archive-settings" aria-label="My Abandonware">
    <div className="archive-settings-head">
      <div>
        <h3><Icon name="info" /> My Abandonware</h3>
        <p className="muted small">{t('Find Java ME genres, descriptions and screenshots without an API key.')}</p>
      </div>
      <button className="btn sm" disabled={busy} onClick={() => void (running ? cancel() : start())}>{t(running ? 'Cancel lookup' : job?.partial ? 'Retry missing descriptions and screenshots' : 'Find missing game information')}</button>
    </div>
    {job && <p className="small" role="status">{t('{processed}/{total} checked · {matched} matched · {errors} errors', { processed: job.processed, total: job.total, matched: job.matched, errors: job.errors })}
      {!!job.partial && ` · ${t('{n} with title and genre only', { n: job.partial })}`}
      {running && !!job.detailsTotal && ` · ${t('{done}/{total} pages checked', { done: job.detailsProcessed ?? 0, total: job.detailsTotal })}`}
      {job.state === 'cancelled' && ` · ${t('Cancelled')}`}
    </p>}
    {running && <progress aria-label={t('Metadata progress')} max={job.detailsTotal || job.total || 1} value={job.detailsTotal ? job.detailsProcessed ?? 0 : job.processed} />}
    {(error || job?.error) && <p className="note warn">{t(error || job?.error)}</p>}
  </section>;
}
