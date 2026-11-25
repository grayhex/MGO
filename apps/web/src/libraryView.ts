import { GENRES, type GameMeta } from '@mgo/protocol';

/** A group contains all versions of a title. Resolution filters select matching versions within it. */
export type SortKey = 'name' | 'name-desc' | 'added' | 'played' | 'time' | 'genre';

export const SORT_KEYS: SortKey[] = ['name', 'name-desc', 'added', 'played', 'time', 'genre'];

export const resolutionKey = (size: { width: number; height: number }) => `${size.width}×${size.height}`;

export function matchesResolution(game: GameMeta, filter: string): boolean {
  const size = game.nativeResolution;
  return filter === 'all' || (size ? resolutionKey(size) === filter : filter === 'unknown');
}

export const totalPlaySeconds = (vs: GameMeta[]): number => vs.reduce((n, v) => n + (v.playSeconds ?? 0), 0);
const lastPlayed = (vs: GameMeta[]): string => vs.reduce((m, v) => (v.lastPlayedAt && v.lastPlayedAt > m ? v.lastPlayedAt : m), '');
const addedAt = (vs: GameMeta[]): string => vs.reduce((m, v) => (v.createdAt > m ? v.createdAt : m), '');
const genreRank = (vs: GameMeta[]): number => {
  const g = vs[0]?.classification?.primaryGenre;
  const i = g ? GENRES.indexOf(g) : -1;
  return i < 0 ? GENRES.length : i;
};

const byName = (a: GameMeta[], b: GameMeta[]) => (a[0]?.name ?? '').localeCompare(b[0]?.name ?? '', undefined, { sensitivity: 'base', numeric: true });

export function compareGroups(a: GameMeta[], b: GameMeta[], key: SortKey): number {
  switch (key) {
    case 'name': return byName(a, b);
    case 'name-desc': return byName(b, a);
    case 'added': return addedAt(b).localeCompare(addedAt(a)) || byName(a, b);
    case 'played': return lastPlayed(b).localeCompare(lastPlayed(a)) || byName(a, b);
    case 'time': return totalPlaySeconds(b) - totalPlaySeconds(a) || byName(a, b);
    case 'genre': return genreRank(a) - genreRank(b) || byName(a, b);
  }
}
