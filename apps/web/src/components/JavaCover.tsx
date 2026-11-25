import { isGenre, type GameMeta } from '@mgo/protocol';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';

export function JavaCover({ game, hasCover = game.info?.hasCover }: {
  game: GameMeta;
  hasCover?: boolean | undefined;
}) {
  const [broken, setBroken] = useState<string[]>([]);
  const classification = game.classification;
  const genre = classification && !classification.unconfirmed ? classification.primaryGenre
    : [...(game.javaCatalog?.genres ?? []), ...(game.info?.genres ?? [])].find(isGenre);
  const label = t(genre ?? 'Unknown genre');
  const media = hasCover && !broken.includes(api.coverUrl(game.id)) ? api.coverUrl(game.id) : null;

  if (media) return <span className="java-cover java-cover-media">
    <img src={media} alt={t('Game cover')} loading="lazy" onError={() => setBroken(previous => [...previous, media])} />
  </span>;

  return <span className="java-cover java-cover-fallback" data-genre={genre ?? 'unknown'}>
    <span className="java-cover-genre">{label}</span>
  </span>;
}

export function JavaLibraryThumbnail({ game, compact }: { game: GameMeta; compact: boolean }) {
  const [broken, setBroken] = useState<string[]>([]);
  const [loadedShot, setLoadedShot] = useState<string | null>(null);
  const [catalogReady, setCatalogReady] = useState(false);
  const [nearViewport, setNearViewport] = useState(false);
  const frame = useRef<HTMLSpanElement>(null);
  const icon = (game.hasIcon || game.iconPending) && api.iconUrl(game.id);
  const localShot = Array.from({ length: game.info?.screenshots ?? 0 }, (_, i) => api.shotUrl(game.id, i + 1))
    .find(url => !broken.includes(url));
  const catalogUrl = game.javaCatalog?.screenshots ? api.javaCatalogThumbnailUrl(game.id) : null;
  const watchCatalog = !!catalogUrl && !catalogReady && !localShot;
  useEffect(() => {
    if (!watchCatalog || !frame.current) return;
    const observer = new IntersectionObserver(([entry]) => setNearViewport(!!entry?.isIntersecting), { rootMargin: '120px' });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [watchCatalog]);
  useEffect(() => {
    if (!watchCatalog || !nearViewport || !catalogUrl) return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const check = async () => {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
      const response = await fetch(catalogUrl, { method: 'HEAD', signal, cache: 'no-store' }).catch(() => null);
      if (request.signal.aborted) return;
      if (response?.status === 200) setCatalogReady(true);
      else if ((!response || response.status === 202) && ++attempts < 20) timer = setTimeout(check, 3500);
    };
    void check();
    return () => { request.abort(); clearTimeout(timer); };
  }, [watchCatalog, nearViewport, catalogUrl]);
  const shot = localShot ?? (catalogReady && catalogUrl && !broken.includes(catalogUrl) ? catalogUrl : undefined);
  const showShot = !!shot && loadedShot === shot;
  const failed = (url: string) => setBroken(previous => [...previous, url]);
  return <span ref={frame} className={`java-cover java-library-thumbnail${compact ? ' compact' : ''}`}>
    {icon && !broken.includes(icon) && <img className="embedded" hidden={showShot} src={icon} alt="" loading="lazy" decoding="async" onError={() => failed(icon)} />}
    {shot && <img className="thumbnail-shot" data-ready={showShot} key={shot} src={shot} alt="" loading="lazy" decoding="async"
      onLoad={() => setLoadedShot(shot)} onError={() => failed(shot)} />}
  </span>;
}
