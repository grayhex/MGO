import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { KemulatorRelease, KemulatorUpdateStatus } from '@mgo/protocol';
import { type Config, readKemCommit, readKemVersion } from '../config.js';
import { loadDevicePresets } from '../devices.js';
import { UploadError } from '../jar.js';

const prefix = '/mgo-updates';
const repository = 'grayhex/MGO';
const maxDownload = 32 * 1024 * 1024;
const assetPattern = /^mgo-kemulator-v(\d+\.\d+(?:\.\d+)?)-bridge1-linux-amd64\.zip$/;
const stableTag = /^v?\d+\.\d+\.\d+$/;
const allowedFile = /^(?:KEM_(?:VERSION|COMMIT)|KEmulator\.jar|sensorsimulator\.jar|swt-gtk-linux-x86_64\.jar|lwjgl(?:-opengl|-glfw)?-natives-linux\.jar|lwjgl3-swt-linux\.jar|libjinput-linux64\.so|lang\/[a-zA-Z0-9_-]+\.txt)$/;
const fail = (message: string, status = 502) => new UploadError('kemulator_update', message, status);

function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw fail(`KEmulator release download returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.length;
      if (total > limit) throw fail('KEmulator release exceeds the download limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Trusted MGO releases contain the patched Bridge. Upstream desktop ZIPs are not usable here. */
export class KemulatorUpdates {
  private readonly root: string;
  private readonly bundledDir: string;
  private readonly bundledVersion: string | null;
  private busy = false;
  private readonly supported = process.platform === 'linux' && process.arch === 'x64';

  constructor(private cfg: Config, private fetcher = fetch, private proxy = process.env.MGO_RELEASE_PROXY_URL ?? process.env.MGO_METADATA_GATEWAY ?? process.env.AAS_PROXY_URL ?? '') {
    this.root = path.join(cfg.dataDir, 'kemulator-runtime');
    this.bundledDir = cfg.kemDir;
    this.bundledVersion = readKemVersion(cfg.kemDir);
    // On app upgrades prefer the bundled build if it is as new as the installed update.
    try {
      const sha = readFileSync(path.join(this.root, 'active'), 'utf8').trim();
      if (!this.supported || !/^[a-f0-9]{64}$/.test(sha)) return;
      const dir = path.join(this.root, sha);
      const version = readKemVersion(dir);
      if (version && compareVersions(version, this.bundledVersion ?? '0') > 0 && existsSync(path.join(dir, 'KEmulator.jar'))) cfg.kemDir = dir;
    } catch { /* no saved update or disk unavailable: use the bundled runtime */ }
  }

  status(): KemulatorUpdateStatus {
    return { supported: this.supported, version: readKemVersion(this.cfg.kemDir), bundledVersion: this.bundledVersion, updated: this.cfg.kemDir !== this.bundledDir, busy: this.busy };
  }

  private async upstream(): Promise<KemulatorRelease | null> {
    if (!this.supported) return null;
    const response = await this.fetcher(this.proxy ? `${this.proxy}${prefix}/latest` : `https://api.github.com/repos/${repository}/releases/latest`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    const release = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')) as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; size: number; digest?: string }[] };
    if (!release.tag_name || !stableTag.test(release.tag_name) || release.draft || release.prerelease) return null;
    const available = (release.assets ?? []).flatMap(asset => {
      const v = assetPattern.exec(asset.name)?.[1];
      const hash = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
      return v && hash && Number.isInteger(asset.size) && asset.size > 0 && asset.size <= maxDownload ? [{ version: v, tag: release.tag_name!, asset: asset.name, sha256: hash, bytes: asset.size }] : [];
    }).sort((a, b) => compareVersions(b.version, a.version));
    const next = available[0];
    return next && compareVersions(next.version, this.status().version ?? '0') > 0 ? next : null;
  }

  async check(): Promise<KemulatorRelease | null> {
    try { return await this.upstream(); }
    catch (error) { if (error instanceof UploadError) throw error; throw fail('Cannot reach the MGO release catalog'); }
  }

  async install(expectedVersion: string, expectedHash: string): Promise<KemulatorUpdateStatus> {
    if (this.busy) throw fail('A KEmulator update is already running', 409);
    this.busy = true;
    try {
      const selected = await this.check();
      if (!selected || selected.version !== expectedVersion || selected.sha256 !== expectedHash) throw fail('The available KEmulator update changed. Check again.', 409);
      const assetPath = `${selected.tag}/${selected.asset}`;
      const signal = AbortSignal.timeout(60000);
      let response = await this.fetcher(this.proxy ? `${this.proxy}${prefix}/download/${assetPath}` : `https://github.com/${repository}/releases/download/${assetPath}`, { redirect: this.proxy ? 'error' : 'manual', signal });
      if (!this.proxy && response.status === 302) {
        const url = new URL(response.headers.get('location') ?? 'https://invalid.invalid');
        await response.body?.cancel();
        if (url.origin !== 'https://release-assets.githubusercontent.com' || url.username || url.password) throw fail('Unexpected MGO release download host');
        response = await this.fetcher(url, { redirect: 'error', signal });
      }
      const bytes = await readBounded(response, selected.bytes);
      if (bytes.length !== selected.bytes || createHash('sha256').update(bytes).digest('hex') !== selected.sha256) throw fail('KEmulator release checksum does not match');
      this.stage(selected, bytes);
      return { ...this.status(), busy: false };
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw fail('Could not download or install the KEmulator update');
    } finally { this.busy = false; }
  }

  private stage(selected: KemulatorRelease, bytes: Buffer): void {
    const staging = path.join(this.root, `stage-${randomUUID()}`);
    const dir = path.join(this.root, selected.sha256);
    const pointer = path.join(this.root, `active-${randomUUID()}`);
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const names = new Set<string>();
      let size = 0;
      const files = unzipSync(bytes, { filter: f => {
        size += f.originalSize;
        if (!allowedFile.test(f.name) || names.has(f.name) || names.size >= 128 || size > 64 * 1024 * 1024) throw fail('Invalid KEmulator runtime archive');
        names.add(f.name);
        return true;
      } });
      for (const [name, data] of Object.entries(files)) {
        const p = path.join(staging, name);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, data, { mode: 0o600 });
      }
      if (readKemVersion(staging) !== selected.version || !/^[0-9a-f]{40}$/.test(readKemCommit(staging) ?? '')) throw fail('Invalid KEmulator runtime version metadata');
      const jar = unzipSync(readFileSync(path.join(staging, 'KEmulator.jar')), { filter: f => f.name === 'emulator/ui/bridge/BridgeFrontend.class' && f.originalSize < 128 * 1024 });
      if (!jar['emulator/ui/bridge/BridgeFrontend.class'] || !loadDevicePresets(staging).presets.length) throw fail('The KEmulator build is missing the MGO Bridge or device presets');
      if (!existsSync(dir)) renameSync(staging, dir);
      writeFileSync(pointer, selected.sha256, { mode: 0o600 });
      renameSync(pointer, path.join(this.root, 'active'));
      this.cfg.kemDir = dir;
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(pointer, { force: true });
    }
  }

  restoreBundled(): KemulatorUpdateStatus {
    if (this.busy) throw fail('A KEmulator update is already running', 409);
    if (!existsSync(path.join(this.bundledDir, 'KEmulator.jar'))) throw fail('The bundled KEmulator is unavailable', 409);
    rmSync(path.join(this.root, 'active'), { force: true });
    this.cfg.kemDir = this.bundledDir;
    return this.status();
  }
}
