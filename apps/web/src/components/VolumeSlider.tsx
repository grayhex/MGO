import { t } from '../i18n';

export function VolumeSlider({ value, onChange, label = t('Volume') }: {
  value: number;
  onChange: (value: number) => void;
  label?: string;
}) {
  return <label className="volume-slider">
    <span className="volume-heading"><span>{label}</span><b>{value}%</b></span>
    <input type="range" min={0} max={100} value={value} onChange={event => onChange(Number(event.currentTarget.value))}
      aria-label={t('Volume')} aria-valuetext={`${value}%`} />
    <span className="volume-ticks" aria-hidden="true">
      {[0, 25, 50, 75, 100].map(mark => <span key={mark}>{mark}%</span>)}
    </span>
  </label>;
}
