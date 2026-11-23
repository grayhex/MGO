import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import type { ArchiveBuild, ArchiveStatus } from '@mgo/protocol';
import { UploadError } from '../jar.js';

const project = 'toca-1/new-j2me-software-archive-search';
export const SEARCH_URL = 'https://toca-1.github.io/new-j2me-software-archive-search/';
export const SOURCE = {
  version: 'index-v2',
  csv: `https://github.com/${project}/releases/download/index-v2/jarchive-combined-verified-v2.csv.gz`,
  checksum: 'ce4e1203c70291e8c601ae2251ab84cdae8aa7fe76bef6126ac36c6d5c9402f8',
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

export class ArchiveIndex {
  readonly info: NonNullable<ArchiveStatus['index']>;
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file, { readOnly: true });
    try {
      const schema = this.db.prepare('PRAGMA user_version').get()?.user_version;
      const info = this.db.prepare('SELECT version,builtAt,builds FROM info').get() as Omit<NonNullable<ArchiveStatus['index']>, 'bytes'> | undefined;
      if (schema !== 1 || !info?.version || !info.builds) throw new Error('Archive index version mismatch. Rebuild the index in Settings.');
      this.info = { ...info, bytes: statSync(file).size };
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  get(sha: string): ArchiveBuild | null {
    return this.db.prepare(`SELECT ${columns} FROM builds b WHERE sha256=?`).get(sha) as unknown as ArchiveBuild ?? null;
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

  candidates(title: string, vendor: string, version: string, except: string): ArchiveBuild[] {
    const titleKey = normalized(title);
    const vendorKey = normalized(vendor);
    if (!titleKey || !vendorKey || vendorKey === 'unknown') return [];
    return this.db.prepare(`SELECT ${columns} FROM builds b WHERE titleKey = ? AND vendorKey = ? AND sha256 != ?
      ORDER BY (version = ?) DESC, id LIMIT 12`).all(titleKey, vendorKey, except, version) as unknown as ArchiveBuild[];
  }
}
