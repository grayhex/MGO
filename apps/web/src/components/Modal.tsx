import { t as translateUI } from '../i18n';
import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({ title, onClose, children, wide, className = '' }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const element = ref.current;
    const tvBack = () => close.current();
    element?.addEventListener('mgo:tv-back', tvBack);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    window.addEventListener('keydown', k, true);
    return () => { element?.removeEventListener('mgo:tv-back', tvBack); window.removeEventListener('keydown', k, true); prev?.focus?.(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={translateUI(title)} tabIndex={-1} ref={ref}>
        <h2>{translateUI(title)}</h2>
        {children}
      </div>
    </div>
  );
}
