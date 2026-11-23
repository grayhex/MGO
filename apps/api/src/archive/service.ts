import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveBuild, ArchiveDownload, ArchiveSearchItem, ArchiveStatus, ArchiveTransfer, CuratedTitle, CuratedImport } from '@mgo/protocol';
import type { Config } from '../config.js';
import { javaGroupKey, type Library } from '../library.js';
import type { ScanManager } from '../scanner.js';
import { parseJar, UploadError } from '../jar.js';
import { assertSpace, folderSegments, managedRoot, publishJar, withDestination, writable } from './destination.js';
import { ArchiveIndex, MIB, SHA256, SOURCE } from './index.js';
import { ArchiveMatching } from './matching.js';

export type ArchiveWorker = (args: string[], workspace: string, proxy: string, signal: AbortSignal, progress: (line: string) => void) => Promise<void>;
type Job = { abort: AbortController; task: Promise<void> };
const DOWNLOAD_BUDGET = 512 * MIB;
const curatedPath = fileURLToPath(new URL('../../archive-tools/java_curated_top.txt', import.meta.url));
const workerPath = fileURLToPath(new URL('../../archive-tools/worker.py', import.meta.url));

export const runArchiveWorker: ArchiveWorker = (args, workspace, proxy, signal, progress) => new Promise((resolve, reject) => {
  const child = spawn('python3', ['-B', workerPath, ...args], {
    cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TMPDIR: workspace, SQLITE_TMPDIR: workspace, MGO_ARCHIVE_PROXY_URL: proxy },
  });
  let output = '';
  let pending = '';
  const kill = () => {
    if (child.pid) {
      // Include any curl processes spawned by the worker.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  };
  const timeout = setTimeout(kill, args[0] === 'index' ? 30 * 60_000 : 370_000);
  signal.addEventListener('abort', kill, { once: true });
  if (signal.aborted) kill();
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    pending = (pending + chunk).slice(-8192);
    const lines = pending.split(/[\r\n]+/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line) progress(line.trim());
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output = (output + chunk).slice(-2048); });
  child.once('error', error => {
    reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('Python 3 or the archive worker is unavailable') : error);
  });
  child.once('close', (code, sig) => {
    clearTimeout(timeout);
    signal.removeEventListener('abort', kill);
    if (code === 0) return resolve();
    const message = output.trim().split('\n').at(-1)?.replace(/^[a-zA-Z.]+(?:Error|Exception):\s*/, '');
    reject(new Error(message || (sig ? 'Archive worker was interrupted or reached its resource limit' : 'Archive source is unavailable')));
  });
});

export class ArchiveService {
  readonly matching: ArchiveMatching;
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly stage: string;
  private readonly maxIndex: number;
  private index: ArchiveIndex | null = null;
  private indexJob: ArchiveTransfer | null = null;
  private download: ArchiveDownload | null = null;
  private job: Job | null = null;
  private attemptedAt = 0;
  private curated: CuratedImport | null = null;
  private curatedTask: Promise<void> | null = null;
  private curatedAbort: AbortController | null = null;
  private curatedPlan: { index: ArchiveIndex; rows: Promise<CuratedTitle[]> } | null = null;

  constructor(private cfg: Config, private library: Library, private scanner: ScanManager, private worker: ArchiveWorker = runArchiveWorker) {
    this.matching = new ArchiveMatching(library);
    this.dir = path.join(cfg.dataDir, 'j2me-archive');
    this.indexPath = path.join(this.dir, 'index.sqlite');
    this.stage = path.join(this.dir, '.build');
    this.maxIndex = cfg.archiveIndexBytes ?? 1024 * MIB;
    // Interrupted index publishes never replace the installed database.
    rmSync(this.stage, { recursive: true, force: true });
    if (existsSync(this.indexPath)) {
      try { this.index = new ArchiveIndex(this.indexPath); }
      catch { this.indexJob = { state: 'failed', phase: 'finished', message: 'Archive index version mismatch. Rebuild the index in Settings.' }; }
    }
  }

