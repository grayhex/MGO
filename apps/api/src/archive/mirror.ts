import { createHash } from 'node:crypto';
import type { ArchiveBuild } from '@mgo/protocol';
import { normalized } from './index.js';
import { readRemote } from './remote.js';

const repository = 'M5-Dev/j2me-vault';
const revision = '251c5e6409242e1f36585e4c86823b98cf1683d8';
const hub = 'https://huggingface.co';
const treePath = `/api/datasets/${repository}/tree/${revision}/Games`;
const allowsJar = ({ hostname }: URL) => /^(?:(?:cdn-lfs(?:-[a-z0-9]+)?\.)?huggingface\.co|cas-bridge\.xethub\.hf\.co|[a-z]+\.aws\.cdn\.hf\.co)$/.test(hostname);
const nameKey = (name: string) => normalized(name.replace(/\.jar$/i, '').replace(/[-_ ](?:\d{2,4}x\d{2,4}|\d{2,3})$/i, '')).replaceAll(' ', '');
interface FileEntry { path: string; size: number; sha?: string }

/** The tree contains sizes and LFS SHA-256 values. Small Git blobs carry only a Git object ID. */
class VaultFiles {
  readonly byHash = new Map<string, FileEntry>();
  private bySize = new Map<number, FileEntry[]>();
  add(entry: FileEntry) {
    if (entry.sha) this.byHash.set(entry.sha, entry);
    else {
      const files = this.bySize.get(entry.size) ?? [];
      files.push(entry);
      this.bySize.set(entry.size, files);
    }
  }
  candidates(build: ArchiveBuild): FileEntry[] {
    const exact = this.byHash.get(build.sha256);
    if (exact) return [exact];
    const names = [nameKey(build.filename), nameKey(build.title)].filter(Boolean);
    const sameSize = this.bySize.get(build.size) ?? [];
    const likely = sameSize.filter(file => names.includes(nameKey(file.path.slice(6))));
    return (likely.length ? likely : sameSize.length <= 2 ? sameSize : []).slice(0, 2);
  }
}

export class JarMirror {
  private cached?: { until: number; files: Promise<VaultFiles | null> };
  constructor(private fetcher: typeof fetch = fetch) {}

  catalog() {
    if (this.cached && Date.now() < this.cached.until) return this.cached.files;
    const cache = { until: Date.now() + 24 * 60 * 60_000, files: this.list().catch(() => {
      cache.until = Date.now() + 5 * 60_000;
      return null;
    }) };
    this.cached = cache;
    return cache.files;
  }

  private async list() {
    const signal = AbortSignal.timeout(20_000);
    let url = new URL(treePath + '?limit=1000', hub);
    const files = new VaultFiles();
    for (let page = 0; page < 10; page++) {
      const { bytes, headers } = await readRemote(this.fetcher, url, at => at.origin === hub && at.pathname === treePath, 1024 * 1024, signal);
      const rows: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(rows)) throw new Error('Invalid J2ME Vault listing');
      for (const row of rows) {
        if (row?.type !== 'file' || typeof row.path !== 'string' || !/^Games\/[^/\\\x00-\x1f]+\.jar$/i.test(row.path)
            || !Number.isSafeInteger(row.size) || row.size < 1) continue;
        const sha = row.lfs?.oid;
        if (row.lfs && (typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha) || row.lfs.size !== row.size)) continue;
        files.add({ path: row.path, size: row.size, ...(sha ? { sha } : {}) });
      }
      const next = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '')?.[1];
      if (!next) return files;
      url = new URL(next, hub);
    }
    throw new Error('J2ME Vault listing has too many pages');
  }

  async download(build: ArchiveBuild, signal: AbortSignal): Promise<Buffer | null> {
    const files = await this.catalog();
    signal.throwIfAborted();
    if (!files) return null;
    for (const file of files.candidates(build)) {
      if (file.size !== build.size) continue;
      const filename = encodeURIComponent(file.path.slice(6)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
      const url = new URL(`/datasets/${repository}/resolve/${revision}/Games/${filename}`, hub);
      try {
        const { bytes } = await readRemote(this.fetcher, url, allowsJar, build.size, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
        if (bytes.length === build.size && createHash('sha256').update(bytes).digest('hex') === build.sha256) return bytes;
      } catch { signal.throwIfAborted(); }
    }
    return null;
  }
}
