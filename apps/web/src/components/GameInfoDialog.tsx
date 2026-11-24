import { t } from '../i18n';
import type { GameInfo, GameMeta, JavaCatalogInfo } from '@mgo/protocol';
import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { useServerSettings } from '../serverSettings';
import { Candidates } from './Moby';
import { ArchiveBrowser, archiveSize } from './ArchiveBrowser';
import { archiveMatchLabel } from './ArchiveSettings';
import { PlatformTag } from './PlatformTag';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { JavaCover } from './JavaCover';

export function GameInfoDialog({ game, toast, onClose, onPlay, playDisabled, onChanged }: {
  game: GameMeta; toast: (k: 'info' | 'error', text: string) => void;
  onClose: () => void; onPlay: (id: string) => void; playDisabled: boolean; onChanged: () => void;
}) {
  const hasKey = useServerSettings()?.secrets.mobygames.configured ?? false;
  const [info, setInfo] = useState<GameInfo | null>(null);
  const java = (game.platform ?? 'j2me') === 'j2me';
  const [catalog, setCatalog] = useState<JavaCatalogInfo | null>(null);
  const [resolution, setResolution] = useState(game.nativeResolution);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogEmpty, setCatalogEmpty] = useState(false);
  const [filename, setFilename] = useState(game.fileName);
  const [checksums, setChecksums] = useState<{ sha1: string; crc32: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [change, setChange] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [broken, setBroken] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void api.gameInfo(game.id).then(result => { if (alive) setInfo(result); }, () => undefined);
    if (java) void api.javaCatalogInfo(game.id).then(result => { if (alive) setCatalog(result.info); }, () => undefined);
    if (!game.fileName) void api.gameMeta(game.id).then(meta => { if (alive) setFilename(meta.fileName); }, () => undefined);
    return () => { alive = false; };
  }, [game.id, game.fileName, game.info?.hasCover, game.info?.screenshots, game.javaCatalog?.screenshots, java]);

  const lookupCatalog = async () => {
    setCatalogBusy(true); setCatalogEmpty(false);
    try {
      const { info: result, resolution: knownResolution } = await api.javaCatalogLookup(game.id);
      if (knownResolution) setResolution(knownResolution);
      if (result) { setCatalog(result); setSelected(null); setBroken([]); onChanged(); }
      else setCatalogEmpty(true);
    } catch (error) { toast('error', t((error as Error).message)); }
    finally { setCatalogBusy(false); }
  };

  const act = async (f: () => Promise<GameInfo>) => {
    setBusy(true);
    try { setInfo(await f()); setSelected(null); setBroken([]); onChanged(); }
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
  const mobyShots = has ? info?.screenshots ?? 0 : 0;
  const shots = [
    ...Array.from({ length: mobyShots }, (_, index) => api.shotUrl(game.id, index + 1)),
    ...Array.from({ length: catalog?.screenshots ?? 0 }, (_, index) => api.javaCatalogShotUrl(game.id, index + 1)),
  ].filter(url => !broken.includes(url));
  const shotIndex = Math.max(0, selected ? shots.indexOf(selected) : 0);
  const visible = shots[shotIndex];
  const stepShot = (step: number) => setSelected(shots[(shotIndex + step + shots.length) % shots.length] ?? null);
  const ngage = game.ngageInfo;
  const played = game.playedResolution;
  const fields: [string, string | undefined][] = [
    ['Name', game.name],
    ['File name', filename],
    ['Size', archiveSize(game.sizeBytes)],
    ['Resolution', resolution ? `${resolution.width}×${resolution.height}` : played ?
      `${played.source === 'saved-profile' ? '≈' : ''}${played.width}×${played.height} · ${t(played.source === 'played' ? 'Emulator output on the last run' : 'Estimated from the saved emulator profile')}` : undefined],
    ['Version', game.version],
    ['Genre', (!game.classification?.unconfirmed && game.classification?.primaryGenre) || ngage?.genre || info?.genres.join(', ') || catalog?.genres.map(t_ => t(t_)).join(', ') || undefined],
    ['Publisher', game.vendor !== 'Unknown' ? game.vendor : ngage?.publisher || info?.publishers.join(', ')],
    ['Released', catalog?.year?.toString() || info?.year?.toString()],
  ];
  return <Modal title={game.name} onClose={onClose} wide className="game-info-dialog">
    <div className="game-info-layout">
      <section className="game-media" aria-label={t('Screenshots')}>
        <div className="game-shot">
          {visible ? <a href={visible} target="_blank" rel="noreferrer"><img src={visible} alt={t('Screenshot {n}', { n: shotIndex + 1 })} onError={() => setBroken(failed => [...failed, visible])} /></a>
            : java ? <JavaCover game={game} hasCover={info?.hasCover ?? game.info?.hasCover} />
            : <img className="game-shot-placeholder" src="/graphics/brand/mark.svg" alt={t('No screenshots yet')} />}
          {shots.length > 1 && <>
            <button type="button" className="game-shot-arrow previous" aria-label={t('Previous screenshot')} onClick={() => stepShot(-1)}><Icon name="back" /></button>
            <button type="button" className="game-shot-arrow next" aria-label={t('Next screenshot')} onClick={() => stepShot(1)}><Icon name="back" /></button>
            <span className="game-shot-count" aria-live="polite" aria-label={t('Screenshot {current} of {total}', { current: shotIndex + 1, total: shots.length })}>{shotIndex + 1} / {shots.length}</span>
          </>}
        </div>
      </section>
      <section className="game-info-fields">
        <PlatformTag platform={game.platform ?? 'j2me'} />
        {game.downloadedFrom && <span className="chip"><Icon name="download" /> {t('Downloaded by MGO · {source}', { source: game.downloadedFrom })}</span>}
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
    {((has && info?.description) || catalog?.description) && <p className="desc">{(has && info?.description) || catalog?.description}</p>}
    {catalog && <p className="attrib small"><a href={catalog.sourceUrl} target="_blank" rel="noreferrer">My Abandonware ↗</a></p>}
    {java && (!catalog || catalog.partial) && <div className="btn-row">
      <button className="btn sm" disabled={catalogBusy} onClick={() => void lookupCatalog()}><Icon name="search" /> {t(catalogBusy ? 'Looking up Java ME metadata…' : catalog?.partial ? 'Retry missing descriptions and screenshots' : 'Find on My Abandonware')}</button>
      {catalogEmpty && <span className="small muted" role="status">{t('No unique Java ME title found.')}</span>}
      {catalog?.partial && <span className="small muted" role="status">{t('Title and genre saved. The game page is temporarily unavailable.')}</span>}
    </div>}
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
      {info && hasKey && (!has || change) && (info.status !== 'none' || change) && <Candidates gameId={game.id} info={info} toast={toast} onChanged={result => { setInfo(result); if (result.status === 'manual') { setChange(false); setSelected(null); setBroken([]); onChanged(); } }} />}
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
