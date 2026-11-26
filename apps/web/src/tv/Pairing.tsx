import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { TvNotice } from '@mgo/protocol';
import { t } from '../i18n';
import { pairingUrl } from './relay';

export function Pairing({ notice, online, address, send, editAddress }: {
  notice: TvNotice; online: boolean; address: string; send: (message: object) => void; editAddress: () => void;
}) {
  const [expired, setExpired] = useState(false);
  const [qr, setQr] = useState<{ url: string; image: string }>();
  const code = notice.t === 'code' ? notice.code : undefined;
  const expires = notice.t === 'code' ? notice.expires : 0;
  const url = pairingUrl(address, code);
  const base = pairingUrl(address);
  useEffect(() => {
    if (notice.t === 'unpaired' && online) send({ t: 'code' });
  }, [online, notice, send]);
  useEffect(() => {
    setExpired(expires <= Date.now());
    if (expires > Date.now()) {
      const timer = setTimeout(() => setExpired(true), expires - Date.now());
      return () => clearTimeout(timer);
    }
  }, [expires]);
  useEffect(() => {
    if (!url || !code) return;
    let active = true;
    void QRCode.toDataURL(url, { margin: 3, width: 340, errorCorrectionLevel: 'M' }).then(image => {
      if (active) setQr({ url, image });
    }, () => undefined);
    return () => { active = false; };
  }, [url, code]);

  if (!online) return <p role="status">{t('Connecting…')}</p>;
  if (notice.t === 'pending') return <div className="tv-pairing">
    <p>{t('Approve with a TV controller or enter this confirmation number on your phone.')}</p>
    <strong className="tv-code">{notice.check}</strong>
    <div className="tv-actions"><button type="button" onClick={() => send({ t: 'approve', check: notice.check })}>{t('Approve phone')}</button>
      <button type="button" onClick={() => send({ t: 'revoke' })}>{t('Reject')}</button></div>
  </div>;
  if (notice.t === 'paired' || notice.t === 'remote-offline') return <div className="tv-pairing">
    <p role="status">{t(notice.t === 'paired' ? 'Phone connected' : 'Phone disconnected. Waiting for it to reconnect.')}</p>
    <button type="button" onClick={() => send({ t: 'revoke' })}>{t('Unpair phone')}</button>
  </div>;
  return <div className="tv-pairing">
    {!base && <p className="note warn">{t('Open TV Mode using the server’s LAN address or set a reachable address below. The phone cannot open a localhost address.')}</p>}
    {base && <p>{t('Connect the phone to the same network. Open this address or scan the QR code. Trust the server’s HTTPS certificate on the phone.')}</p>}
    {base && <div className="tv-pair-code">
      {!expired && qr && qr.url === url && <img src={qr.image} alt={t('Pairing QR code')} />}
      <div>{code && !expired ? <strong className="tv-code" data-testid="pairing-code">{code}</strong> : <p>{t('Pairing code expired')}</p>}<p className="tv-address">{base}</p></div>
    </div>}
    <div className="tv-actions">
      <button type="button" onClick={() => send({ t: 'code' })}>{t('New pairing code')}</button>
      <button type="button" onClick={editAddress}>{t('Set LAN address')}</button>
    </div>
  </div>;
}
