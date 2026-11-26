import { useState } from 'react';
import { t } from '../i18n';

export function TvKeyboard({ value, onChange, onDone, label, secret = false }: {
  value: string; onChange: (value: string) => void; onDone: () => void; label: string; secret?: boolean;
}) {
  const [cyrillic, setCyrillic] = useState(false);
  const [uppercase, setUppercase] = useState(false);
  const alphabet = cyrillic ? 'йцукенгшщзхъфывапролджэячсмитьбюё' : 'qwertyuiopasdfghjklzxcvbnm';
  const append = (letter: string) => onChange((value + letter).slice(0, 200));
  return <div className="tv-keyboard">
    <div className="tv-typed" aria-label={label} role="status">{(secret ? '•'.repeat(value.length) : value) || label}</div>
    <div className="tv-letters">{Array.from('1234567890' + alphabet + '.:/-_@?').map(letter => {
      const character = uppercase ? letter.toUpperCase() : letter;
      return <button type="button" key={letter} onClick={() => append(character)}>{character}</button>;
    })}</div>
    <div className="tv-actions">
      <button type="button" onClick={() => setCyrillic(!cyrillic)}>{cyrillic ? 'ABC' : 'АБВ'}</button>
      <button type="button" aria-pressed={uppercase} onClick={() => setUppercase(!uppercase)}>{t('Uppercase')}</button>
      <button type="button" onClick={() => append(' ')}>{t('Space')}</button>
      <button type="button" onClick={() => onChange(value.slice(0, -1))}>{t('Backspace')}</button>
      <button type="button" onClick={onDone}>{t('Done')}</button>
    </div>
  </div>;
}
