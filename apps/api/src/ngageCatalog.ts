import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { isGenre, type GameMeta, type NgageInfo } from '@mgo/protocol';
import type { Library } from './library.js';
import { AAS_SNAPSHOT, AAS_SNAPSHOT_DATE } from './ngageSnapshot.js';

export const AAS_ORIGIN = 'https://allaboutsymbian.com';
const AAS_HOSTS = new Set([AAS_ORIGIN, 'https://www.allaboutsymbian.com']);
export const AAS_INDEX = '/n-gage-games/original/';
export const LAUNCHBOX_ORIGIN = 'https://gamesdb.launchbox-app.com';
export const LAUNCHBOX_INDEX = '/platforms/games/213-nokia-n-gage';
const LAUNCHBOX_IMAGES = 'https://images.launchbox-app.com';
const IMAGE_PATH = /^\/[a-f0-9-]{36}\.(?:png|jpe?g|webp)$/i;
const TTL = 30 * 86400_000;
const text = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, h, d) => (parseInt(h || d, h ? 16 : 10) <= 0x10ffff ? String.fromCodePoint(parseInt(h || d, h ? 16 : 10)) : '�')).replace(/&(amp|quot|apos|lt|gt|nbsp|middot);/g, (_, n) => ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',middot:'·'})[n as string] ?? '').trim();
export interface CatalogEntry { title: string; url: string; genre: string; publisher: string; year: number | null; cover: string | null; released?: string }
export function parseAasIndex(html: string): CatalogEntry[] {
  const released = html.split(/<h2[^>]+id="unreleased"/i)[0]!;
  const entries: CatalogEntry[] = []; let genre = '';
  for (const token of released.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>|<a\b[^>]*href="(item\/[a-z0-9-]+\.php)"[^>]*class="game-card"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (token[1]) { genre = text(token[1]).replace(/\s*\(\d+\)$/, ''); continue; }
    const card = token[3]!;
    const title = text(/class="title"[^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? '');
    const meta = text(/class="meta"[^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? '');
    const image = /<img[^>]+src="([^"]+)"/i.exec(card)?.[1] ?? null;
    if (title) entries.push({ title, url: AAS_ORIGIN + AAS_INDEX + token[2], genre, publisher: meta.split('·')[0]!.split(' / ')[0]!.trim(), year: Number(/\b(19\d\d|20\d\d)\b/.exec(meta)?.[1]) || null, cover: image && /^\/images\/ngage\//.test(image) ? AAS_ORIGIN + image : null });
  }
  if (!entries.length) throw new Error('All About Symbian returned an unrecognized game directory');
  return entries;
}
export function parseLaunchBoxIndex(html: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const [, url, card] of html.matchAll(/<a\b[^>]*href="(\/games\/details\/\d+-[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = text(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(card!)?.[1] ?? '');
    const released = text(/class="releaseDate"[^>]*>\s*<span[^>]*>Released<\/span>\s*<h5[^>]*>([\s\S]*?)<\/h5>/i.exec(card!)?.[1] ?? '');
    const year = Number(/\b(19\d\d|20\d\d)\b/.exec(released)?.[1]);
    if (!title || !year) continue;
    const image = /<img\b[^>]*src="https:\/\/images\.launchbox-app\.com(\/[^"]+)"/i.exec(card!)?.[1];
    entries.push({ title, url: LAUNCHBOX_ORIGIN + url, genre: '', publisher: '', year, released, cover: image && IMAGE_PATH.test(image) ? LAUNCHBOX_IMAGES + image : null });
  }
  if (!entries.length) throw new Error('LaunchBox returned an unrecognized game directory');
  return entries;
}

/**
 * Words of a title as they are compared. Everything a dump adds around the name is dropped: region and version tags in brackets
 * ("(E)", "[!]", "(Europe)", "v1.1"), the word N-Gage, punctuation, case and accents; "&" is "and", Roman numerals are digits.
 */
const ROMAN: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
export function catalogTokens(raw: string, fileName = false): string[] {
  let s = text(raw).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\.(zip|n-gage)$/i, '');
  if (fileName) s = s.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ').replace(/\bv\d+(?:\.\d+)*\b/g, ' ');
  const words = s.replace(/&/g, ' and ').replace(/['\u2019`]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = words.filter(w => w !== 'ngage' && w !== 'gage' && !(w === 'n' && words[words.indexOf(w) + 1] === 'gage'));
  return tokens.map((w, i) => (i > 0 && ROMAN[w] ? ROMAN[w]! : w));
}
const FILLER = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in']);
const coreOf = (tokens: string[]) => tokens.filter(t => !FILLER.has(t));

/**
 * The directory entry that a game belongs to, or null when there is none or it is not certain. Exact title first (so that
 * "Pathway to Glory" never becomes its sequel), then a title with the publisher's brand left out or with a few extra
 * words around it ("Ghost Recon - Jungle Storm" is "Tom Clancy's Ghost Recon: Jungle Storm"). Two candidates are never guessed between.
 */
export function matchAas(title: string, entries: CatalogEntry[]): CatalogEntry | null {
  const file = catalogTokens(title, true), fileKey = file.join('');
  if (!fileKey) return null;
  const exact = entries.filter(e => catalogTokens(e.title).join('') === fileKey);
  if (exact.length) return exact.length === 1 ? exact[0]! : null;
  const loose = entries.filter(e => coreOf(catalogTokens(e.title)).join('') === coreOf(file).join(''));
  if (loose.length) return loose.length === 1 ? loose[0]! : null;
  const fileSet = new Set(coreOf(file));
  if (fileSet.size < 2 || fileKey.length < 8) return null;
  const superset = entries.filter(e => { const t = coreOf(catalogTokens(e.title)); return t.length - fileSet.size <= 2 && t.length > fileSet.size && [...fileSet].every(w => t.includes(w)); });
  if (superset.length) return superset.length === 1 ? superset[0]! : null;
  const subset = entries.filter(e => { const t = coreOf(catalogTokens(e.title)); return t.length >= 2 && fileSet.size - t.length <= 2 && fileSet.size > t.length && t.every(w => fileSet.has(w)); });
  return subset.length === 1 ? subset[0]! : null;
}
export function parseAasDetails(html: string, entry: CatalogEntry): NgageInfo {
  let game: Record<string, any> = {};
  for (const script of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const value = JSON.parse(script[1]!); if (value['@type'] === 'VideoGame') game = value; } catch { /* an unrelated invalid block */ }
  }
  const field = (name: string) => text(new RegExp(`<tr>\\s*<td>${name}<\\/td>\\s*<td>([\\s\\S]*?)<\\/td>`, 'i').exec(html)?.[1] ?? '');
  const score = Number(game.aggregateRating?.ratingValue), max = Number(game.aggregateRating?.bestRating ?? 100);
  return { title: entry.title, sourceUrl: entry.url, attribution: 'All About Symbian', genre: entry.genre, publisher: field('Publisher') || entry.publisher, developer: field('Developer') || null, year: entry.year, released: field('Released') || null, multiplayer: field('Multiplayer') || null, productCode: field('Product code') || null, rating: Number.isFinite(score) && max > 0 ? Math.round(score / max * 100) : null, hasCover: false, fetchedAt: new Date().toISOString() };
}

/** What is known about a game from the directory index alone (no page was fetched): enough for genre, publisher and year. */
function indexInfo(entry: CatalogEntry, fetchedAt: string): NgageInfo {
  return { title: entry.title, sourceUrl: entry.url, attribution: entry.url.startsWith(LAUNCHBOX_ORIGIN) ? 'LaunchBox Games Database' : 'All About Symbian', genre: entry.genre, publisher: entry.publisher, developer: null, year: entry.year, released: entry.released ?? null, multiplayer: null, productCode: null, rating: null, hasCover: false, fetchedAt };
}

/**
 * Only fixed AAS pages/images are fetched. No page view contacts a third party.
 *
 * Recognition does not need the network: a snapshot of the directory (titles, genres, publishers, years) ships with MGO, so a
 * game is recognised and its genre filled in even when the server has no route to the internet. The live directory, the game pages and
 * the covers are fetched on top of that when they can be reached; a failure is reported (with the reason) and never removes anything.
 */
export class NgageCatalog {
  private entries: CatalogEntry[] = AAS_SNAPSHOT;
  private launchBox: CatalogEntry[] = [];
  private live = false;
  private progress: { done: number; total: number } | null = null;
  private info = new Map<string, NgageInfo>();
  private quick = new Map<string, { name: string; info: NgageInfo | null }>();
  private running: Promise<void> | null = null;
  private lastIndex = 0;
  private active = false;
  private pending = false;
  private abort = new AbortController();
  private error: string | null = null;
  readonly dir: string;
  constructor(private library: Library, dataDir: string, private fetcher: typeof fetch = fetch, private proxy = process.env.AAS_PROXY_URL ?? process.env.MGO_METADATA_GATEWAY ?? '') {
    this.dir = path.join(dataDir, 'aas'); mkdirSync(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(path.join(this.dir, 'catalog.json'), 'utf8'));
      if (Array.isArray(saved.entries) && saved.entries.length) { this.entries = saved.entries; this.live = true; }
      if (Array.isArray(saved.launchBox)) this.launchBox = saved.launchBox;
      this.lastIndex = saved.updatedAt ?? 0; this.info = new Map(saved.info);
    } catch { /* first refresh populates the cache */ }
  }
  private ngageGames() { return this.library.list().filter(g => g.platform === 'ngage'); }
  status() {
    const unmatched = this.ngageGames().filter(g => !this.lookup(g)).map(g => g.name).sort();
    return {
      running: !!this.running, progress: this.progress, entries: this.entries.length, matched: this.ngageGames().length - unmatched.length, unmatched,
      updatedAt: this.lastIndex ? new Date(this.lastIndex).toISOString() : null, error: this.error, sourceUrl: AAS_ORIGIN + AAS_INDEX,
      /** `live`: the directory was downloaded from the source; `snapshot`: the list that ships with MGO is used. */
      source: this.live ? 'live' as const : 'snapshot' as const, snapshotDate: AAS_SNAPSHOT_DATE,
      covers: this.info.size ? [...this.info.values()].filter(i => i.hasCover).length : 0,
    };
  }
  /** Fetched details if there are any, else what the directory index says. Null: not an N-Gage game of the directory. */
  private lookup(game: GameMeta): NgageInfo | null {
    if (game.platform !== 'ngage') return null;
    const full = this.info.get(game.groupKey); if (full) return full;
    const cached = this.quick.get(game.groupKey);
    if (cached && cached.name === game.name) return cached.info;
    const entry = matchAas(game.name, this.entries) ?? matchAas(game.name, this.launchBox);
    const info = entry ? indexInfo(entry, this.lastIndex ? new Date(this.lastIndex).toISOString() : AAS_SNAPSHOT_DATE) : null;
    this.quick.set(game.groupKey, { name: game.name, info });
    if (info && isGenre(info.genre)) this.library.classes.setCurated(game.groupKey, info.genre, info.title);
    return info;
  }
  enrich(game: GameMeta): GameMeta { const info = this.lookup(game); return info ? { ...game, ngageInfo: info } : game; }
  cover(group: string): string | null { const file = path.join(this.dir, `${group}.img`); return /^[a-f0-9]{12}$/.test(group) && existsSync(file) ? file : null; }
  private async request(url: string, limit: number, job: AbortSignal) {
    const signal = AbortSignal.any([job, AbortSignal.timeout(9000)]);
    let target = url, response: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      const allowed = new URL(target, AAS_ORIGIN);
      const aas = AAS_HOSTS.has(allowed.origin) && /^\/(n-gage-games\/original\/(?:item\/[a-z0-9-]+\.php)?|images\/ngage\/[\w/.-]+)$/.test(allowed.pathname);
      const boxIndex = allowed.origin === LAUNCHBOX_ORIGIN && allowed.pathname === LAUNCHBOX_INDEX;
      const boxImage = allowed.origin === LAUNCHBOX_IMAGES && IMAGE_PATH.test(allowed.pathname);
      if ((!aas && !boxIndex && !boxImage) || allowed.username || allowed.password || allowed.search) throw new Error('Unsupported catalog URL');
      const prefix = boxIndex ? '/mgo-launchbox' : boxImage ? '/mgo-launchbox-images' : allowed.origin === AAS_ORIGIN ? '' : '/mgo-aas-www';
      const endpoint = this.proxy ? this.proxy.replace(/\/$/, '') + prefix + allowed.pathname : allowed.href;
      try { response = await this.fetcher(endpoint, { signal, redirect: 'manual', headers: { 'user-agent': 'MGO metadata/1.5' } }); }
      catch (e) { throw new CatalogUnreachable(`${allowed.host} cannot be reached`, (e as Error).message); }
      const next = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!next) break;
      target = new URL(next, allowed).href;
      response = undefined;
    }
    if (!response) throw new Error('Too many catalog redirects');
    if (response.status >= 500 || response.status === 429) throw new CatalogUnreachable('Catalog source is temporarily unavailable', `HTTP ${response.status}`);
    if (!response.ok || !response.body) throw new Error(`Catalog source: HTTP ${response.status}`);
    const reader = response.body!.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > limit) throw new Error('Catalog response is too large'); chunks.push(r.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    return { bytes: Buffer.concat(chunks), type: response.headers.get('content-type') ?? '' };
  }
  start() { this.active = true; this.recognise(); if (this.ngageGames().length) void this.refresh(); }
  schedule() { this.recognise(); if (this.running) { this.pending = true; return; } if (this.active) void this.refresh(); }
  stop() { this.active = false; this.abort.abort(); }
  async idle() { await this.running; }
  /** Recognition from the index alone (no network): fills in the genre of every game it knows. */
  private recognise() { for (const g of this.ngageGames()) this.lookup(g); }
  refresh(force = false): Promise<void> {
    if (this.running) return this.running;
    this.running = this.update(force).catch(e => { this.error = e.message; }).finally(() => { this.running = null; if (this.pending && this.active) { this.pending = false; this.schedule(); } }); return this.running;
  }
  private async update(force: boolean) {
    this.error = null;
    this.progress = null;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(75000)]);
    const all = new Map(this.ngageGames().map(game => [game.groupKey, game]));
    if (!all.size && !force) return;

    let aasOnline = true;
    const changed = force || Date.now() - this.lastIndex > TTL || !this.live;
    if (changed) {
      const [aas, box] = await Promise.allSettled([
        this.request(AAS_ORIGIN + AAS_INDEX, 2 * 1024 * 1024, signal).then(r => parseAasIndex(r.bytes.toString('utf8'))),
        this.request(LAUNCHBOX_ORIGIN + LAUNCHBOX_INDEX, 2 * 1024 * 1024, signal).then(r => parseLaunchBoxIndex(r.bytes.toString('utf8'))),
      ]);
      if (aas.status === 'fulfilled') { this.entries = aas.value; this.live = true; }
      else aasOnline = false;
      if (box.status === 'fulfilled') this.launchBox = box.value;
      if (aas.status === 'fulfilled' || box.status === 'fulfilled') this.lastIndex = Date.now();
      else {
        const reason = aas.reason as Error;
        this.error = reason instanceof CatalogUnreachable
          ? `${reason.message} (${reason.detail}). Games are still recognised from the local catalog.`
          : reason.message;
      }
    }
    this.quick.clear();
    this.recognise();
    const queue = [...all.values()].flatMap(game => {
      const old = this.info.get(game.groupKey);
      if (!force && old?.hasCover && Date.now() - Date.parse(old.fetchedAt) < TTL) return [];
      const aas = matchAas(game.name, this.entries);
      const box = matchAas(aas?.title ?? game.name, this.launchBox);
      return aas || box ? [{ game, aas, box, old }] : [];
    });
    if (this.error && !this.launchBox.length) return;
    const progress = this.progress = { done: 0, total: queue.length };
    let failures = 0;
    const run = async () => {
      while (!signal.aborted) {
        const item = queue.shift();
        if (!item) return;
        const { game, aas, box, old } = item;
        const fallback = aas ?? box!;
        let info = old ?? indexInfo(fallback, new Date().toISOString());
        let aasCover = aas?.cover;
        let ok = false;

        if (aas && aasOnline) {
          try {
            const html = (await this.request(aas.url, 2 * 1024 * 1024, signal)).bytes.toString('utf8');
            info = { ...parseAasDetails(html, aas), ...(old?.coverSourceUrl ? { coverSourceUrl: old.coverSourceUrl } : {}) };
            aasCover = /"image"\s*:\s*"(https:\/\/allaboutsymbian\.com\/images\/ngage\/[^"]+)"/.exec(html)?.[1] ?? aasCover;
            ok = true;
          } catch (error) {
            if (error instanceof CatalogUnreachable) aasOnline = false;
          }
        }
        info = { ...info, hasCover: !!this.cover(game.groupKey) };
        if (!info.hasCover) {
          for (const cover of [box?.cover ? { url: box.cover, source: box.url } : null, aasOnline && aasCover && aas ? { url: aasCover, source: aas.url } : null]) {
            if (!cover || signal.aborted) continue;
            try {
              const { bytes } = await this.request(cover.url, 4 * 1024 * 1024, signal);
              const valid = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
                || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                || (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
              if (!valid) continue;
              const dest = path.join(this.dir, `${game.groupKey}.img`);
              writeFileSync(dest + '.tmp', bytes);
              renameSync(dest + '.tmp', dest);
              info.hasCover = true;
              if (cover.source !== info.sourceUrl) info.coverSourceUrl = cover.source;
              ok = true;
              break;
            } catch { /* the next source or the local catalog is still available */ }
          }
        }
        if (!info.hasCover && (aasCover || box?.cover)) failures++;
        // Missing covers stay eligible for a later run, even when the index is fresh.
        if (ok || info.hasCover) this.info.set(game.groupKey, { ...info, fetchedAt: ok ? new Date().toISOString() : info.fetchedAt });
        progress.done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(queue.length, 6) }, run));
    if (signal.aborted || failures) this.error ??= 'Some covers could not be refreshed. Saved metadata and covers are still available.';
    const dest = path.join(this.dir, 'catalog.json');
    writeFileSync(dest + '.tmp', JSON.stringify({ entries: this.live ? this.entries : [], launchBox: this.launchBox, updatedAt: this.lastIndex, info: [...this.info] }));
    renameSync(dest + '.tmp', dest);
  }
}

class CatalogUnreachable extends Error { constructor(message: string, readonly detail: string) { super(message); } }
