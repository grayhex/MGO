import { useState } from 'react';
import { t } from '../i18n';
import { ACTION_LABEL, type Action } from '../input';
import { K790I_PROFILE_FILE, phoneAction } from '../phoneRemote';
import { Icon } from './Icon';

export function PhoneRemoteSettings() {
  const [lastKey, setLastKey] = useState<Action>();
  return <details className="phone-remote-settings">
    <summary>{t('Bluetooth phone')} · Sony Ericsson K790i</summary>
    <p className="muted small">{t('Pair the phone with this computer and send it the .hid file. On the phone, open Entertainment → Remote Control → MGO-K790i and select this computer.')}</p>
    <div className="btn-row">
      <a className="btn sm" href={K790I_PROFILE_FILE} download><Icon name="download" />{t('Download .hid profile')}</a>
      <button className="btn sm" type="button" onClick={() => setLastKey(undefined)} onKeyDown={event => {
        const action = phoneAction(event);
        if (!action) return;
        event.preventDefault();
        setLastKey(action);
      }}>{t('Test K790i buttons')}</button>
      <span className="small muted" role="status">{lastKey ? t('Received {key}', { key: t(ACTION_LABEL[lastKey]) }) : t('Focus the test button and press a key on the phone.')}</span>
    </div>
  </details>;
}
