import { useEffect, useState } from 'react';
import type { KemulatorRelease, KemulatorUpdateStatus } from '@mgo/protocol';
import { api } from '../api';
import { t } from '../i18n';

export function KemulatorUpdatePanel({ onChanged }: { onChanged: () => void }) {
  const [runtime, setRuntime] = useState<KemulatorUpdateStatus | null>(null);
  const [release, setRelease] = useState<KemulatorRelease | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.kemulatorRuntime().then(value => { if (active) setRuntime(value); }, reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, []);

  const run = async (action: 'check' | 'install' | 'restore') => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'check') {
        setRelease(null);
        const { release: next } = await api.checkKemulatorUpdate();
        setRelease(next);
        if (!next) setMessage(t('No newer compatible KEmulator build is published.'));
      } else {
        const next = action === 'install' && release ? await api.installKemulatorUpdate(release) : await api.restoreBundledKemulator();
        setRuntime(next); setRelease(null);
        setMessage(t('KEmulator v{version} will run the next Java ME game you start.', { version: next.version ?? '—' }));
        window.dispatchEvent(new Event('mgo:kemulator-changed'));
        onChanged();
      }
    } catch (reason) { setError(t((reason as Error).message)); }
    finally { setBusy(false); }
  };

  if (!runtime?.supported) return error ? <p className="note err" role="alert">{error}</p> : null;
  return <div className="kemulator-update">
    <div className="btn-row">
      <button className="btn sm" disabled={busy} onClick={() => void run('check')}>{t('Check for updates')}</button>
      {runtime.updated && <button className="btn sm ghost" disabled={busy} onClick={() => void run('restore')}>{t('Restore bundled version')}</button>}
    </div>
    {release && <p><button className="btn primary sm" disabled={busy} onClick={() => void run('install')}>{t('Install KEmulator v{version}', { version: release.version })}</button></p>}
    {busy && <p role="status">{t('Checking or installing KEmulator…')}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p className="note err" role="alert">{error}</p>}
  </div>;
}
