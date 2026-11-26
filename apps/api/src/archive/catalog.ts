import type { ArchiveBuild, GameMeta, JavaCatalogInfo, JavaCatalogJob } from '@mgo/protocol';
import type { StatementSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Library } from '../library.js';
import { UploadError } from '../jar.js';
import { readScreenHints, resolutionPriority } from '../analysis/screenHints.js';
import { imageType, sniffImage } from '../image.js';
import { archiveTitleKey as key, MIB, normalized } from './index.js';
import { cleanTitle } from '../title.js';
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
type Screenshot = { bytes: Buffer; type: string };
type CatalogIndex = { titles: Map<string, Listing[]>; aliases: Map<string, Listing[]>; short: Map<string, Listing[]> };

const roman: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
// MIDlet and archive names for known Java ME releases whose directory entries use a different title.
const alternateTitles = new Map([
  ['Colin McRae 05', 'Colin McRae Rally 2005'],
  ['Colin McRae Rally 4', 'Colin McRae Rally 04'],
  ['Darkest Fear 2: Grim Oak', 'Darkest Fear: Grim Oak'],
  ['FIFA World Cup 2006', 'FIFA World Cup: Germany 2006'],
  ['Garfield In Robocats From Outer Space', 'Garfield: Robocats from Outer Space'],
  ['Rainbow Six 3', "Tom Clancy's Rainbow Six 3"],
  ['Rainbow Six Vegas', "Tom Clancy's Rainbow Six: Vegas"],
  ['Resident Evil(R) Uprising', 'Resident Evil: Uprising'],
  ['Siberian Ep II', 'Siberian Strike: Episode II'],
  ['Silent Hill', 'Silent Hill: Orphan'],
  ['SplinterCell', "Tom Clancy's Splinter Cell"],
  ['TDE - Among Pirates', 'The Dark Eye: Among Pirates'],
  ['TDE - Crypt Raiders', 'The Dark Eye: Crypt Raiders'],
  ['TDE - Swamp of Doom', 'The Dark Eye: Swamp of Doom'],
  ['TDE - The Caliphs Daughter', "The Dark Eye: Nedime - The Caliph's Daughter"],
].map(([alias, title]) => [key(alias!), title!]));
const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '');
const titleForm = (value: string) => key(normalized(cleanTitle(fold(value))).split(' ').map(word => roman[word] ?? word).join(' '));
const shortEnough = (value: string) => normalized(value).split(' ').length >= 2 && titleForm(value).length >= 9;
const edition = (value: string) => {
  const tokens = normalized(cleanTitle(value)).split(' ');
  return tokens.filter(token => roman[token] || /^\d{1,4}$|^3d$/.test(token)).map(token => roman[token] ?? token).join(' ');
};
const filenameTitle = (name: string) => name.replaceAll('_', ' ').replace(/\.(?:jar|jad)$/i, '').replace(/\[[a-f0-9]{8,16}\]$/i, '')
  .replace(/(?:\s*\[[^\]]+\]|\s*\([^()]+\))\s*$/g, match => /\d{2,4}\s*[x×]\s*\d{2,4}|\b(?:nokia|siemens|sony ericsson|english|russian|multiscreen)\b/i.test(match) ? '' : match)
  .replace(/(?:[ _-]+v?\d+\.\d+(?:\.\d+)?|[ _-]+(?:en|ru|eng|rus|multi|nokias?[346]0|s[346]0v?\d?|k[578]\d{2}i?|n(?:70|95)|s65)|[ _-]+\d{2,4}\s*[x×]\s*\d{2,4})+$/i, '').trim();

function addListing(map: Map<string, Listing[]>, form: string, row: Listing) {
  if (!form) return;
  const entries = map.get(form) ?? [];
  if (!entries.some(entry => entry.id === row.id)) entries.push(row);
  map.set(form, entries);
}

