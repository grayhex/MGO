import { useState } from 'react';
import { t } from '../i18n';
import { ACTION_LABEL, type Action } from '../input';
import { PHONE_REMOTE_PROFILES, isPhoneIndicatorKey, phoneTestAction, rememberSonyPhone } from '../phoneRemote';
import { Icon } from './Icon';

export function PhoneRemoteSettings() {
  const [lastKey, setLastKey] = useState<Action | 'phone'>();
  return <details className="phone-remote-settings">
    <summary>{t('Bluetooth phone')} · Sony Ericsson</summary>
    <p className="muted small">{t('After pairing in your computer’s Bluetooth settings, download the profile for your model and send the file to the phone. On the phone, open Entertainment → Remote Control and select the MGO profile and this computer.')}</p>
    <p className="muted small">{t('Select the profile ending in A2. Press volume up on the phone to show its indicator in Controls.')}</p>
    <div className="btn-row">
      {PHONE_REMOTE_PROFILES.map(({ model, name, url }) => (
        <a key={model} className="btn sm" href={url} download={`${name}.hid`} aria-label={t('Download {model} .hid profile', { model })}>
          <Icon name="download" />{model} <span className="muted">.hid</span>
        </a>
      ))}
    </div>
    <div className="btn-row">
      <button className="btn sm" type="button" onClick={() => setLastKey(undefined)} onKeyDown={event => {
        const identified = isPhoneIndicatorKey(event);
        const action = identified ? 'phone' : phoneTestAction(event);
        if (!action) return;
        event.preventDefault();
        if (identified) rememberSonyPhone();
        setLastKey(action);
      }}>{t('Test phone buttons')}</button>
      <span className="small muted" role="status">{lastKey === 'phone' ? t('Sony Ericsson HID input detected')
        : lastKey ? t('Received {key}', { key: t(ACTION_LABEL[lastKey]) }) : t('Focus the test button and press a key on the phone.')}</span>
    </div>
  </details>;
}