  status(): ArchiveStatus {
    const managed = managedRoot(this.cfg);
    const external = this.cfg.archiveWritableRoot;
    return { availableVersion: SOURCE.version, index: this.index?.info ?? null, indexJob: this.indexJob, matchJob: this.matching.current(),
      maxIndexBytes: this.maxIndex, writableRoots: [
        { id: 'managed', label: 'Managed Java ME library', writable: writable(existsSync(managed) ? managed : this.cfg.dataDir) },
        ...(external ? [{ id: 'external' as const, label: external, writable: writable(external) }] : []),
      ],
    };
  }

  requireIndex(): ArchiveIndex {
    if (!this.index) throw new UploadError('archive_index_missing', 'Install the J2ME Archive index in Settings', 409);
    return this.index;
  }

  private ensureIdle(fromCurated = false): void {
    if (this.job || this.matching.isRunning() || (this.curatedTask && !fromCurated)) throw new UploadError('archive_busy', 'Another archive operation is running', 409);
  }

  private start(report: ArchiveTransfer, action: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController();
    const task = Promise.resolve().then(() => action(abort.signal)).then(() => {
      report.state = 'done';
      report.message = null;
    }).catch((error: unknown) => {
      report.state = abort.signal.aborted ? 'cancelled' : 'failed';
      report.message = abort.signal.aborted ? null : (error as Error).message;
    }).finally(() => {
      report.phase = 'finished';
      this.job = null;
    });
    this.job = { abort, task };
  }

  private proxy(): string { return process.env.MGO_ARCHIVE_PROXY_URL ?? process.env.MGO_METADATA_GATEWAY ?? process.env.AAS_PROXY_URL ?? ''; }

  installIndex(): ArchiveTransfer {
    this.ensureIdle();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    assertSpace(this.dir, this.maxIndex + 160 * MIB);
    const report: ArchiveTransfer = { state: 'running', phase: 'fetching', processed: 0, total: SOURCE.builds, message: null };
    this.indexJob = report;
    this.start(report, async signal => {
      mkdirSync(this.stage, { mode: 0o700 });
      const staged = path.join(this.stage, 'index.sqlite');
      try {
        await this.worker(['index', staged, SOURCE.csv, SOURCE.checksum, SOURCE.records, SOURCE.version, String(SOURCE.rows), String(SOURCE.builds), String(this.maxIndex)], this.stage, this.proxy(), signal, line => {
          const match = /^index (\d+) (\d+)$/.exec(line);
          if (match) { report.processed = Number(match[1]); report.phase = 'verifying'; }
        });
        signal.throwIfAborted();
        const replacement = new ArchiveIndex(staged);
        try {
          if (replacement.info.version !== SOURCE.version || replacement.info.builds !== SOURCE.builds || replacement.info.bytes > this.maxIndex) throw new Error('Archive index version mismatch');
          renameSync(staged, this.indexPath);
        } catch (error) {
          replacement.close();
          throw error;
        }
        this.index?.close();
        this.index = replacement;
      } finally {
        rmSync(this.stage, { recursive: true, force: true });
      }
    });
    return report;
  }

  removeIndex(): void {
    this.ensureIdle();
    rmSync(this.indexPath, { force: true });
    rmSync(path.join(this.dir, '.download'), { recursive: true, force: true });
    this.index?.close();
    this.index = null;
    this.indexJob = null;
  }

  cancel(kind: 'index' | 'download'): boolean {
    const report = kind === 'index' ? this.indexJob : this.download;
    if (!this.job || report?.state !== 'running') return false;
    this.job.abort.abort();
    return true;
  }

  startMatch(resume: boolean) {
    this.ensureIdle();
    return this.matching.start(this.requireIndex(), resume);
  }

  search(query: string, within: string, page: number): { builds: ArchiveSearchItem[]; more: boolean } {
    const { builds, more } = this.requireIndex().search(query, within, page);
    return { builds: builds.map(build => this.decorate(build)), more };
  }

