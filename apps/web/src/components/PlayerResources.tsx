import { useEffect, useState } from 'react';
import type { SystemResources } from '@mgo/protocol';
import { api } from '../api';
import { t } from '../i18n';
import { ThemeToggle } from './ThemeToggle';
import { LanguageSwitch } from './LanguageSwitch';

const resourceBytes = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(2)}\u00a0${t('GB')}` : `${Math.round(n / 1048576)}\u00a0${t('MB')}`;

export function PlayerResources() {
  const [usage, setUsage] = useState<SystemResources | null>(null);
  useEffect(() => {
    let disposed = false, loading = false;
    let timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      if (document.hidden || loading) return;
      loading = true;
      try {
        const value = await api.systemResources();
        if (!disposed) setUsage(value);
      } catch {
        if (!disposed) setUsage(null);
      } finally {
        loading = false;
        if (!disposed) timer = setTimeout(sample, 5000);
      }
    };
    const onVisibility = () => { clearTimeout(timer); void sample(); };
    document.addEventListener('visibilitychange', onVisibility);
    void sample();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  return <section className="player-resources" aria-label={t('MGO resource usage')}>
    <div className="resource-meters">
      <div><span>CPU</span><b>{usage?.cpuPercent == null ? '—' : `${usage.cpuPercent.toFixed(1)}%`}</b>
        <progress aria-label="CPU" max={100} value={usage?.cpuPercent ?? 0} />
      </div>
      <div title={usage ? t('Memory limit: {limit}', { limit: resourceBytes(usage.memoryLimitBytes) }) : undefined}>
        <span>{t('Memory')}</span><b>{usage ? resourceBytes(usage.memoryBytes) : '—'}</b>
        <progress aria-label={t('Memory')} max={usage?.memoryLimitBytes || 1} value={usage?.memoryBytes ?? 0} />
      </div>
    </div>
    <div className="player-preferences"><ThemeToggle /><LanguageSwitch /></div>
  </section>;
}
