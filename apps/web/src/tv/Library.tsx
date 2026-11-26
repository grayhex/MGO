import { useState } from 'react';
import { GAME_PLATFORM_LABELS, type GameMeta, type GamePlatform } from '@mgo/protocol';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { t } from '../i18n';

export type TvFilter = 'all' | 'recent' | 'favorites' | GamePlatform;
export const tvPlatform = (game: GameMeta) => game.platform ?? 'j2me';

export function tvLibrary(games: GameMeta[], filter: TvFilter, query: string) {
  const term = query.trim().toLocaleLowerCase();
  const eligible = games.filter(game => !game.sourceMissing && (
    filter === 'all' || (filter === 'recent' && game.lastPlayedAt !== null) || (filter === 'favorites' && game.favorite) || filter === tvPlatform(game)
  ) && (!term || (game.name + ' ' + game.vendor).toLocaleLowerCase().includes(term)));
  eligible.sort((a, b) => filter === 'recent' ? (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? '') : a.name.localeCompare(b.name));
  const groups = new Map<string, GameMeta[]>();
  for (const game of eligible) {
    const key = `${tvPlatform(game)}:${game.groupKey || game.id}`;
    const variants = groups.get(key);
    if (variants) variants.push(game);
    else groups.set(key, [game]);
  }
  return Array.from(groups, ([id, builds]) => ({ id, builds, game: builds[0]! }));
}

export function GameArtwork({ game, picture = 0 }: { game: GameMeta; picture?: number }) {
  const sources = [
    picture > 0 ? api.shotUrl(game.id, picture - 1) : null,
    game.info?.hasCover || game.ngageInfo?.hasCover ? api.coverUrl(game.id) : null,
    game.info?.screenshots || game.javaCatalog?.screenshots ? api.shotUrl(game.id, 0) : null,
    game.hasIcon || game.iconPending ? api.iconUrl(game.id) : null,
  ].filter((url): url is string => !!url);
  return <Artwork key={sources.join('|')} sources={sources} />;
}
function Artwork({ sources }: { sources: string[] }) {
  const [index, setIndex] = useState(0);
  const source = sources[index];
  return <div className={`tv-art ${source?.includes('/icon') ? 'tv-icon-art' : ''}`}>
    {source ? <img src={source} alt="" loading="lazy" onError={() => setIndex(index + 1)} /> : <img src="/graphics/brand/mark.svg" alt="" className="tv-placeholder" />}
  </div>;
}

export function TvGameTile({ group, onOpen }: { group: ReturnType<typeof tvLibrary>[number]; onOpen: () => void }) {
  const { game, builds, id } = group;
  return <button type="button" className="tv-game-tile" data-tv-game={id} onClick={onOpen}>
    <GameArtwork game={game} />
    <div className="tv-game-caption">
      <small>{GAME_PLATFORM_LABELS[tvPlatform(game)]}{game.favorite ? ' · ★' : ''}</small>
      <strong>{game.name}</strong>
      {builds.length > 1 && <small>{t('{count} builds', { count: builds.length })}</small>}
    </div>
  </button>;
}

export function TvFilters({ selected, onSelect }: { selected: TvFilter; onSelect: (filter: TvFilter) => void }) {
  return <nav className="tv-filters" aria-label={t('Filter games')}>
    {([['all', 'All'], ['recent', 'Recently played'], ['favorites', 'Favorites'],
      ['j2me', GAME_PLATFORM_LABELS.j2me], ['ngage', GAME_PLATFORM_LABELS.ngage], ['ngage2', GAME_PLATFORM_LABELS.ngage2],
      ['symbian', GAME_PLATFORM_LABELS.symbian]] as const).map(([id, label]) =>
      <button type="button" key={id} aria-pressed={id === selected} onClick={() => onSelect(id)}>{id === 'favorites' && <Icon name="star" />}{t(label)}</button>)}
  </nav>;
}
