import { useState } from 'react';
import { t } from '../i18n';
import { ACTION_LABEL, type Action } from '../input';
import { PHONE_REMOTE_PROFILES, phoneAction } from '../phoneRemote';
import { Icon } from './Icon';

export function PhoneRemoteSettings() {
  const [lastKey, setLastKey] = useState<Action>();
  return <details className="phone-remote-settings">
    <summary>{t('Bluetooth phone')} · Sony Ericsson</summary>
    <p className="muted small">{t('After pairing in your computer’s Bluetooth settings, download the profile for your model and send the file to the phone. On the phone, open Entertainment → Remote Control and select the MGO profile and this computer.')}</p>
    <p className="muted small">{t('Replace the old MGO profile on the phone to update the joystick keys.')}</p>
    <div className="btn-row">
      {PHONE_REMOTE_PROFILES.map(({ model, name, url }) => (
        <a key={model} className="btn sm" href={url} download={`${name}.hid`} aria-label={t('Download {model} .hid profile', { model })}>
          <Icon name="download" />{model} <span className="muted">.hid</span>
        </a>
      ))}
    </div>
    <div className="btn-row">
      <button className="btn sm" type="button" onClick={() => setLastKey(undefined)} onKeyDown={event => {
        const action = phoneAction(event);
        if (!action) return;
        event.preventDefault();
        setLastKey(action);
      }}>{t('Test phone buttons')}</button>
      <span className="small muted" role="status">{lastKey ? t('Received {key}', { key: t(ACTION_LABEL[lastKey]) }) : t('Focus the test button and press a key on the phone.')}</span>
    </div>
  </details>;
}
