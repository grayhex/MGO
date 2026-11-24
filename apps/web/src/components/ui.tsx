import { t as translateUI } from '../i18n';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

export function Switch({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span>{children}</span>
    </label>
  );
}

export interface SegOption<T extends string> { value: T; label: ReactNode; title?: string; ariaLabel?: string }

/** Radio-group style segmented control. */
export function Seg<T extends string>({ value, options, onChange, label, block, className = '' }: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; label: string; block?: boolean; className?: string }) {
  return (
    <div className={`seg ${block ? 'block' : ''} ${className}`} role="radiogroup" aria-label={translateUI(label)}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} aria-label={o.ariaLabel ? translateUI(o.ariaLabel) : undefined} title={translateUI(o.title)} onClick={() => onChange(o.value)}>{translateUI(o.label)}</button>
      ))}
    </div>
  );
}

export function Panel({ icon, title, children, open = true, right }: { icon: IconName; title: string; children: ReactNode; open?: boolean; right?: ReactNode }) {
  return (
    <details className="panel" open={open}>
      <summary>
        <Icon name={icon} />
        <span>{translateUI(title)}</span>
        {right}
        <Icon name="chevron" className="chev" />
      </summary>
      <div className="panel-body">{children}</div>
    </details>
  );
}

export function Meter({ value, max, hot, label }: { value: number; max: number; hot?: boolean; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return <div className={`meter ${hot ? 'hot' : ''}`} role="meter" aria-label={translateUI(label)} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={max}><span style={{ width: `${pct}%` }} /></div>;
}

export function Spark({ values, max, label }: { values: number[]; max?: number; label: string }) {
  const top = max ?? Math.max(1, ...values);
  return <div className="spark" role="img" aria-label={translateUI(label)}>{values.map((v, i) => <span key={i} style={{ height: `${Math.max(4, (v / top) * 100)}%` }} />)}</div>;
}

/** A keyboard-accessible help bubble that can extend outside a panel. */
export function Hint({ text }: { text: string }) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const delay = useRef<number>();
  const [anchor, setAnchor] = useState<{ left: number; edge: number; below: boolean } | null>(null);
  const hide = () => { window.clearTimeout(delay.current); setAnchor(null); };
  const show = () => {
    window.clearTimeout(delay.current);
    delay.current = window.setTimeout(() => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(240, window.innerWidth - 16);
      const below = rect.top < 128;
      setAnchor({
        left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + (rect.width - width) / 2)),
        edge: below ? rect.bottom + 8 : window.innerHeight - rect.top + 8,
        below,
      });
    }, 150);
  };
  useEffect(() => {
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.clearTimeout(delay.current);
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);
  const shown = translateUI(text);
  return <>
    <span className="hint-mark" ref={trigger} tabIndex={0} role="img" aria-label={shown} aria-describedby={anchor ? id : undefined}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onKeyDown={event => { if (event.key === 'Escape') hide(); }}><Icon name="info" /></span>
    {anchor && createPortal(
      <span className="hint-popover" id={id} role="tooltip" style={{ left: anchor.left, ...(anchor.below ? { top: anchor.edge } : { bottom: anchor.edge }) }}>{shown}</span>,
      document.body
    )}
  </>;
}
