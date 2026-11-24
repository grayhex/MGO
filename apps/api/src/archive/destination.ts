import { accessSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import { UploadError } from '../jar.js';
import { MIB } from './index.js';

export const managedRoot = (cfg: Config): string => path.join(cfg.dataDir, 'import');

export function writable(dir: string): boolean {
  try {
    if (realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) return false;
    accessSync(dir, constants.W_OK | constants.X_OK);
    return true;
  } catch { return false; }
}

export function assertSpace(dir: string, bytes: number): void {
  const stats = statfsSync(dir);
  if (stats.bavail * stats.bsize < bytes + 16 * MIB) throw new UploadError('archive_disk_full', 'Not enough free space for this archive operation', 507);
}

export function folderSegments(folder: string): string[] {
  const segments = folder.split('/');
  if (segments.length > 8 || segments.some(segment => Buffer.byteLength(segment) > 96 || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(segment) || segment.trimEnd() !== segment)) {
    throw new UploadError('archive_bad_folder', 'Choose a relative subfolder, for example Games/Racing');
  }
  return segments;
}

/** Keep each open directory pinned while making child paths. O_NOFOLLOW also rejects a symlink swapped in during traversal. */
export function withDestination<T>(root: string, segments: string[], action: (dir: string) => T, create = true): T {
  if (!writable(root)) throw new UploadError('archive_read_only', 'The archive destination is unavailable or read-only', 403);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  const fds: number[] = [];
  try {
    fds.push(openSync(root, flags));
    let dir = `/proc/self/fd/${fds[0]}`;
    for (const name of segments) {
      const child = path.join(dir, name);
      if (create) {
        try { mkdirSync(child, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      fds.push(openSync(child, flags));
      dir = `/proc/self/fd/${fds.at(-1)}`;
    }
    return action(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR' || code === 'ELOOP') throw new UploadError('archive_bad_folder', 'The destination contains a symlink or a non-directory');
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new UploadError('archive_read_only', 'The archive destination is unavailable or read-only', 403);
    if (code === 'ENOSPC' || code === 'EDQUOT') throw new UploadError('archive_disk_full', 'Not enough free space for this archive operation', 507);
    throw error;
  } finally {
    for (const fd of fds.reverse()) closeSync(fd);
  }
}

export const publishedJarName = (name: string, sha: string): boolean =>
  / \[([a-f0-9]{12})(?:-(?:[2-9]|10))?\]\.jar$/i.exec(name)?.[1] === sha.slice(0, 12);

export function removePublishedJar(root: string, relative: string, sha: string, size: number): void {
  const name = path.basename(relative);
  if (!publishedJarName(name, sha)) throw new UploadError('archive_bad_folder', 'The downloaded file path is invalid', 409);
  try {
    withDestination(root, folderSegments(path.dirname(relative)), dir => {
      const file = path.join(dir, name);
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        const verified = stat.isFile() && stat.size === size && createHash('sha256').update(readFileSync(fd)).digest('hex') === sha;
        const current = lstatSync(file);
        if (!verified || current.ino !== stat.ino || current.dev !== stat.dev || current.mtimeMs !== stat.mtimeMs) {
          throw new UploadError('archive_file_changed', 'The downloaded JAR has changed. Remove it manually if you still want to delete it.', 409);
        }
        unlinkSync(file);
      } finally { closeSync(fd); }
    }, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function publishJar<T>(dir: string, filename: string, sha: string, bytes: Buffer, importJar: (name: string, mtimeMs: number) => T): T {
  const stem = Array.from(filename.replace(/\.jar$/i, '').replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^[ .]+|[ .]+$/g, '')).slice(0, 42).join('') || 'game';
  const temporary = path.join(dir, `.mgo-${randomUUID()}.part`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const written = fstatSync(fd);
    for (let attempt = 0; attempt < 10; attempt++) {
      const base = `${stem} [${sha.slice(0, 12)}${attempt ? `-${attempt + 1}` : ''}]`;
      const name = base + '.jar';
      const final = path.join(dir, name);
      if (existsSync(path.join(dir, base + '.jad'))) continue;
      try { linkSync(temporary, final); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let existing: number | undefined;
        try {
          existing = openSync(final, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = fstatSync(existing);
          if (stat.isFile() && stat.size === bytes.length && bytes.equals(readFileSync(existing))) return importJar(name, stat.mtimeMs);
        } catch (cause) {
          if (cause instanceof UploadError) throw cause;
          if (existing !== undefined) throw cause;
        } finally {
          if (existing !== undefined) closeSync(existing);
        }
        continue;
      }
      try { return importJar(name, written.mtimeMs); }
      catch (error) {
        const current = lstatSync(final, { throwIfNoEntry: false });
        if (current?.dev === written.dev && current.ino === written.ino) unlinkSync(final);
        throw error;
      }
    }
    throw new UploadError('archive_collision', 'A file with this name already exists. Choose another subfolder.', 409);
  } finally {
    closeSync(fd);
    unlinkSync(temporary);
  }
}
