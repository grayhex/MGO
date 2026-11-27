import type { TvKey } from './Input';

const SELECTOR = 'button:not(:disabled),a[href],summary,select:not(:disabled),input:not([type=hidden]):not(:disabled),textarea:not(:disabled),[data-tv-focus]';
export function tvTargets(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter(el =>
    !el.closest('[inert],[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
}

export function focusTv(el?: HTMLElement | null): void {
  el?.focus({ preventScroll: true });
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function moveTvFocus(root: HTMLElement, key: TvKey): void {
  const list = tvTargets(root);
  const current = document.activeElement;
  if (!(current instanceof HTMLElement) || !list.includes(current)) { focusTv(list[0]); return; }
  if (key === 'fire') {
    if (current instanceof HTMLSelectElement) {
      return;
    }
    current.click();
    return;
  }
  const horizontal = key === 'left' || key === 'right';
  if (!horizontal && key !== 'up' && key !== 'down') return;
  const sign = key === 'right' || key === 'down' ? 1 : -1;
  if (!horizontal && current.hasAttribute('data-tv-focus')) {
    const end = current.scrollHeight - current.clientHeight;
    if (sign < 0 ? current.scrollTop > 1 : current.scrollTop < end - 1) {
      current.scrollBy(0, sign * current.clientHeight * .8);
      return;
    }
  }
  if (horizontal && current instanceof HTMLSelectElement) {
    const next = Math.max(0, Math.min(current.options.length - 1, current.selectedIndex + sign));
    if (next !== current.selectedIndex && !current.options[next]?.disabled) {
      current.selectedIndex = next;
      current.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }
  if (horizontal && current instanceof HTMLInputElement && current.type === 'range') {
    if (sign > 0) current.stepUp(); else current.stepDown();
    current.dispatchEvent(new Event('input', { bubbles: true }));
    current.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const from = current.getBoundingClientRect();
  const center = (r: DOMRect) => [r.x + r.width / 2, r.y + r.height / 2] as const;
  const [fx, fy] = center(from);
  let best: HTMLElement | undefined;
  let distance = Infinity;
  const row = horizontal && current.closest('[data-tv-row]');
  for (const target of list) {
    if (target === current || (row && !row.contains(target))) continue;
    const rect = target.getBoundingClientRect();
    const [x, y] = center(rect);
    const primary = (horizontal ? x - fx : y - fy) * sign;
    const secondary = Math.abs(horizontal ? y - fy : x - fx);
    const cross = horizontal
      ? Math.max(0, from.top - rect.bottom, rect.top - from.bottom)
      : Math.max(0, from.left - rect.right, rect.left - from.right);
    if (primary <= 2) continue;
    const score = primary + 0.45 * secondary + 3 * cross;
    if (score < distance) { distance = score; best = target; }
  }
  focusTv(best);
}
