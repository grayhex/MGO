import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
type Status = Awaited<ReturnType<typeof api.ngageCatalog>>;
/** Settings → Game metadata: how many N-Gage games were recognised, which were not, and why covers may be missing. */
export function NgageCatalogPanel({ toast, onChanged }: { toast: (kind: 'info' | 'error', text: string) => void; onChanged: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    let dead = false;
    let wasRunning = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.ngageCatalog();
        if (!dead) {
          setStatus(next);
          if (wasRunning && !next.running) changed.current();
          wasRunning = next.running;
        }
      } catch { /* retry */ }
      if (!dead) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { dead = true; clearTimeout(timer); };
  }, []);
  const total = (status?.matched ?? 0) + (status?.unmatched.length ?? 0);
  return (
    <div className="catalog-source" data-testid="ngage-catalog">
      <h3>N-Gage</h3>
      <p className="muted small">{t('Genres and game details come from All About Symbian. LaunchBox Games Database supplies additional titles and covers.')}</p>
      <p><strong>{status?.matched ?? 0}</strong> {t('of')} <strong>{total}</strong> {t('N-Gage games recognised')}{status && status.covers > 0 ? ` · ${status.covers} ${t('covers')}` : ''}</p>
      {status && status.unmatched.length > 0 && <details className="more"><summary>{t('Not recognised')}: {status.unmatched.length}</summary><ul className="plain-list">{status.unmatched.map((n) => <li key={n}>{n}</li>)}</ul><p className="muted small">{t('Only games of the original N-Gage (.zip card dumps) are in the directory. Rename the file to the game’s title to be recognised.')}</p></details>}
      {status?.running && <p className="muted small" role="status">
        {status.progress ? t('Metadata checked: {done}/{total}', { done: status.progress.done, total: status.progress.total }) : t('Connecting to catalog sources…')}
      </p>}
      {status?.error && <p className="note warn" role="status">{t(status.error)}</p>}
      <div className="btn-row">
        <button className="btn" disabled={!!status?.running} onClick={() => void api.ngageCatalogRefresh().then(setStatus, e => toast('error', e.message))}>{t(status?.running ? 'Updating…' : 'Update N-Gage metadata')}</button>
        <a href="https://allaboutsymbian.com/n-gage-games/original/" target="_blank" rel="noreferrer">All About Symbian ↗</a>
        <a href="https://gamesdb.launchbox-app.com/platforms/games/213-nokia-n-gage" target="_blank" rel="noreferrer">LaunchBox Games Database ↗</a>
      </div>
    </div>
  );
}
