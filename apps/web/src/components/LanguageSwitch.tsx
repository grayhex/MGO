import { setLocale, useLocale } from '../i18n';
import { Seg } from './ui';

const languages = [{ value: 'en', label: 'EN', title: 'English' }, { value: 'ru', label: 'RU', title: 'Русский' }] as const;

export function LanguageSwitch({ onShell = false }: { onShell?: boolean }) {
  const locale = useLocale();
  return <Seg<'en' | 'ru'> className={onShell ? 'on-shell lang' : 'lang'} label="Language / Язык" value={locale} onChange={setLocale} options={[...languages]} />;
}
