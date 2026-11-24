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
        if (current?.state === 'done') onChanged();
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
  return <section className="archive-settings" aria-label="My Abandonware">
    <div className="archive-settings-head">
      <div>
        <h3><Icon name="info" /> My Abandonware</h3>
        <p className="muted small">{t('Find Java ME genres, descriptions and screenshots without an API key.')}</p>
      </div>
      <button className="btn sm" disabled={busy || running} onClick={() => void start()}>{t(running ? 'Looking up Java ME metadata…' : 'Find missing game information')}</button>
    </div>
    {job && <p className="small" role="status">{t('{processed}/{total} checked · {matched} matched · {errors} errors', { processed: job.processed, total: job.total, matched: job.matched, errors: job.errors })}</p>}
    {running && <progress aria-label={t('Metadata progress')} max={job?.total || 1} value={job?.processed ?? 0} />}
    {(error || job?.state === 'failed') && <p className="note warn">{t(error || 'My Abandonware or the Java ME metadata index is temporarily unavailable')}</p>}
  </section>;
}
