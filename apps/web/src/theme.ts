import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const key = 'mgo.theme';
const system = window.matchMedia('(prefers-color-scheme: dark)');
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const listeners = new Set<() => void>();

function preference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function loadPreference(): ThemePreference {
  try { return preference(localStorage.getItem(key)); } catch { return 'system'; }
}

let selected = loadPreference();
const getPreference = () => selected;
const getTheme = () => selected === 'system' ? system.matches ? 'dark' : 'light' : selected;

function apply() {
  const theme = getTheme();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f172a' : '#f8fafc');
  for (const listener of listeners) listener();
}

export function setTheme(value: ThemePreference) {
  selected = value;
  try { localStorage.setItem(key, value); } catch { /* browser storage is optional */ }
  apply();
}

export const useThemePreference = () => useSyncExternalStore(subscribe, getPreference);
export const useTheme = () => useSyncExternalStore(subscribe, getTheme);

system.addEventListener('change', apply);
window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) {
    selected = loadPreference();
    apply();
  }
});
apply();
