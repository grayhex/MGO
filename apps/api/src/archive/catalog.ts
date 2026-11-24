import type { ArchiveBuild, GameMeta, JavaCatalogInfo, JavaCatalogJob } from '@mgo/protocol';
import type { StatementSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Library } from '../library.js';
import { UploadError } from '../jar.js';
import { readScreenHints } from '../analysis/screenHints.js';
import { sniffImage } from '../mobygames.js';
import { archiveTitleKey as key, MIB } from './index.js';
import { readRemote } from './remote.js';

const bibliographicIndex = new URL('https://raw.githubusercontent.com/wakkatobakka/j2me-archive/main/data/catalog.json');
const origin = 'https://www.myabandonware.com';
const safeScreenshot = (src: unknown): src is string => typeof src === 'string' &&
  /^\/media\/screenshots\/(?:[a-z0-9_-]+\/)+[a-z0-9_.-]+\.(?:png|jpe?g|webp|gif)$/i.test(src);
type Listing = { id: string; title: string; aliases: string[]; genres: string[]; listed_year: string };
type Stored = Omit<JavaCatalogInfo, 'screenshots'> & { images: string[] };

export function parseJavaCatalogPage(html: string) {
  let images: string[] = [];
  const gallery = /const platformGalleries\s*=\s*(\{[^\r\n]*?\});/.exec(html)?.[1];
  if (gallery) {
    try {
      const items: unknown = JSON.parse(gallery)?.J2ME?.items;
      if (Array.isArray(items)) images = [...new Set(items.map(item => item?.src).filter(safeScreenshot))].slice(0, 8);
    } catch { /* some listings have no Java ME gallery */ }
  }
  const meta = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1] ?? '';
  const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", '#039': "'", '#39': "'", lt: '<', gt: '>', nbsp: ' ' };
  const description = /\bJ2ME\b/i.test(meta) ? meta.replace(/&([#a-z0-9]+);/gi, (whole, entity: string) => entities[entity] ?? whole).slice(0, 600) : '';
  return { images, description };
}

export class JavaCatalog {
  private index?: { until: number; entries: Promise<Map<string, Listing[]>> };
  private job: JavaCatalogJob | null = null;
  private active?: Promise<void>;
  private shutdown = new AbortController();
  private getInfo: StatementSync;

  constructor(private library: Library, private exactBuild: (sha: string) => ArchiveBuild | null, private fetcher: typeof fetch = fetch) {
    library.db.exec('CREATE TABLE IF NOT EXISTS java_catalog (group_key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    this.getInfo = library.db.prepare('SELECT payload FROM java_catalog WHERE group_key=?');
  }

  private catalog() {
    if (this.index && this.index.until > Date.now()) return this.index.entries;
    const entries = this.fetchCatalog().catch(error => { this.index = undefined; throw error; });
    this.index = { until: Date.now() + 24 * 60 * 60_000, entries };
    return entries;
  }

  private async fetchCatalog() {
    const { bytes } = await readRemote(this.fetcher, bibliographicIndex, url => url.href === bibliographicIndex.href, 2 * MIB, this.signal());
    const entries: unknown = JSON.parse(bytes.toString('utf8'))?.entries;
    if (!Array.isArray(entries)) throw new Error('Invalid Java ME metadata index');
    const index = new Map<string, Listing[]>();
    for (const entry of entries) {
      if (typeof entry?.id !== 'string' || !/^ma:[a-z0-9]+(?:-[a-z0-9]+)+$/.test(entry.id) || typeof entry.title !== 'string') continue;
      const row: Listing = {
        id: entry.id, title: entry.title,
        aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((value: unknown) => typeof value === 'string') : [],
        genres: Array.isArray(entry.genres) ? entry.genres.filter((value: unknown) => typeof value === 'string') : [],
        listed_year: String(entry.listed_year ?? ''),
      };
      for (const name of new Set([row.title, ...row.aliases].map(key))) {
        if (!name) continue;
        const list = index.get(name) ?? [];
        list.push(row);
        index.set(name, list);
      }
    }
    return index;
  }

  private signal() { return AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10_000)]); }

  private stored(group: string): Stored | null {
    const row = this.getInfo.get(group);
    return typeof row?.payload === 'string' ? JSON.parse(row.payload) as Stored : null;
  }

  private summary(data: Stored): JavaCatalogInfo {
    const { images, ...info } = data;
    return { ...info, screenshots: images.length };
  }

  info(game: GameMeta) {
    const data = this.stored(game.groupKey);
    return data ? this.summary(data) : null;
  }

  enrich(game: GameMeta): GameMeta {
    if ((game.platform ?? 'j2me') !== 'j2me') return game;
    const data = this.stored(game.groupKey);
    if (data) game.javaCatalog = { genres: data.genres, year: data.year };
    // A title's image dimensions can describe a different port. Use a size hint from an exact binary match only.
    if (!game.nativeResolution && game.archiveMatch?.state === 'exact' && game.archiveMatch.build?.sha256 === game.sha256) {
      const build = game.archiveMatch.build;
      const hint = readScreenHints({}, build.filename)[0] ?? readScreenHints({}, build.archivePath)[0];
      if (hint) game.nativeResolution = { ...hint, source: 'J2ME Archive' };
    }
    return game;
  }

  async lookup(game: GameMeta): Promise<JavaCatalogInfo | null> {
    if ((game.platform ?? 'j2me') !== 'j2me') return null;
    const archive = this.exactBuild(game.sha256);
    if (!game.nativeResolution && archive) {
      const hint = readScreenHints({}, archive.filename)[0] ?? readScreenHints({}, archive.archivePath)[0];
      if (hint) this.library.recordGameResolution(game.id, { ...hint, source: 'J2ME Archive' });
    }
    const index = await this.catalog();
    const known = archive?.title ? index.get(key(archive.title)) : undefined;
    const candidates = known ?? index.get(key(game.name)) ?? [];
    if (candidates.length !== 1) return null;
    const match = candidates[0]!;
    const url = new URL(`/game/${match.id.slice(3)}`, origin);
    const { bytes } = await readRemote(this.fetcher, url, at => at.origin === origin && /^\/game\/[a-z0-9-]+\/?$/.test(at.pathname), 2 * MIB, this.signal());
    const { images, description } = parseJavaCatalogPage(bytes.toString('utf8'));
    const data = { title: match.title, sourceUrl: url.href, genres: match.genres, description, images,
      year: /^\d{4}$/.test(match.listed_year) ? Number(match.listed_year) : null };
    this.library.db.prepare('INSERT OR REPLACE INTO java_catalog VALUES (?,?)').run(game.groupKey, JSON.stringify(data));
    return this.summary(data);
  }

  async screenshot(game: GameMeta, index: number) {
    const file = this.stored(game.groupKey)?.images[index - 1];
    if (!safeScreenshot(file)) return null;
    const directory = path.join(this.library.dataDir, 'java-catalog-images');
    const cached = path.join(directory, createHash('sha256').update(file).digest('hex'));
    let bytes = await readFile(cached).catch(() => null);
    if (!bytes || !sniffImage(bytes)) {
      ({ bytes } = await readRemote(this.fetcher, new URL(file, origin), at => at.origin === origin && safeScreenshot(at.pathname), 2 * MIB, this.signal()));
      if (sniffImage(bytes)) {
        const partial = `${cached}.${randomUUID()}.part`;
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(partial, bytes, { mode: 0o600 });
          await rename(partial, cached);
        } catch { await rm(partial, { force: true }).catch(() => undefined); }
      }
    }
    const ext = sniffImage(bytes);
    return ext ? { bytes, type: `image/${ext === 'jpg' ? 'jpeg' : ext}` } : null;
  }

  status() { return this.job; }

  start(): JavaCatalogJob {
    if (this.active) throw new UploadError('catalog_busy', 'The Java ME metadata lookup is already running', 409);
    const groups = new Map<string, GameMeta>();
    for (const game of this.library.list()) {
      if ((game.platform ?? 'j2me') === 'j2me' && !game.javaCatalog && !groups.has(game.groupKey)) groups.set(game.groupKey, game);
    }
    const report: JavaCatalogJob = { state: 'running', total: groups.size, processed: 0, matched: 0, errors: 0 };
    this.job = report;
    this.active = this.run([...groups.values()], report).finally(() => { this.active = undefined; });
    return report;
  }

  private async run(games: GameMeta[], report: JavaCatalogJob) {
    try {
      if (games.length) await this.catalog();
      for (const game of games) {
        if (this.shutdown.signal.aborted) break;
        try {
          if (await this.lookup(game)) {
            report.matched++;
            await delay(300, undefined, { signal: this.shutdown.signal }).catch(() => undefined);
          }
        } catch { report.errors++; }
        report.processed++;
      }
      report.state = 'done';
    } catch { report.state = 'failed'; }
  }

  async close() { this.shutdown.abort(); await this.active; }
}
