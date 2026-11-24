import { isGenre, type GameMeta } from '@mgo/protocol';
import { useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';

export function JavaCover({ game, compact = false, coverOnly = false, hasCover = game.info?.hasCover }: {
  game: GameMeta;
  compact?: boolean;
  coverOnly?: boolean;
  hasCover?: boolean | undefined;
}) {
  const [broken, setBroken] = useState<string[]>([]);
  const classification = game.classification;
  const genre = classification && !classification.unconfirmed ? classification.primaryGenre
    : [...(game.javaCatalog?.genres ?? []), ...(game.info?.genres ?? [])].find(isGenre);
  const label = t(genre ?? 'Unknown genre');
  const media = [
    hasCover && api.coverUrl(game.id),
    !coverOnly && !!game.info?.screenshots && api.shotUrl(game.id, 1),
    !coverOnly && !!game.javaCatalog?.screenshots && api.javaCatalogShotUrl(game.id, 1),
    compact && game.hasIcon && api.iconUrl(game.id),
  ].find((url): url is string => typeof url === 'string' && !broken.includes(url));

  if (media) return <span className={`java-cover java-cover-media${compact ? ' compact' : ''}`}>
    <img src={media} alt={coverOnly ? t('Game cover') : ''} loading="lazy" onError={() => setBroken(previous => [...previous, media])} />
  </span>;

  return <span className={`java-cover java-cover-fallback${compact ? ' compact' : ''}`} data-genre={genre ?? 'unknown'}>
    {!compact && <span className="java-cover-genre">{label}</span>}
  </span>;
}
