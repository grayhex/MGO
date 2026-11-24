import { isGenre, type GameMeta } from '@mgo/protocol';
import { useState } from 'react';
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
  const icon = (game.hasIcon || game.iconPending) && api.iconUrl(game.id);
  const screenshots = [
    ...Array.from({ length: game.info?.screenshots ?? 0 }, (_, i) => api.shotUrl(game.id, i + 1)),
    ...Array.from({ length: game.javaCatalog?.screenshots ?? 0 }, (_, i) => api.javaCatalogShotUrl(game.id, i + 1)),
  ];
  const media = [...screenshots, icon].find((url): url is string => typeof url === 'string' && !broken.includes(url));
  return <span className={`java-cover java-library-thumbnail${compact ? ' compact' : ''}${media === icon ? ' embedded' : ''}`}>
    {media && <img key={media} src={media} alt="" loading="lazy" decoding="async" onError={() => setBroken(previous => [...previous, media])} />}
  </span>;
}
