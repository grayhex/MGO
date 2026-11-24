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
import { readRemote, RemoteResponseError } from './remote.js';

const indexUrls = [
  'https://raw.githubusercontent.com/wakkatobakka/j2me-archive/main/data/catalog.json',
  'https://wakkatobakka.github.io/j2me-archive/data/catalog.json',
];
const origin = 'https://www.myabandonware.com';
const alternateOrigin = 'https://myabandonware.com';
const allowedSite = (url: URL) => url.origin === origin || url.origin === alternateOrigin;
const safeScreenshot = (src: unknown): src is string => typeof src === 'string' &&
  /^\/media\/screenshots\/(?:[a-z0-9_-]+\/)+[a-z0-9_.-]+\.(?:png|jpe?g|webp|gif)$/i.test(src);
const javaPlatform = /\b(?:J2ME|Java\s+ME)\b/i;
const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", '#039': "'", '#39': "'", lt: '<', gt: '>', nbsp: ' ' };
const decode = (html: string) => html.replace(/&([#a-z0-9]+);/gi, (whole, entity: string) => entities[entity] ?? whole);
type Listing = { id: string; title: string; aliases: string[]; genres: string[]; listed_year: string };
type Stored = Omit<JavaCatalogInfo, 'screenshots'> & { images: string[] };

function screenshotPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, origin);
    return allowedSite(url) && !url.username && !url.password && safeScreenshot(url.pathname) ? url.pathname : null;
  } catch { return null; }
}

