import { useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark';
const key = 'mgo.theme';
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const listeners = new Set<() => void>();

function preference(value: string | null): ThemePreference {
  return value === 'light' ? 'light' : 'dark';
}

function loadPreference(): ThemePreference {
  try { return preference(localStorage.getItem(key)); } catch { return 'dark'; }
}

let selected = loadPreference();
const getPreference = () => selected;

function apply() {
  const theme = selected;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#050507' : '#f4f7f5');
  for (const listener of listeners) listener();
}

export function setTheme(value: ThemePreference) {
  selected = value;
  try { localStorage.setItem(key, value); } catch { /* browser storage is optional */ }
  apply();
}

export const useTheme = () => useSyncExternalStore(subscribe, getPreference);

window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) {
    selected = loadPreference();
    apply();
  }
});
apply();
