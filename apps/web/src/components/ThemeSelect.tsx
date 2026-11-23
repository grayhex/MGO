import { t } from '../i18n';
import { setTheme, useThemePreference, type ThemePreference } from '../theme';
import { Icon } from './Icon';

export function ThemeSelect() {
  const theme = useThemePreference();
  return <label className="theme-select">
    <Icon name={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'device'} />
    <select value={theme} aria-label={t('Theme')} onChange={event => setTheme(event.target.value as ThemePreference)}>
      <option value="system">{t('System theme')}</option>
      <option value="light">{t('Light theme')}</option>
      <option value="dark">{t('Dark theme')}</option>
    </select>
  </label>;
}