export function parseJavaCatalogPage(html: string) {
  let images: string[] = [];
  const gallery = /\bplatformGalleries\s*=\s*(\{[^]*?\})\s*;/.exec(html)?.[1];
  if (gallery) {
    try {
      const platforms = JSON.parse(gallery) as Record<string, { items?: { src?: unknown }[] }>;
      const items = Object.entries(platforms).flatMap(([name, platform]) => javaPlatform.test(name) && Array.isArray(platform?.items) ? platform.items : []);
      images = [...new Set(items.map(item => screenshotPath(item?.src)).filter((src): src is string => src !== null))].slice(0, 8);
    } catch { /* some listings have no Java ME gallery */ }
  }
  let description = '';
  for (const [tag] of html.matchAll(/<meta\s+(?:"[^"]*"|'[^']*'|[^'">])*?>/gi)) {
    const attrs = new Map([...tag.matchAll(/\s(name|property|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
      .map(([, key, double, single]) => [key!.toLowerCase(), decode(double ?? single ?? '')]));
    const name = (attrs.get('name') ?? attrs.get('property'))?.toLowerCase();
    const content = attrs.get('content') ?? '';
    if ((name === 'description' || name === 'og:description') && javaPlatform.test(content)) {
      description = content.trim().slice(0, 600);
      break;
    }
  }
  return { images, description };
}

const retryable = (error: unknown) => !(error instanceof RemoteResponseError) || [403, 408, 429, 500, 502, 503, 504].includes(error.status);

function providerError(error: unknown, provider: string): string {
  if (error instanceof RemoteResponseError) return `${provider} · HTTP ${error.status}`;
  if (error instanceof Error && error.name === 'TimeoutError') return `${provider} · request timed out`;
  if (error instanceof TypeError) {
    const code = (error.cause as { code?: unknown } | null)?.code;
    return `${provider} · ${code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'DNS lookup failed' : 'server connection failed'}`;
  }
  return `${provider} · unexpected response`;
}

export class JavaCatalog {
  private index?: { until: number; entries: Map<string, Listing[]> };
  private job: JavaCatalogJob | null = null;
  private active?: Promise<void>;
  private jobAbort?: AbortController;
  private shutdown = new AbortController();
  private preferredOrigin = origin;
  private getInfo: StatementSync;

  constructor(private library: Library, private exactBuild: (sha: string) => ArchiveBuild | null, private fetcher: typeof fetch = fetch) {
    library.db.exec('CREATE TABLE IF NOT EXISTS java_catalog (group_key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    this.getInfo = library.db.prepare('SELECT payload FROM java_catalog WHERE group_key=?');
  }

  private async catalog(signal: AbortSignal) {
    if (this.index && this.index.until > Date.now()) return this.index.entries;
    const entries = await this.fetchCatalog(signal);
    this.index = { until: Date.now() + 24 * 60 * 60_000, entries };
    return entries;
  }

  private async fetchCatalog(signal: AbortSignal) {
    const readIndex = async (address: string) => {
      const { bytes } = await readRemote(this.fetcher, new URL(address), url => indexUrls.includes(url.href), 2 * MIB, this.signal(signal));
      const rows: unknown = JSON.parse(bytes.toString('utf8'))?.entries;
      if (!Array.isArray(rows)) throw new Error('Invalid Java ME metadata index');
      return rows;
    };
    const entries = await readIndex(indexUrls[0]!).catch(error => {
      signal.throwIfAborted();
      if (this.shutdown.signal.aborted) throw error;
      return readIndex(indexUrls[1]!);
    });
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

  // The gateway can spend time on DNS before starting its HTTPS connect and read timers.
  private signal(signal = this.shutdown.signal) { return AbortSignal.any([signal, this.shutdown.signal, AbortSignal.timeout(30_000)]); }

  private async site(pathname: string, allowedPath: (path: string) => boolean, maxBytes: number, accept: string, signal = this.shutdown.signal) {
    const allowed = (at: URL) => allowedSite(at) && allowedPath(at.pathname);
    const headers = { accept, 'user-agent': 'MGO game metadata (https://github.com/grayhex/MGO)' };
    const preferred = this.preferredOrigin;
    const read = (host: string) => readRemote(this.fetcher, new URL(pathname, host), allowed, maxBytes, this.signal(signal), headers);
    try {
      return await read(preferred);
    } catch (error) {
      signal.throwIfAborted();
      this.shutdown.signal.throwIfAborted();
      if (!retryable(error)) throw error;
      await delay(750, undefined, { signal });
      const alternate = preferred === origin ? alternateOrigin : origin;
      const response = await read(alternate);
      this.preferredOrigin = response.url.origin;
      return response;
    }
  }

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
    if (data) game.javaCatalog = { genres: data.genres, year: data.year, screenshots: data.images.length, ...(data.partial ? { partial: true } : {}) };
    // A title's image dimensions can describe a different port. Use a size hint from an exact binary match only.
    if (!game.nativeResolution && game.archiveMatch?.state === 'exact' && game.archiveMatch.build?.sha256 === game.sha256) {
      const build = game.archiveMatch.build;
      const hint = readScreenHints({}, build.filename)[0] ?? readScreenHints({}, build.archivePath)[0];
      if (hint) game.nativeResolution = { ...hint, source: 'J2ME Archive' };
    }
    return game;
  }

  async lookup(game: GameMeta): Promise<JavaCatalogInfo | null> {
    return (await this.lookupGame(game, this.shutdown.signal, true)).info;
  }

  private async lookupGame(game: GameMeta, signal: AbortSignal, fetchPage: boolean): Promise<{ info: JavaCatalogInfo | null; error?: string; unavailable?: boolean }> {
    if ((game.platform ?? 'j2me') !== 'j2me') return { info: null };
    signal.throwIfAborted();
    const archive = this.exactBuild(game.sha256);
    if (!game.nativeResolution && archive) {
      const hint = readScreenHints({}, archive.filename)[0] ?? readScreenHints({}, archive.archivePath)[0];
      if (hint) this.library.recordGameResolution(game.id, { ...hint, source: 'J2ME Archive' });
    }
    const index = await this.catalog(signal);
    const known = archive?.title ? index.get(key(archive.title)) : undefined;
    const candidates = known ?? index.get(key(game.name)) ?? [];
    if (candidates.length !== 1) return { info: null };
    const match = candidates[0]!;
    const url = new URL(`/game/${match.id.slice(3)}`, origin);
    const data: Stored = { title: match.title, sourceUrl: url.href, genres: match.genres, description: '', images: [],
      year: /^\d{4}$/.test(match.listed_year) ? Number(match.listed_year) : null, partial: true };
    let error: string | undefined;
    let unavailable = false;
    if (fetchPage) {
      try {
        const { bytes } = await this.site(url.pathname, name => /^\/game\/[a-z0-9-]+\/?$/.test(name), 4 * MIB, 'text/html,application/xhtml+xml', signal);
        const page = parseJavaCatalogPage(bytes.toString('utf8'));
        if (page.description || page.images.length) {
          Object.assign(data, page);
          delete data.partial;
        } else {
          error = 'My Abandonware returned a page without Java ME metadata';
        }
      } catch (cause) {
        signal.throwIfAborted();
        unavailable = !(cause instanceof RemoteResponseError) || [401, 403, 429].includes(cause.status) || cause.status >= 500;
        error = providerError(cause, 'My Abandonware');
      }
    }
    const stored = this.stored(game.groupKey);
    if (stored && !stored.partial && data.partial) return { info: this.summary(stored), ...(error ? { error, unavailable } : {}) };
    signal.throwIfAborted();
    this.library.db.prepare('INSERT OR REPLACE INTO java_catalog VALUES (?,?)').run(game.groupKey, JSON.stringify(data));
    return { info: this.summary(data), ...(error ? { error, unavailable } : {}) };
  }

  async screenshot(game: GameMeta, index: number) {
    const file = this.stored(game.groupKey)?.images[index - 1];
    if (!safeScreenshot(file)) return null;
    const directory = path.join(this.library.dataDir, 'java-catalog-images');
    const cached = path.join(directory, createHash('sha256').update(file).digest('hex'));
    let bytes = await readFile(cached).catch(() => null);
    if (!bytes || !sniffImage(bytes)) {
      ({ bytes } = await this.site(file, safeScreenshot, 2 * MIB, 'image/*'));
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

  cancel(): boolean {
    if (!this.jobAbort || this.jobAbort.signal.aborted) return false;
    this.jobAbort.abort();
    return true;
  }

  start(): JavaCatalogJob {
    if (this.active) throw new UploadError('catalog_busy', 'The Java ME metadata lookup is already running', 409);
    const groups = new Map<string, GameMeta>();
    for (const game of this.library.list()) {
      if ((game.platform ?? 'j2me') === 'j2me' && (!game.javaCatalog || game.javaCatalog.partial) && !groups.has(game.groupKey)) groups.set(game.groupKey, game);
    }
    const report: JavaCatalogJob = { state: 'running', total: groups.size, processed: 0, matched: 0, errors: 0, partial: 0 };
    this.job = report;
    const abort = new AbortController();
    this.jobAbort = abort;
    this.active = this.run([...groups.values()], report, AbortSignal.any([abort.signal, this.shutdown.signal]))
      .finally(() => { this.active = undefined; this.jobAbort = undefined; });
    return report;
  }

  private async run(games: GameMeta[], report: JavaCatalogJob, signal: AbortSignal) {
    let consecutiveErrors = 0;
    try {
      if (games.length) await this.catalog(signal);
      for (const game of games) {
        signal.throwIfAborted();
        const result = await this.lookupGame(game, signal, consecutiveErrors < 3);
        report.processed++;
        if (!result.info) continue;
        report.matched++;
        if (result.info.partial) report.partial = (report.partial ?? 0) + 1;
        if (result.error) {
          report.error = result.error;
          report.errors++;
          consecutiveErrors = result.unavailable ? consecutiveErrors + 1 : 0;
        } else if (!result.info.partial) consecutiveErrors = 0;
        if (consecutiveErrors < 3) await delay(500, undefined, { signal });
        else await delay(0, undefined, { signal });
      }
      report.state = 'done';
    } catch (error) {
      report.state = signal.aborted ? 'cancelled' : 'failed';
      if (!signal.aborted) report.error = providerError(error, 'Java ME metadata index');
    }
  }

  async close() { this.shutdown.abort(); await this.active; }
}
