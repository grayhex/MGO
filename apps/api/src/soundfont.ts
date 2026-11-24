import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { SOUNDFONT_MAX_BYTES, SOUNDFONT_MAX_MB, type SoundfontInfo } from '@mgo/protocol';
import { UploadError } from './jar.js';

const bankId = /^(?:custom|[0-9a-f]{32})$/;

/** Uploaded banks are immutable. Switching the selected bank only affects subsequently launched sessions. */
export class SoundfontStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'soundfont');
  }

  private dataPath(id: string): string { return path.join(this.dir, `${id}.sf2`); }
  private metaPath(id: string): string { return path.join(this.dir, `${id}.json`); }

  private active(): string | null {
    try {
      const id: unknown = JSON.parse(readFileSync(this.metaPath('active'), 'utf8'));
      return typeof id === 'string' && bankId.test(id) ? id : null;
    } catch {
      return existsSync(this.dataPath('custom')) ? 'custom' : null;
    }
  }

  private bank(id: string): SoundfontInfo | null {
    if (!bankId.test(id)) return null;
    const file = this.dataPath(id);
    try {
      const stats = statSync(file);
      const m = existsSync(this.metaPath(id)) ? JSON.parse(readFileSync(this.metaPath(id), 'utf8')) as Partial<SoundfontInfo> : null;
      if (m && typeof m.name === 'string' && typeof m.updatedAt === 'string') return { id, name: m.name, size: stats.size, updatedAt: m.updatedAt };
      if (id === 'custom' && !sf2Problem(file)) return { id, name: 'custom.sf2', size: stats.size, updatedAt: stats.mtime.toISOString() };
      return null;
    } catch {
      return null;
    }
  }

  info(): SoundfontInfo | null {
    const id = this.active();
    return id ? this.bank(id) : null;
  }

  list(): SoundfontInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter(file => file.endsWith('.sf2')).map(file => this.bank(file.slice(0, -4)))
      .filter((bank): bank is SoundfontInfo => bank !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Absolute path of the bank, or null when none is installed. */
  path(): string | null {
    const active = this.info();
    return active ? this.dataPath(active.id) : null;
  }

  select(id: unknown): void {
    if (id !== null && (typeof id !== 'string' || !this.bank(id))) throw new UploadError('soundfont_not_found', 'SoundFont not found', 404);
    mkdirSync(this.dir, { recursive: true, mode: 0o750 });
    const tmp = path.join(this.dir, `selection-${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(id), { mode: 0o640 });
      renameSync(tmp, this.metaPath('active'));
    } finally { rmSync(tmp, { force: true }); }
  }

  /** Streams and verifies the SF2, then makes the new bank available for selection. */
  async save(src: Readable & { truncated?: boolean }, filename: string): Promise<SoundfontInfo> {
    const name = cleanName(filename);
    if (!/\.sf2$/i.test(name)) throw new UploadError('unsupported_format', 'Only SoundFont 2 files (.sf2) are supported; .sf3 and other formats cannot be used by the emulator', 400);
    mkdirSync(this.dir, { recursive: true, mode: 0o750 });
    const id = randomUUID().replaceAll('-', '');
    const file = this.dataPath(id);
    const tmp = file + '.tmp';
    try {
      await pipeline(src, createWriteStream(tmp, { mode: 0o640 }));
      const { size } = statSync(tmp);
      if (src.truncated || size > SOUNDFONT_MAX_BYTES) throw new UploadError('too_large', `The SoundFont is larger than ${SOUNDFONT_MAX_MB} MB`, 413);
      const problem = sf2Problem(tmp);
      if (problem) throw new UploadError('invalid_soundfont', problem, 400);
      renameSync(tmp, file);
      const info = { id, name, size, updatedAt: new Date().toISOString() };
      writeFileSync(this.metaPath(id), JSON.stringify(info), { mode: 0o640 });
      this.select(id);
      return info;
    } catch (error) {
      rmSync(file, { force: true });
      rmSync(this.metaPath(id), { force: true });
      throw error;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  remove(id = this.active()): void {
    if (!id) return;
    if (!this.bank(id)) throw new UploadError('soundfont_not_found', 'SoundFont not found', 404);
    if (this.active() === id) this.select(null);
    rmSync(this.dataPath(id), { force: true });
    rmSync(this.metaPath(id), { force: true });
  }
}

function cleanName(filename: string): string {
  // eslint-disable-next-line no-control-regex
  return path.basename(filename.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'soundfont.sf2';
}

/** A SoundFont is a RIFF file of form type `sfbk` whose declared length fits the file. Returns the problem, or null. */
function sf2Problem(file: string): string | null {
  const size = statSync(file).size;
  if (size < 12) return 'The file is too small to be a SoundFont';
  const head = Buffer.alloc(12);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'sfbk') return 'This is not a SoundFont 2 file (RIFF "sfbk" header expected)';
  if (head.readUInt32LE(4) + 8 > size) return 'The SoundFont file is incomplete (shorter than its header says)';
  return null;
}