function matchListing(index: CatalogIndex, names: string[]) {
  const forms = [...new Set(names.map(name => titleForm(alternateTitles.get(key(name)) ?? name)).filter(Boolean))];
  for (const map of [index.titles, index.aliases, index.short]) {
    const matches = new Map<string, Listing>();
    for (const form of forms) {
      const entries = map.get(form) ?? [];
      if (entries.length === 1) matches.set(entries[0]!.id, entries[0]!);
    }
    if (matches.size) return matches.size === 1 ? matches.values().next().value : undefined;
  }
  return undefined;
}

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
  if (!description) for (const [, json] of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([^]*?)<\/script>/gi)) {
    try {
      const item = JSON.parse(json!);
      if (item?.['@type'] === 'VideoGame' && javaPlatform.test(String(item.gamePlatform ?? item.operatingSystem ?? '')) && typeof item.description === 'string') {
        description = decode(item.description).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
        if (description) break;
      }
    } catch { /* malformed structured data can coexist with a useful gallery */ }
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
  private index?: { until: number; entries: CatalogIndex };
  private job: JavaCatalogJob | null = null;
  private active?: Promise<void>;
  private jobAbort?: AbortController;
  private shutdown = new AbortController();
  private preferredOrigin = origin;
  private getInfo: StatementSync;
  private imageLoads = new Map<string, Promise<Screenshot | null>>();
  private thumbnailQueue = new Set<string>();
  private imageRetryAfter = new Map<string, number>();

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
    const index: CatalogIndex = { titles: new Map(), aliases: new Map(), short: new Map() };
    for (const entry of entries) {
      if (typeof entry?.id !== 'string' || !/^ma:[a-z0-9]+(?:-[a-z0-9]+)+$/.test(entry.id) || typeof entry.title !== 'string') continue;
      const row: Listing = {
        id: entry.id, title: entry.title,
        aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((value: unknown) => typeof value === 'string') : [],
        genres: Array.isArray(entry.genres) ? entry.genres.filter((value: unknown) => typeof value === 'string') : [],
        listed_year: String(entry.listed_year ?? ''),
      };
      addListing(index.titles, titleForm(row.title), row);
      for (const alias of row.aliases) addListing(index.aliases, titleForm(alias), row);
      const parts = row.title.split(/\s*:\s*|\s+[-–—]\s+/);
      if (/\bmobile(?: game)?$/i.test(row.title)) parts.push(row.title.replace(/\s+mobile(?: game)?$/i, ''));
      if (parts.length > 1) for (const part of [parts[0]!, parts.at(-1)!]) {
        if (shortEnough(part) && edition(part) === edition(row.title)) addListing(index.short, titleForm(part), row);
      }
    }
    return index;
  }

  // The gateway can spend time on DNS before starting its HTTPS connect and read timers.
  private signal(signal = this.shutdown.signal) { return AbortSignal.any([signal, this.shutdown.signal, AbortSignal.timeout(12_000)]); }

  private async site(pathname: string, allowedPath: (path: string) => boolean, maxBytes: number, accept: string, signal = this.shutdown.signal) {
    const allowed = (at: URL) => allowedSite(at) && allowedPath(at.pathname);
    const headers = { accept, 'user-agent': 'MGO game metadata (https://github.com/grayhex/MGO)' };
    const preferred = this.preferredOrigin;
    const read = (host: string) => readRemote(this.fetcher, new URL(pathname, host), allowed, maxBytes, this.signal(signal), headers);
    try {
      const response = await read(preferred);
      this.preferredOrigin = response.url.origin;
      return response;
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
    if (game.archiveMatch?.state === 'exact' && game.archiveMatch.build?.sha256 === game.sha256)
      this.applyArchiveResolution(game, game.archiveMatch.build);
    return game;
  }

  private applyArchiveResolution(game: GameMeta, build: ArchiveBuild) {
    if (resolutionPriority(game.nativeResolution) >= 4) return;
    const hints = [readScreenHints({}, build.filename)[0], readScreenHints({}, build.archivePath)[0]];
    const hint = hints.find(value => value?.source === 'file name') ?? hints.find(Boolean);
    if (hint?.source === 'file name') game.nativeResolution = { ...hint, source: 'J2ME Archive' };
    else if (hint && resolutionPriority(hint) > resolutionPriority(game.nativeResolution)) game.nativeResolution = hint;
  }

  /** Look up the exact binary in an installed index without running a metadata job. */
  findExactResolution(game: GameMeta, build = this.exactBuild(game.sha256)): GameMeta {
    if ((game.platform ?? 'j2me') !== 'j2me' || resolutionPriority(game.nativeResolution) >= 4) return game;
    if (build?.sha256 === game.sha256) {
      this.applyArchiveResolution(game, build);
      if (game.nativeResolution) this.library.recordGameResolution(game.id, game.nativeResolution);
    }
    return game;
  }

  async lookup(game: GameMeta): Promise<JavaCatalogInfo | null> {
    return (await this.lookupGame(game, this.shutdown.signal, true)).info;
  }

  private async lookupGame(game: GameMeta, signal: AbortSignal, fetchPage: boolean, versions = [game]): Promise<{ info: JavaCatalogInfo | null; error?: string; unavailable?: boolean }> {
    if ((game.platform ?? 'j2me') !== 'j2me') return { info: null };
    signal.throwIfAborted();
    const index = await this.catalog(signal);
    const archiveTitles = versions.flatMap(version => {
      const build = this.exactBuild(version.sha256);
      this.findExactResolution(version, build);
      return build?.sha256 === version.sha256 && build.title ? [build.title] : [];
    });
    const match = matchListing(index, archiveTitles) ?? matchListing(index, versions.map(version => version.name)) ??
      matchListing(index, versions.flatMap(version => version.fileName ? [filenameTitle(version.fileName)] : []));
    if (!match) return { info: null };
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

  async screenshot(game: GameMeta, index: number): Promise<Screenshot | null> {
    const file = this.stored(game.groupKey)?.images[index - 1];
    if (!safeScreenshot(file)) return null;
    return await this.cachedScreenshot(file) ?? await this.loadScreenshot(file, 4, false);
  }

  async thumbnail(game: GameMeta): Promise<Screenshot | 'pending' | null> {
    const files = this.stored(game.groupKey)?.images.filter(safeScreenshot) ?? [];
    for (const file of files) {
      const cached = await this.cachedScreenshot(file);
      if (cached) return cached;
    }
    const candidate = files.find(file => (this.imageRetryAfter.get(file) ?? 0) <= Date.now());
    if (!candidate) return null;
    if (!this.imageLoads.has(candidate) && this.thumbnailQueue.size < 24) this.thumbnailQueue.add(candidate);
    this.pumpThumbnails();
    return 'pending';
  }

  private pumpThumbnails() {
    while (!this.shutdown.signal.aborted && this.imageLoads.size < 2 && this.thumbnailQueue.size) {
      const file = this.thumbnailQueue.values().next().value!;
      this.thumbnailQueue.delete(file);
      void this.loadScreenshot(file, 2, true);
    }
  }

  private screenshotFile(file: string) {
    const directory = path.join(this.library.dataDir, 'java-catalog-images');
    return path.join(directory, createHash('sha256').update(file).digest('hex'));
  }

  private async cachedScreenshot(file: string): Promise<Screenshot | null> {
    const bytes = await readFile(this.screenshotFile(file)).catch(() => null);
    const ext = bytes && sniffImage(bytes);
    return bytes && ext ? { bytes, type: imageType(ext) } : null;
  }

  private loadScreenshot(file: string, slots: number, background: boolean): Promise<Screenshot | null> | null {
    const existing = this.imageLoads.get(file);
    if (existing) return existing;
    if (this.shutdown.signal.aborted || this.imageLoads.size >= slots) return null;
    this.thumbnailQueue.delete(file);
    const task = this.downloadScreenshot(file, background).catch(() => null).then(image => {
      if (image) this.imageRetryAfter.delete(file);
      else {
        if (this.imageRetryAfter.size >= 512) this.imageRetryAfter.delete(this.imageRetryAfter.keys().next().value!);
        this.imageRetryAfter.set(file, Date.now() + 5 * 60_000);
      }
      return image;
    }).finally(() => {
      this.imageLoads.delete(file);
      this.pumpThumbnails();
    });
    this.imageLoads.set(file, task);
    return task;
  }

  private async downloadScreenshot(file: string, background: boolean): Promise<Screenshot | null> {
    const budget = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(background ? 5000 : 9000)]);
    const { bytes } = await this.site(file, safeScreenshot, 2 * MIB, 'image/*', budget);
    const ext = sniffImage(bytes);
    if (!ext) return null;
    const cached = this.screenshotFile(file);
    const partial = `${cached}.${randomUUID()}.part`;
    try {
      await mkdir(path.dirname(cached), { recursive: true, mode: 0o700 });
      await writeFile(partial, bytes, { mode: 0o600 });
      await rename(partial, cached);
    } catch { await rm(partial, { force: true }).catch(() => undefined); }
    return { bytes, type: imageType(ext) };
  }

  status() { return this.job; }

  cancel(): boolean {
    if (!this.jobAbort || this.jobAbort.signal.aborted) return false;
    this.jobAbort.abort();
    return true;
  }

  start(ids?: ReadonlySet<string>, parent?: AbortSignal): JavaCatalogJob {
    if (this.active) throw new UploadError('catalog_busy', 'The Java ME metadata lookup is already running', 409);
    const groups = new Map<string, GameMeta[]>();
    for (const game of this.library.list()) {
      if ((!ids || ids.has(game.id)) && (game.platform ?? 'j2me') === 'j2me' && (!game.javaCatalog || game.javaCatalog.partial)) {
        const versions = groups.get(game.groupKey) ?? [];
        versions.push(game);
        groups.set(game.groupKey, versions);
      }
    }
    const report: JavaCatalogJob = { state: 'running', total: groups.size, processed: 0, matched: 0, errors: 0, partial: 0 };
    this.job = report;
    const abort = new AbortController();
    this.jobAbort = abort;
    this.active = this.run([...groups.values()], report, AbortSignal.any([abort.signal, this.shutdown.signal, ...(parent ? [parent] : [])]))
      .finally(() => { this.active = undefined; this.jobAbort = undefined; });
    return report;
  }

  async recognizeDownloaded(ids: readonly string[], signal: AbortSignal): Promise<JavaCatalogJob | null> {
    if (!ids.length) return null;
    const stop = AbortSignal.any([signal, this.shutdown.signal]);
    while (this.active) await delay(350, undefined, { signal: stop });
    stop.throwIfAborted();
    const report = this.start(new Set(ids), stop);
    await this.active;
    return report;
  }

  private async run(games: GameMeta[][], report: JavaCatalogJob, signal: AbortSignal) {
    let consecutiveErrors = 0;
    let retried = false;
    try {
      if (games.length) await this.catalog(signal);
      const matched: GameMeta[][] = [];
      for (const versions of games) {
        signal.throwIfAborted();
        const result = await this.lookupGame(versions[0]!, signal, false, versions);
        report.processed++;
        if (!result.info) continue;
        report.matched++;
        if (result.info.partial) {
          report.partial = (report.partial ?? 0) + 1;
          matched.push(versions);
        }
      }
      report.detailsTotal = matched.length;
      for (const versions of matched) {
        signal.throwIfAborted();
        if (consecutiveErrors >= 3) {
          if (retried) break;
          await delay(5000, undefined, { signal });
          retried = true;
        }
        const result = await this.lookupGame(versions[0]!, signal, true, versions);
        report.detailsProcessed = (report.detailsProcessed ?? 0) + 1;
        if (result.error) {
          report.error = result.error;
          report.errors++;
          consecutiveErrors = result.unavailable ? consecutiveErrors + 1 : 0;
        } else if (result.info && !result.info.partial) {
          consecutiveErrors = 0;
          retried = false;
          report.partial = Math.max(0, (report.partial ?? 1) - 1);
        }
        await delay(300, undefined, { signal });
      }
      report.state = 'done';
    } catch (error) {
      report.state = signal.aborted ? 'cancelled' : 'failed';
      if (!signal.aborted) report.error = providerError(error, 'Java ME metadata index');
    }
  }

  async close() { this.shutdown.abort(); await Promise.allSettled([this.active, ...this.imageLoads.values()]); }
}
