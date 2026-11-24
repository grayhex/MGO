import { t } from '../i18n';
import type { GameInfo, GameMeta } from '@mgo/protocol';
import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { useServerSettings } from '../serverSettings';
import { Candidates } from './Moby';
import { ArchiveBrowser, archiveSize } from './ArchiveBrowser';
import { archiveMatchLabel } from './ArchiveSettings';
import { PlatformTag } from './PlatformTag';
import { Icon } from './Icon';
import { Modal } from './Modal';

export function GameInfoDialog({ game, toast, onClose, onPlay, playDisabled, onChanged }: {
  game: GameMeta; toast: (k: 'info' | 'error', text: string) => void;
  onClose: () => void; onPlay: (id: string) => void; playDisabled: boolean; onChanged: () => void;
}) {
  const hasKey = useServerSettings()?.secrets.mobygames.configured ?? false;
  const [info, setInfo] = useState<GameInfo | null>(null);
  const [filename, setFilename] = useState(game.fileName);
  const [checksums, setChecksums] = useState<{ sha1: string; crc32: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [change, setChange] = useState(false);
  const [selected, setSelected] = useState(0);
  const [broken, setBroken] = useState<number[]>([]);
  useEffect(() => {
    let alive = true;
    void api.gameInfo(game.id).then(result => { if (alive) setInfo(result); }, () => undefined);
    if (!game.fileName) void api.gameMeta(game.id).then(meta => { if (alive) setFilename(meta.fileName); }, () => undefined);
    return () => { alive = false; };
  }, [game.id, game.fileName]);

  const act = async (f: () => Promise<GameInfo>) => {
    setBusy(true);
    try { setInfo(await f()); setSelected(0); setBroken([]); onChanged(); }
    catch (e) { toast('error', (e as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async (hash: string) => {
    try { await navigator.clipboard.writeText(hash); toast('info', t('Checksum copied')); }
    catch (e) { toast('error', (e as Error).message); }
  };
  const archive = game.archiveMatch;
  if (showArchive && archive?.build) return <ArchiveBrowser initialSha={archive.build.sha256} onClose={() => setShowArchive(false)} onImported={onChanged} onPlay={onPlay} />;

  const has = info?.status === 'matched' || info?.status === 'manual';
  const shots = Array.from({ length: has ? info?.screenshots ?? 0 : 0 }, (_, index) => index + 1).filter(index => !broken.includes(index));
  const visible = shots.includes(selected) ? selected : shots[0];
  const ngage = game.ngageInfo;
  const fields: [string, string | undefined][] = [
    ['Name', game.name],
    ['File name', filename],
    ['Size', archiveSize(game.sizeBytes)],
    ['Resolution', game.nativeResolution ? `${game.nativeResolution.width}×${game.nativeResolution.height}` : undefined],
    ['Version', game.version],
    ['Genre', game.classification?.unconfirmed ? ngage?.genre || info?.genres.join(', ') : game.classification?.primaryGenre || ngage?.genre || info?.genres.join(', ')],
    ['Publisher', game.vendor !== 'Unknown' ? game.vendor : ngage?.publisher || info?.publishers.join(', ')],
  ];
  return <Modal title={game.name} onClose={onClose} wide className="game-info-dialog">
    <div className="game-info-layout">
      <section className="game-media" aria-label={t('Screenshots')}>
        <div className="game-shot">
          {visible ? <a href={api.shotUrl(game.id, visible)} target="_blank" rel="noreferrer"><img src={api.shotUrl(game.id, visible)} alt={t('Screenshot {n}', { n: visible })} onError={() => setBroken(failed => [...failed, visible])} /></a>
            : <img className="game-shot-placeholder" src="/graphics/brand/mark.svg" alt={t('No screenshots yet')} />}
        </div>
        {shots.length > 1 && <div className="game-shot-strip">{shots.map(index => <button type="button" key={index} aria-label={t('Screenshot {n}', { n: index })} aria-pressed={visible === index} onClick={() => setSelected(index)}>
          <img src={api.shotUrl(game.id, index)} alt="" loading="lazy" onError={() => setBroken(failed => [...failed, index])} />
        </button>)}</div>}
      </section>
      <section className="game-info-fields">
        <PlatformTag platform={game.platform ?? 'j2me'} />
        <dl className="game-facts">{fields.map(([name, value]) => <Fragment key={name}><dt>{t(name)}</dt><dd>{value || '—'}</dd></Fragment>)}</dl>
        <details className="more game-checksums" onToggle={event => {
          if (event.currentTarget.open && !checksums) void api.gameChecksums(game.id).then(setChecksums, () => undefined);
        }}>
          <summary>{t('File checksums')}</summary>
          {(Object.entries({ 'SHA-256': game.sha256, 'SHA-1': checksums?.sha1, CRC32: checksums?.crc32 })).map(([label, value]) => <div className="checksum" key={label}>
            <span>{label}</span><code>{value || '—'}</code><button className="btn sm icon" type="button" disabled={!value} aria-label={t('Copy {hash}', { hash: label })} onClick={() => { if (value) void copy(value); }}><Icon name="copy" /></button>
          </div>)}
        </details>
      </section>
    </div>
    {has && info?.description && <p className="desc">{info.description}</p>}
    {(ngage || archive || has || hasKey) && <details className="more game-info-sources">
      <summary>{t('Metadata sources')}</summary>
      {ngage && <div className="stack">
        <dl className="facts">{Object.entries({ Developer: ngage.developer, Released: ngage.released ?? ngage.year, Multiplayer: ngage.multiplayer, 'Product code': ngage.productCode }).map(([label, value]) => value && <Fragment key={label}><dt>{t(label)}</dt><dd>{value}</dd></Fragment>)}</dl>
        <div className="btn-row"><a href={ngage.sourceUrl} target="_blank" rel="noreferrer">{ngage.attribution} ↗</a>{ngage.coverSourceUrl && <a href={ngage.coverSourceUrl} target="_blank" rel="noreferrer">LaunchBox ↗</a>}</div>
      </div>}
      {archive && <div className="btn-row">
        <a href={archive.sourceUrl} target="_blank" rel="noreferrer">J2ME Archive ↗</a><span className="badge plain">{t(archiveMatchLabel[archive.state])}</span>
        {archive.build && <button className="btn sm" onClick={() => setShowArchive(true)}>{t('Possible alternate builds')}</button>}
      </div>}
      {has && info && <p className="attrib small">{info.attribution} {info.mobyUrl && <a href={info.mobyUrl} target="_blank" rel="noreferrer">MobyGames ↗</a>}</p>}
      {info && hasKey && (!has || change) && (info.status !== 'none' || change) && <Candidates gameId={game.id} info={info} toast={toast} onChanged={result => { setInfo(result); if (result.status === 'manual') { setChange(false); setSelected(0); setBroken([]); onChanged(); } }} />}
      {info?.error && <p className="note warn">{info.error}</p>}
      {hasKey && <div className="btn-row">
        <button className="btn sm" disabled={busy} onClick={() => void act(() => api.infoRefresh(game.id))}>{t(has ? 'Look up again' : 'Look up now')}</button>
        {has && <button className="btn sm" disabled={busy} onClick={() => setChange(value => !value)}>{t('Wrong game?')}</button>}
        {has && <button className="btn sm ghost" disabled={busy} onClick={() => void act(() => api.infoUnlink(game.id))}>{t('Remove information')}</button>}
      </div>}
    </details>}
    <div className="modal-actions">
      <span className="spacer" />
      <button className="btn" onClick={onClose}>{t('Close')}</button>
      <button className="btn primary" onClick={() => onPlay(game.id)} disabled={playDisabled}><Icon name="play" /> {t('Play')}</button>
    </div>
  </Modal>;
}
