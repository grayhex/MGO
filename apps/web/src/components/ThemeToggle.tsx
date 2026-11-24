import { t } from '../i18n';
import { setTheme, useTheme } from '../theme';
import { Icon } from './Icon';

export function ThemeToggle() {
  const dark = useTheme() === 'dark';
  const label = t(dark ? 'Use light theme' : 'Use dark theme');
  return <button className="btn sm icon theme-toggle" type="button" aria-label={label} title={label}
    onClick={() => setTheme(dark ? 'light' : 'dark')}><Icon name={dark ? 'sun' : 'moon'} /></button>;
}