  detail(sha: string) {
    const index = this.requireIndex();
    const build = index.get(sha);
    if (!build) throw new UploadError('archive_build_missing', 'This build was not found in the installed archive index', 404);
    return { build: this.decorate(build), alternatives: index.candidates(build.title, build.vendor, build.version, sha).map(other => this.decorate(other)), indexVersion: index.info.version };
  }

  private decorate(build: ArchiveBuild): ArchiveSearchItem {
    const existing = this.library.findBySha(build.sha256);
    // The library's existing identity rule keeps alternate builds under the same title.
    const group = existing?.groupKey ?? (build.title && build.vendor
      ? javaGroupKey(build.title, build.vendor) : null);
    const count = group ? this.library.db.prepare("SELECT count(*) AS count FROM games WHERE platform='j2me' AND group_key=? AND sha256!=?").get(group, build.sha256)?.count : 0;
    return { ...build, gameId: existing?.id ?? null, otherBuildsInLibrary: Number(count ?? 0) };
  }

  currentDownload(): ArchiveDownload | null { return this.download; }

  startDownload(sha: string, rootId: string, folder: string, fromCurated = false): ArchiveDownload {
    this.ensureIdle(fromCurated);
    if (!SHA256.test(sha)) throw new UploadError('archive_bad_hash', 'Select a valid SHA-256 from the archive');
    const index = this.requireIndex();
    const build = index.get(sha);
    if (!build) throw new UploadError('archive_build_missing', 'This build was not found in the installed archive index', 404);
    const segments = folderSegments(folder);
    const root = rootId === 'managed' ? managedRoot(this.cfg) : rootId === 'external' ? this.cfg.archiveWritableRoot : null;
    if (!root) throw new UploadError('archive_bad_root', 'Choose an allowed upload destination');
    const existing = this.library.findBySha(sha);
    const report: ArchiveDownload = { sha256: sha, state: 'running', phase: 'fetching', message: null, gameId: existing?.id ?? null, duplicate: !!existing };
    if (existing) {
      this.matching.exact(existing.id, index.info.version, build);
      this.download = { ...report, state: 'done', phase: 'finished' };
      return this.download;
    }

    if (!fromCurated && Date.now() - this.attemptedAt < 2000) throw new UploadError('archive_rate_limit', 'Wait two seconds before downloading another build', 429);
    if (build.size > this.cfg.maxUploadBytes) throw new UploadError('too_large', 'The archive JAR exceeds the Java ME upload limit', 413);
    if (build.size + this.library.totalBytes() > this.cfg.libraryQuotaBytes) throw new UploadError('quota_exceeded', 'Library quota exceeded; delete some games first', 507);
    if (rootId === 'managed') mkdirSync(root, { mode: 0o700, recursive: true });
    withDestination(root, segments, dir => assertSpace(dir, build.size));
    mkdirSync(this.dir, { mode: 0o700, recursive: true });
    assertSpace(this.dir, DOWNLOAD_BUDGET + 2 * build.size);
    const staging = path.join(this.dir, '.download');
    const cacheKey = path.join(staging, 'sha256');
    let cached: string | undefined;
    try { cached = readFileSync(cacheKey, 'utf8'); } catch { /* no cached transfer */ }
    if (sha !== cached) rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700, recursive: true });
    writeFileSync(cacheKey, sha, { mode: 0o600 });
    const file = path.join(staging, 'verified.jar');
    rmSync(file, { force: true });
    this.attemptedAt = Date.now();
    this.download = report;
    this.start(report, async signal => {
      try {
        await this.worker(['download', sha, file, path.join(staging, 'cache'), String(Math.min(64, Math.ceil(this.cfg.maxUploadBytes / MIB)))], staging, this.proxy(), signal, line => {
          report.message = line.slice(0, 300);
          if (fromCurated && this.curated) this.curated.progress = report.message;
        });
        signal.throwIfAborted();
        report.phase = 'verifying';
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size !== build.size) throw new Error('Downloaded JAR size mismatch');
        const bytes = await readFile(file);
        if (bytes.length !== build.size || createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('Downloaded JAR SHA-256 mismatch');
        parseJar(bytes);
        signal.throwIfAborted();
        report.phase = 'importing';
        // It may have been uploaded while the archive job was still transferring.
        const duplicate = this.library.findBySha(sha);
        const game = duplicate ?? withDestination(root, segments, dir => publishJar(dir, build.filename, sha, bytes, (name, mtime) =>
          this.scanner.importArchiveJar(root, [...segments, name].join('/'), bytes, sha, mtime).game));
        this.matching.exact(game.id, index.info.version, build);
        report.gameId = game.id;
        report.duplicate = !!duplicate;
        rmSync(staging, { recursive: true, force: true });
      } finally {
        rmSync(file, { force: true });
      }
    });
    return report;
  }

  curatedTitles(): string[] {
    return [...new Set(readFileSync(curatedPath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  }

  async previewCurated(): Promise<CuratedTitle[]> {
    const index = this.requireIndex();
    if (this.curatedPlan?.index !== index) {
      const rows = async () => {
        const plan: CuratedTitle[] = [];
        for (const title of this.curatedTitles()) {
          await new Promise<void>(done => setImmediate(done));
          if (index !== this.index) throw new UploadError('archive_index_changed', 'The archive index changed. Refresh the list.', 409);
          const { builds, suggested } = index.curatedCandidates(title);
          plan.push({ title, builds: builds.map(build => this.decorate(build)), suggested });
        }
        return plan;
      };
      this.curatedPlan = { index, rows: rows() };
    }
    // Installed status is live even after completing an earlier import.
    return (await this.curatedPlan.rows).map(item => ({ ...item, builds: item.builds.map(build => this.decorate(build)) }));
  }

  currentCurated(): CuratedImport | null { return this.curated; }

  async importCurated(selection: { title: string; sha256: string }[]): Promise<CuratedImport> {
    this.ensureIdle();
    const index = this.requireIndex();
    const plan = new Map((await this.previewCurated()).map(row => [row.title, row]));
    this.ensureIdle();
    if (index !== this.index) throw new UploadError('archive_index_changed', 'The archive index changed. Refresh the list.', 409);
    if (!selection.length || selection.length > plan.size || new Set(selection.map(row => row.title)).size !== selection.length ||
        selection.some(row => !plan.get(row.title)?.builds.some(build => build.sha256 === row.sha256))) {
      throw new UploadError('archive_bad_selection', 'Select one available build per title from the curated list');
    }
    const report: CuratedImport = { state: 'running', total: selection.length, imported: 0, duplicates: 0, failed: [], current: null, progress: null };
    const abort = new AbortController();
    this.curated = report;
    this.curatedAbort = abort;
    this.curatedTask = this.runCurated(selection, report, abort.signal).finally(() => {
      report.state = abort.signal.aborted ? 'cancelled' : 'done';
      report.current = null;
      report.progress = null;
      this.curatedTask = null;
      this.curatedAbort = null;
    });
    return report;
  }

  private async runCurated(selection: { title: string; sha256: string }[], report: CuratedImport, signal: AbortSignal): Promise<void> {
    await new Promise<void>(done => setImmediate(done));
    for (const item of selection) {
      if (signal.aborted) break;
      report.current = item.title;
      report.progress = null;
      try {
        const job = this.startDownload(item.sha256, 'managed', 'Curated Java ME', true);
        await this.job?.task;
        if (signal.aborted) break;
        if (job.state !== 'done') throw new Error(job.message ?? 'Archive source is unavailable');
        if (job.duplicate) report.duplicates++;
        else report.imported++;
      } catch (error) {
        report.failed.push({ title: item.title, message: (error as Error).message });
      }
    }
  }

  cancelCurated(): boolean {
    if (!this.curatedAbort) return false;
    this.curatedAbort.abort();
    this.cancel('download');
    return true;
  }

  async close(): Promise<void> {
    this.cancelCurated();
    this.job?.abort.abort();
    this.matching.pause();
    await Promise.allSettled([this.job?.task, this.curatedTask, this.matching.idle()]);
    this.index?.close();
  }
}
