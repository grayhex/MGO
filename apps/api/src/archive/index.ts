import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import type { ArchiveBuild, ArchiveStatus } from '@mgo/protocol';
import { UploadError } from '../jar.js';
import { cleanTitle, cleanVendor } from '../title.js';

const project = 'toca-1/new-j2me-software-archive-search';
export const SEARCH_URL = 'https://toca-1.github.io/new-j2me-software-archive-search/';
export const SOURCE = {
  version: 'index-v2',
  records: `https://raw.githubusercontent.com/${project}/d0775dcca7061a5e64584f03ae18b21a3ca3546f/data`,
  rows: 817643,
  builds: 621715,
};

export const MIB = 1024 * 1024;
export const PAGE_SIZE = 20;
export const SHA256 = /^[a-f0-9]{64}$/;
const fields = ['sha256', 'sha1', 'crc32', 'size', 'filename', 'collection', 'archivePath', 'archiveFile', 'title', 'vendor', 'version', 'cldc', 'midp'] as const;
const columns = fields.map(f => `b.${f}`).join(',');
export const normalized = (s: string): string => (s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
const titleAliases = new Map([
  ['ewjim', 'earthwormjim'],
  ['asphalturbangt2', 'asphalt2'],
  ['asphalt3', 'asphalt3streetrules'],
  ['asphalt6', 'asphalt6adrenaline'],
  ['dawnofsorrow', 'castlevaniadawnofsorrow'],
  ['duke3d', 'dukenukemmobile3d'],
  ['ageofempiresii', 'ageofempires2'],
]);

/** Compare titles across Java ME manifests without losing sequel numbers or the 3D edition marker. */
export const archiveTitleKey = (title: string) => {
  const key = normalized(cleanTitle(title)).replaceAll(' ', '');
  return titleAliases.get(key) ?? key;
};

export function archiveVendorKey(vendor: string): string {
  const key = normalized(cleanVendor(vendor)).replace(/\b(?:provided|supplied|cracked|translated|repacked) by\b.*$/, '').trim();
  const publishers = [
    [/\bgameloft\b/, 'gameloft'], [/\b(?:electronic arts|ea mobile)\b/, 'electronic arts'],
    [/\b(?:hands on(?: mobile)?|mforma)\b/, 'handson mobile'], [/\b(?:namco|nbgi|nbne)\b/, 'namco'],
    [/\btaito\b/, 'taito'], [/\bglu(?: mobile)?\b/, 'glu'], [/\bcodemasters\b/, 'codemasters'],
    [/\b(?:warner bros|warner brothers)\b/, 'warner bros'], [/\b(?:vivendi|vugames|vug)\b/, 'vivendi'],
    [/\b(?:konami|capcom|nokia|popcap|thq|digital chocolate|fishlabs|sega)\b/, ''],
  ] as const;
  for (const [pattern, family] of publishers) {
    const match = key.match(pattern)?.[0];
    if (match) return family || match;
  }
  return key.replace(/^(?:c|copyright)\s+(?:\d{4}\s+)?/, '').replace(/\s+(?:inc|corp|ltd|llc|limited|s a|sa|gmbh)$/, '') || 'unknown';
}

export class ArchiveIndex {
  readonly info: NonNullable<ArchiveStatus['index']>;
  private db: DatabaseSync;
  private bySha: StatementSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file, { readOnly: true });
    try {
      const schema = this.db.prepare('PRAGMA user_version').get()?.user_version;
      const info = this.db.prepare('SELECT version,builtAt,builds FROM info').get() as Omit<NonNullable<ArchiveStatus['index']>, 'bytes'> | undefined;
      if (schema !== 1 || !info?.version || !info.builds) throw new Error('Archive index version mismatch. Rebuild the index in Settings.');
      this.info = { ...info, bytes: statSync(file).size };
      this.bySha = this.db.prepare(`SELECT ${columns} FROM builds b WHERE sha256=?`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  get(sha: string): ArchiveBuild | null {
    return this.bySha.get(sha) as unknown as ArchiveBuild ?? null;
  }

  search(query: string, within: string, page: number): { builds: ArchiveBuild[]; more: boolean } {
    if (!Number.isInteger(page) || page < 0 || page > 49) throw new UploadError('archive_page', 'Choose a page between 1 and 50');
    const hash = query.trim().toLowerCase();
    const hashColumn = SHA256.test(hash) ? 'sha256' : /^[a-f0-9]{40}$/.test(hash) ? 'sha1' : /^[a-f0-9]{8}$/.test(hash) ? 'crc32' : null;
    const words = normalized(query).split(' ').filter(Boolean).slice(0, 8);
    const refinement = normalized(within).split(' ').filter(Boolean).slice(0, 8);
    if (!hashColumn && words.join('').length < 2) return { builds: [], more: false };
    const terms = [...(hashColumn ? [] : words), ...refinement].map(s => `"${s}"*`).join(' AND ');
    const params = [...(terms ? [terms] : []), ...(hashColumn ? [hash] : []), PAGE_SIZE + 1, page * PAGE_SIZE];
    // Every interpolated SQL identifier is fixed by the selected search mode.
    const sql = `SELECT ${columns} FROM ${terms ? 'search JOIN builds b ON b.id=search.rowid' : 'builds b'}
      WHERE ${[terms && 'search MATCH ?', hashColumn && `b.${hashColumn}=?`].filter(Boolean).join(' AND ')}
      ORDER BY ${terms ? 'search.rank,' : ''}b.id LIMIT ? OFFSET ?`;
    const builds = this.db.prepare(sql).all(...params) as unknown as ArchiveBuild[];
    return { builds: builds.slice(0, PAGE_SIZE), more: page < 49 && builds.length > PAGE_SIZE };
  }

  curatedCandidates(title: string, directSizes: number[] = []): { builds: ArchiveBuild[]; suggested: string | null } {
    const key = normalized(title);
    const canonical = archiveTitleKey(title);
    const vendors = this.db.prepare(`SELECT vendorKey,count(*) AS count FROM builds WHERE titleKey=?
      GROUP BY vendorKey ORDER BY count DESC,vendorKey LIMIT 256`).all(key) as unknown as { vendorKey: string; count: number }[];
    if (vendors.length) {
      const families = new Map<string, { count: number; keys: string[] }>();
      for (const row of vendors) {
        const family = archiveVendorKey(row.vendorKey);
        const entry = families.get(family) ?? { count: 0, keys: [] };
        entry.count += row.count;
        entry.keys.push(row.vendorKey);
        families.set(family, entry);
      }
      const ranked = [...families].sort((a, b) => b[1].count - a[1].count);
      const [vendor, best] = ranked[0]!;
      const keys = best.keys.slice(0, 32);
      const sizes = directSizes.slice(0, 32);
      const directOrder = sizes.length ? `(size IN (${sizes.map(() => '?').join(',')})) DESC,` : '';
      const builds = this.db.prepare(`SELECT ${columns} FROM builds b WHERE titleKey=?
        ORDER BY (vendorKey IN (${keys.map(() => '?').join(',')})) DESC,
          ${directOrder} (collection = '96x65pixels J2ME mini') DESC, (filename LIKE '%240x320%') DESC, id LIMIT 24`).all(key, ...keys, ...sizes) as unknown as ArchiveBuild[];
      const preferred = vendor !== 'unknown' && best.count > (ranked[1]?.[1].count ?? 0) * 2;
      return { builds, suggested: preferred ? builds[0]?.sha256 ?? null : null };
    }
    const searchTitle = key === 'ewjim' ? 'Earthworm Jim' : title;
    const wordBuilds = this.search(searchTitle, '', 0).builds;
    const compactBuilds = this.search(canonical, '', 0).builds;
    const builds = [...new Map([...wordBuilds, ...compactBuilds].map(build => [build.sha256, build])).values()];
    const exact = builds.filter(build => archiveTitleKey(build.title) === canonical);
    // The FTS result is only a sample, but if there is exactly one publisher among exact titles it can be tried safely.
    const publisher = exact[0] && archiveVendorKey(exact[0].vendor);
    const suggestion = publisher && publisher !== 'unknown' && exact.every(build => archiveVendorKey(build.vendor) === publisher) ? exact[0] : undefined;
    return { builds: [...exact, ...builds.filter(build => !exact.includes(build))].slice(0, 24), suggested: suggestion?.sha256 ?? null };
  }

  candidates(title: string, vendor: string, version: string, except: string): ArchiveBuild[] {
    const titleKey = normalized(title);
    const vendorKey = normalized(vendor);
    if (!titleKey || !vendorKey || vendorKey === 'unknown') return [];
    return this.db.prepare(`SELECT ${columns} FROM builds b WHERE titleKey = ? AND vendorKey = ? AND sha256 != ?
      ORDER BY (version = ?) DESC, id LIMIT 12`).all(titleKey, vendorKey, except, version) as unknown as ArchiveBuild[];
  }
}
