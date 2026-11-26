import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveBuild, ArchiveDownload, ArchiveSearchItem, ArchiveStatus, ArchiveTransfer, CuratedTitle, CuratedImport, GameMeta, JavaCatalogJob, PublicSettings } from '@mgo/protocol';
import type { Config } from '../config.js';
import { javaGroupKey, type Library } from '../library.js';
import type { ScanManager } from '../scanner.js';
import { parseJar, UploadError } from '../jar.js';
import { resolveInsideRoots } from '../libraryPath.js';
import { assertSpace, folderSegments, managedRoot, publishedJarName, publishJar, removePublishedJar, withDestination, writable } from './destination.js';
import { ArchiveIndex, archiveTitleKey as titleKey, archiveVendorKey, MIB, SHA256, SOURCE } from './index.js';
import { ArchiveMatching } from './matching.js';
import type { JarMirror } from './mirror.js';

export type ArchiveWorker = (args: string[], workspace: string, proxy: string, signal: AbortSignal, progress: (line: string) => void) => Promise<void>;
type Job = { abort: AbortController; task: Promise<void> };
type CuratedSelection = { title: string; sha256: string };
type CuratedDestination = { rootId: string; root: string; folder: string };
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
  const timeout = setTimeout(kill, args[0] === 'index' ? 30 * 60_000 : 120_000);
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
  private curatedPlan: { index: ArchiveIndex; mirror?: ReturnType<JarMirror['catalog']>; rows: Promise<CuratedTitle[]> } | null = null;

  constructor(private cfg: Config, private library: Library, private scanner: ScanManager, private worker: ArchiveWorker = runArchiveWorker, private settings?: () => PublicSettings,
    private mirror: JarMirror | null = null, private recognize?: (ids: readonly string[], signal: AbortSignal) => Promise<JavaCatalogJob | null>) {
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
    this.recoverDownloads();
  }

  private recoverDownloads() {
    const rows = this.library.db.prepare(`SELECT g.id,g.sha256,s.rel_path FROM games g JOIN sources s ON s.game_id=g.id
      JOIN archive_matches a ON a.game_id=g.id
      WHERE g.download_json IS NULL AND g.origin='import' AND g.platform='j2me'
      AND json_extract(a.match_json,'$.state')='exact' AND json_extract(a.match_json,'$.matchedSha256')=g.sha256
      AND s.sha256=g.sha256 AND s.missing=0 ORDER BY s.rel_path`).all();
    for (const row of rows) {
      const sha = String(row.sha256);
      const source = String(row.rel_path);
      if (!publishedJarName(path.basename(source), sha)) continue;
      const location = this.scanner.archiveLocation(source);
      if (location) this.library.recordDownload(String(row.id), { ...location, provider: 'J2ME Archive' });
    }
  }

  removeDownload(game: GameMeta): void {
    if (this.scanner.isRunning()) throw new UploadError('scan_running', 'Wait for the library scan to finish before deleting a downloaded game', 409);
    const download = this.library.downloadOf(game.id);
    if (!download) throw new UploadError('archive_not_downloaded', 'This JAR was not downloaded by MGO', 409);
    if (download.root !== managedRoot(this.cfg) && resolveInsideRoots(this.cfg, download.root)?.real !== download.root) {
      throw new UploadError('archive_bad_root', 'The download folder is unavailable', 409);
    }
    removePublishedJar(download.root, download.relative, game.sha256, game.sizeBytes);
  }

  status(): ArchiveStatus {
    const managed = managedRoot(this.cfg);
    const java = this.javaLibrary();
    const external = this.cfg.archiveWritableRoot;
    return { availableVersion: SOURCE.version, index: this.index?.info ?? null, indexJob: this.indexJob, matchJob: this.matching.current(),
      maxIndexBytes: this.maxIndex, writableRoots: [
        { id: 'managed', label: 'Managed Java ME library', writable: writable(existsSync(managed) ? managed : this.cfg.dataDir) },
        ...(java ? [{ id: 'java' as const, label: java, writable: this.javaWritable(java) }] : []),
        ...(external ? [{ id: 'external' as const, label: external, writable: writable(external) }] : []),
      ],
    };
  }

  private javaLibrary() {
    const settings = this.settings?.();
    return settings?.libraryPaths?.j2me ?? settings?.libraryPath ?? null;
  }

  private javaWritable(root: string) {
    return resolveInsideRoots(this.cfg, root)?.real === root && writable(root);
  }

  curatedDestination() {
    const java = this.javaLibrary();
    const root = java ?? managedRoot(this.cfg);
    const folder = this.settings?.().archiveDownloadFolder ?? 'Curated Java ME';
    return { path: path.join(root, folder), writable: java ? this.javaWritable(java) : writable(existsSync(root) ? root : this.cfg.dataDir) };
  }

  requireIndex(): ArchiveIndex {
    if (!this.index) throw new UploadError('archive_index_missing', 'Install the J2ME Archive index in Settings', 409);
    return this.index;
  }

  exactBuild(sha: string) { return this.index?.get(sha) ?? null; }

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
    assertSpace(this.dir, this.maxIndex + 64 * MIB);
    const report: ArchiveTransfer = { state: 'running', phase: 'fetching', processed: 0, total: SOURCE.builds, message: null };
    this.indexJob = report;
    this.start(report, async signal => {
      mkdirSync(this.stage, { mode: 0o700 });
      const staged = path.join(this.stage, 'index.sqlite');
      try {
        await this.worker(['index', staged, SOURCE.records, SOURCE.version, String(SOURCE.rows), String(SOURCE.builds), String(this.maxIndex)], this.stage, this.proxy(), signal, line => {
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

  startDownload(sha: string, rootId: string, folder: string, curated?: { root: string; title: string; alternatives: ArchiveSearchItem[] }): ArchiveDownload {
    const fromCurated = !!curated;
    this.ensureIdle(fromCurated);
    if (!SHA256.test(sha)) throw new UploadError('archive_bad_hash', 'Select a valid SHA-256 from the archive');
    const index = this.requireIndex();
    const build = index.get(sha);
    if (!build) throw new UploadError('archive_build_missing', 'This build was not found in the installed archive index', 404);
    const segments = folderSegments(folder);
    const root = curated?.root ?? (rootId === 'managed' ? managedRoot(this.cfg) : rootId === 'external' ? this.cfg.archiveWritableRoot : rootId === 'java' ? this.javaLibrary() : null);
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
    if (rootId === 'java' && !this.javaWritable(root)) throw new UploadError('archive_read_only', 'The archive destination is unavailable or read-only', 403);
    if (rootId === 'managed') mkdirSync(root, { mode: 0o700, recursive: true });
    withDestination(root, segments, dir => assertSpace(dir, build.size));
    mkdirSync(this.dir, { mode: 0o700, recursive: true });
    assertSpace(this.dir, 32 * MIB + 2 * build.size);
    const staging = path.join(this.dir, '.download');
    mkdirSync(staging, { mode: 0o700, recursive: true });
    const file = path.join(staging, 'verified.jar');
    rmSync(file, { force: true });
    this.attemptedAt = Date.now();
    this.download = report;
    const startedWith = curated ? this.library.db.prepare('SELECT total_changes() AS n').get()?.n : undefined;
    this.start(report, async signal => {
      try {
        const progress = (line: string) => {
          report.message = line.slice(0, 300);
          if (fromCurated && this.curated) {
            this.curated.progress = report.message;
            if (report.source) this.curated.source = report.source;
          }
        };
        const freeBytes = this.cfg.libraryQuotaBytes - this.library.totalBytes();
        const alternatives = (curated?.alternatives ?? []).filter(candidate => candidate.size <= build.size + 2 * MIB &&
          candidate.size <= this.cfg.maxUploadBytes && candidate.size <= freeBytes);
        const received = await this.fetchBuild(build, alternatives, file, staging, report, signal, progress);
        signal.throwIfAborted();
        report.sha256 = received.sha256;
        report.phase = 'verifying';
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size !== received.size) throw new Error('Downloaded JAR size mismatch');
        const bytes = await readFile(file);
        if (bytes.length !== received.size || createHash('sha256').update(bytes).digest('hex') !== received.sha256) throw new Error('Downloaded JAR SHA-256 mismatch');
        parseJar(bytes);
        signal.throwIfAborted();
        report.phase = 'importing';
        // It may have been uploaded while the archive job was still transferring.
        const duplicate = this.library.findBySha(received.sha256);
        if (!duplicate && curated && this.library.db.prepare('SELECT total_changes() AS n').get()?.n !== startedWith) {
          const installed = this.installedTitle(curated.title, build.title);
          if (installed) {
            report.gameId = installed;
            report.duplicate = true;
            return;
          }
        }
        const game = duplicate ?? withDestination(root, segments, dir => {
          assertSpace(dir, received.size);
          return publishJar(dir, received.filename, received.sha256, bytes, (name, mtime) => {
            const relative = [...segments, name].join('/');
            const result = this.scanner.importArchiveJar(root, relative, bytes, received.sha256, mtime);
            if (!result.duplicate) this.library.recordDownload(result.game.id, { root, relative, provider: report.source! });
            return result.game;
          });
        });
        this.matching.exact(game.id, index.info.version, received);
        report.gameId = game.id;
        report.duplicate = !!duplicate;
      } finally {
        rmSync(file, { force: true });
      }
    });
    return report;
  }

  private async fetchBuild(preferred: ArchiveBuild, alternatives: ArchiveSearchItem[], file: string, staging: string,
    report: ArchiveDownload, signal: AbortSignal, progress: (message: string) => void): Promise<ArchiveBuild> {
    const budget = alternatives.length ? AbortSignal.any([signal, AbortSignal.timeout(75_000)]) : signal;
    report.source = 'J2ME Vault';
    progress('Looking for a direct JAR…');
    if (this.mirror) for (const candidate of [preferred, ...alternatives.filter(build => build.direct).slice(0, 3)]) {
      const direct = await this.mirror.download(candidate, budget);
      budget.throwIfAborted();
      if (!direct) continue;
      writeFileSync(file, direct, { mode: 0o600 });
      return candidate;
    }
    report.source = 'J2ME Archive';
    progress('Checking the archive fallback…');
    let failure: unknown;
    const backups = alternatives.filter(build => build.collection === '96x65pixels J2ME mini');
    const backup = backups[0] ?? alternatives[0];
    for (const candidate of backup ? [preferred, backup] : [preferred]) {
      budget.throwIfAborted();
      try {
        await this.worker(['download', candidate.sha256, file, path.join(staging, 'cache'),
          String(Math.min(64, Math.ceil(this.cfg.maxUploadBytes / MIB))),
          candidate.collection === '96x65pixels J2ME mini' ? 'mini' : 'auto'], staging, this.proxy(), budget, progress);
        return candidate;
      } catch (error) {
        failure = error;
        rmSync(file, { force: true });
        budget.throwIfAborted();
      }
    }
    throw failure;
  }

  curatedTitles(): string[] {
    return [...new Set(readFileSync(curatedPath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  }

  async previewCurated(): Promise<CuratedTitle[]> {
    const index = this.requireIndex();
    const mirror = this.mirror?.catalog();
    if (this.curatedPlan?.index !== index || this.curatedPlan.mirror !== mirror) {
      const rows = async () => {
        const files = await mirror;
        if (index !== this.index) throw new UploadError('archive_index_changed', 'The archive index changed. Refresh the list.', 409);
        const titles = this.curatedTitles();
        const wanted = new Set(titles.map(titleKey));
        const directBuilds = new Map<string, ArchiveBuild[]>();
        for (const [sha] of files?.byHash ?? []) {
          const build = index.get(sha);
          if (!build) continue;
          const key = titleKey(build.title);
          if (!wanted.has(key)) continue;
          const list = directBuilds.get(key) ?? [];
          list.push(build);
          directBuilds.set(key, list);
        }
        const plan: CuratedTitle[] = [];
        for (const title of titles) {
          await new Promise<void>(done => setImmediate(done));
          if (index !== this.index) throw new UploadError('archive_index_changed', 'The archive index changed. Refresh the list.', 409);
          const { builds, suggested } = index.curatedCandidates(title, files?.sizes(title));
          const typical = builds.find(build => build.sha256 === suggested);
          const direct = directBuilds.get(titleKey(title)) ?? [];
          const options = [...new Map([...direct, ...builds].map(build => [build.sha256, build])).values()]
            .sort((a, b) => Number(!!files?.candidates(b).length) - Number(!!files?.candidates(a).length));
          const recommended = typical && (options.find(build => titleKey(build.title) === titleKey(typical.title) &&
            archiveVendorKey(build.vendor) === archiveVendorKey(typical.vendor) && !!files?.candidates(build).length) ?? typical);
          plan.push({ title, builds: options.map(build => ({ ...build, gameId: null, otherBuildsInLibrary: 0,
            ...(files?.candidates(build).length ? { direct: true } : {}) })), suggested: recommended?.sha256 ?? null });
        }
        return plan;
      };
      this.curatedPlan = { index, ...(mirror ? { mirror } : {}), rows: rows() };
    }
    // Installed status is live even after completing an earlier import.
    const plan = await this.curatedPlan.rows;
    const installed = this.installedTitles();
    return plan.map(item => {
      const installedGameId = installed.get(titleKey(item.title));
      return { ...item, ...(installedGameId ? { installedGameId } : {}),
        builds: item.builds.map(build => ({ ...build, ...this.decorate(build) })) };
    });
  }

  private installedTitles() {
    const installed = new Map<string, string>();
    const rows = this.library.db.prepare(`SELECT g.id,g.name,g.sha256,coalesce(t.title,c.canonical_title) as display
      FROM games g LEFT JOIN game_titles t USING(group_key) LEFT JOIN game_classifications c USING(group_key)
      WHERE g.platform='j2me'`).all();
    for (const row of rows) {
      const id = String(row.id);
      const stored = String(row.name);
      const indexed = this.index?.get(String(row.sha256))?.title;
      const displayed = typeof row.display === 'string' ? row.display : null;
      for (const name of [stored, indexed, displayed]) if (name) installed.set(titleKey(name), id);
    }
    return installed;
  }

  private installedTitle(title: string, candidate?: string) {
    const installed = this.installedTitles();
    return installed.get(titleKey(title)) ?? (candidate ? installed.get(titleKey(candidate)) : undefined);
  }

  currentCurated(): CuratedImport | null { return this.curated; }

  async importCurated(selection: CuratedSelection[], afterDownload = false): Promise<CuratedImport> {
    this.ensureIdle();
    const index = this.requireIndex();
    const plan = new Map((await this.previewCurated()).map(row => [row.title, row]));
    this.ensureIdle();
    if (index !== this.index) throw new UploadError('archive_index_changed', 'The archive index changed. Refresh the list.', 409);
    if (!selection.length || selection.length > plan.size || new Set(selection.map(row => row.title)).size !== selection.length ||
        selection.some(row => !plan.get(row.title)?.builds.some(build => build.sha256 === row.sha256))) {
      throw new UploadError('archive_bad_selection', 'Select one available build per title from the curated list');
    }
    const java = this.javaLibrary();
    const rootId = java ? 'java' : 'managed';
    const root = java ?? managedRoot(this.cfg);
    const folder = this.settings?.().archiveDownloadFolder ?? 'Curated Java ME';
    const destination = this.curatedDestination();
    if (!destination.writable) throw new UploadError('archive_read_only', 'The archive destination is unavailable or read-only', 403);
    if (!java) mkdirSync(root, { mode: 0o700, recursive: true });
    withDestination(root, folderSegments(folder), dir => assertSpace(dir, 0));
    const report: CuratedImport = { state: 'running', total: selection.length, imported: 0, duplicates: 0, failed: [], current: null, progress: null, destination: destination.path,
      ...(afterDownload ? { followUp: { state: 'queued' as const } } : {}) };
    const abort = new AbortController();
    this.curated = report;
    this.curatedAbort = abort;
    this.curatedTask = this.runCurated(selection, plan, report, abort.signal, { rootId, root, folder }).then(async () => {
      if (report.followUp && !abort.signal.aborted) await this.finishCurated(report.followUp, root, folder, abort.signal);
    }).finally(() => {
      report.state = abort.signal.aborted ? 'cancelled' : 'done';
      if (abort.signal.aborted && report.followUp && report.followUp.state !== 'done') report.followUp.state = 'cancelled';
      report.current = null;
      report.progress = null;
      this.curatedTask = null;
      this.curatedAbort = null;
    });
    return report;
  }

  private async runCurated(selection: CuratedSelection[], plan: Map<string, CuratedTitle>, report: CuratedImport, signal: AbortSignal, destination: CuratedDestination): Promise<void> {
    await new Promise<void>(done => setImmediate(done));
    for (const item of selection) {
      if (signal.aborted) break;
      report.current = item.title;
      const build = this.index?.get(item.sha256);
      report.currentBytes = build?.size ?? 0;
      report.progress = null;
      delete report.source;
      try {
        if (this.installedTitle(item.title, build?.title)) {
          report.duplicates++;
          continue;
        }
        const row = plan.get(item.title);
        const alternatives = row?.suggested === item.sha256 && build ? row.builds.filter(candidate =>
          candidate.sha256 !== item.sha256 && titleKey(candidate.title) === titleKey(build.title) &&
          archiveVendorKey(candidate.vendor) === archiveVendorKey(build.vendor)) : [];
        const job = this.startDownload(item.sha256, destination.rootId, destination.folder, { root: destination.root, title: item.title, alternatives });
        await this.job?.task;
        if (signal.aborted) break;
        if (job.state !== 'done') throw new Error(job.message ?? 'Archive source is unavailable');
        if (job.duplicate) report.duplicates++;
        else {
          report.imported++;
          if (job.sha256 !== item.sha256) report.substituted = (report.substituted ?? 0) + 1;
        }
      } catch (error) {
        if (signal.aborted) break;
        report.failed.push({ title: item.title, sha256: item.sha256, message: (error as Error).message });
      }
    }
  }

  private async finishCurated(followUp: NonNullable<CuratedImport['followUp']>, root: string, folder: string, signal: AbortSignal) {
    try {
      while (this.scanner.isRunning()) await delay(500, undefined, { signal });
      followUp.state = 'scanning';
      const scan = this.scanner.startArchiveScan(root, folderSegments(folder), signal);
      await this.scanner.idle();
      signal.throwIfAborted();
      if (scan.report.state === 'cancelled') { followUp.state = 'cancelled'; return; }
      if (scan.report.state !== 'done') throw new Error(scan.report.error ?? 'Library scan failed');
      followUp.scanned = scan.report.jars;
      if (this.index && this.recognize) {
        followUp.state = 'recognizing';
        const metadata = await this.recognize(scan.gameIds(), signal);
        if (metadata) {
          followUp.recognized = metadata.matched;
          if (metadata.state === 'failed') throw new Error(metadata.error ?? 'Java ME metadata lookup failed');
          if (metadata.state === 'cancelled') { followUp.state = 'cancelled'; return; }
        }
      }
      followUp.state = 'done';
    } catch (error) {
      followUp.state = signal.aborted ? 'cancelled' : 'failed';
      if (!signal.aborted) followUp.error = (error as Error).message;
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
