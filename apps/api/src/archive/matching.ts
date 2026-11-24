import type { ArchiveBuild, ArchiveMatch, ArchiveMatchJob, ArchiveReviewItem, GameMeta } from '@mgo/protocol';
import type { StatementSync } from 'node:sqlite';
import type { Library } from '../library.js';
import { UploadError } from '../jar.js';
import { cleanTitle, cleanVendor } from '../title.js';
import { ArchiveIndex, PAGE_SIZE, SEARCH_URL } from './index.js';

interface LocalGame { ordinal: number; id: string; name: string; vendor: string; version: string; sha256: string }
interface MatchRow { match_json: string; candidates_json: string }
interface Checkpoint { cursor: number; through: number; startedAt: string; report: ArchiveMatchJob }

export function provenance(indexVersion: string, state: ArchiveMatch['state'], sha: string, build: ArchiveBuild | null): ArchiveMatch {
  return {
    provider: 'j2me-archive', indexVersion, state, build,
    sourceUrl: SEARCH_URL + '?sha256=' + (build?.sha256 ?? sha),
    matchedSha256: build?.sha256 ?? null,
    confidence: state === 'exact' ? 'verified' : state === 'manual' || state === 'review' ? 'candidate' : null,
  };
}

export class ArchiveMatching {
  private checkpoint: Checkpoint | null;
  private running: Promise<void> | null = null;
  private paused = false;
  private getMatch: StatementSync;

  constructor(private library: Library) {
    library.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_matches (
        game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        match_json TEXT NOT NULL, candidates_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archive_preview (
        game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        match_json TEXT NOT NULL, candidates_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archive_match_job (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    `);
    this.getMatch = library.db.prepare('SELECT match_json FROM archive_matches WHERE game_id=?');
    const row = library.db.prepare('SELECT payload FROM archive_match_job WHERE id=1').get();
    this.checkpoint = row ? JSON.parse(String(row.payload)) as Checkpoint : null;
    if (this.checkpoint?.report.state === 'running') {
      this.checkpoint.report.state = 'paused';
      this.save();
    }
  }

  isRunning(): boolean { return this.running !== null; }
  async idle(): Promise<void> { await this.running; }
  current(): ArchiveMatchJob | null {
    const report = this.checkpoint?.report;
    if (!report || report.state !== 'applied') return report ?? null;
    const review = this.library.db.prepare(`SELECT count(*) AS n FROM archive_matches a JOIN games g ON g.id=a.game_id
      WHERE json_extract(a.match_json,'$.state')='review' AND json_array_length(a.candidates_json)>0`).get();
    return { ...report, review: Number(review?.n ?? 0) };
  }
  pause(): boolean {
    if (!this.running) return false;
    this.paused = true;
    return true;
  }

  private save(): void {
    this.library.db.prepare('INSERT OR REPLACE INTO archive_match_job VALUES (1,?)').run(JSON.stringify(this.checkpoint));
  }

  enrich(game: GameMeta): GameMeta {
    if ((game.platform ?? 'j2me') !== 'j2me') return game;
    const row = this.getMatch.get(game.id);
    if (!row) return game;
    const match = JSON.parse(String(row.match_json)) as ArchiveMatch;
    game.archiveMatch = match;
    if (match.state === 'exact' && match.matchedSha256 === game.sha256 && match.build) {
      if (game.vendor === 'Unknown' && match.build.vendor) game.vendor = match.build.vendor;
      if (!game.version && match.build.version) game.version = match.build.version;
    }
    return game;
  }

  start(index: ArchiveIndex, resume: boolean): ArchiveMatchJob {
    if (this.running) throw new UploadError('archive_busy', 'Archive matching is already running', 409);
    const db = this.library.db;
    if (resume) {
      if (this.checkpoint?.report.state !== 'paused') throw new UploadError('archive_no_checkpoint', 'No paused archive scan', 409);
      if (this.checkpoint.report.indexVersion !== index.info.version) throw new UploadError('archive_index_mismatch', 'Archive index version mismatch. Start a new match.', 409);
    } else {
      const scope = db.prepare("SELECT count(*) AS total,max(rowid) AS through FROM games WHERE platform='j2me'").get()!;
      this.checkpoint = { cursor: 0, through: Number(scope.through ?? 0), startedAt: new Date().toISOString(), report: {
        state: 'running', indexVersion: index.info.version, total: Number(scope.total), processed: 0,
        exact: 0, review: 0, unknown: 0, skipped: 0, errors: 0, error: null,
      } };
      db.exec('DELETE FROM archive_preview');
    }
    const checkpoint = this.checkpoint!;
    checkpoint.report.state = 'running';
    this.paused = false;
    this.save();
    this.running = this.run(index, checkpoint).finally(() => { this.running = null; });
    return checkpoint.report;
  }

  private async run(index: ArchiveIndex, cp: Checkpoint): Promise<void> {
    const report = cp.report;
    const db = this.library.db;
    const next = db.prepare("SELECT rowid AS ordinal,id,name,vendor,version,sha256 FROM games WHERE platform='j2me' AND rowid>? AND rowid<=? AND created_at<=? ORDER BY rowid LIMIT 32");
    const insert = db.prepare('INSERT OR REPLACE INTO archive_preview VALUES (?,?,?)');
    try {
      while (!this.paused) {
        await new Promise<void>(done => setImmediate(done));
        if (this.paused) break;
        const batch = next.all(cp.cursor, cp.through, cp.startedAt) as unknown as LocalGame[];
        if (!batch.length) break;
        db.exec('BEGIN');
        try {
          for (const game of batch) {
            cp.cursor = game.ordinal;
            report.processed++;
            const applied = this.getMatch.get(game.id);
            if (applied && (JSON.parse(String(applied.match_json)) as ArchiveMatch).state === 'manual') {
              report.skipped++;
              continue;
            }
            try {
              const build = index.get(game.sha256);
              const candidates = build ? [] : index.candidates(cleanTitle(game.name), cleanVendor(game.vendor), game.version, game.sha256);
              const state = build ? 'exact' : candidates.length ? 'review' : 'unknown';
              insert.run(game.id, JSON.stringify(provenance(index.info.version, state, game.sha256, build)), JSON.stringify(candidates));
              report[state]++;
            } catch {
              report.errors++;
            }
          }
          this.save();
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      if (!this.paused) report.skipped += Math.max(0, report.total - report.processed);
      report.state = this.paused ? 'paused' : 'preview';
    } catch (error) {
      report.state = 'failed';
      report.error = (error as Error).message;
    }
    this.save();
  }

  rows(preview: boolean, page: number): { rows: ArchiveReviewItem[]; more: boolean } {
    if (!Number.isInteger(page) || page < 0 || page > 4999) throw new UploadError('archive_page', 'Invalid archive results page');
    const table = preview ? 'archive_preview' : 'archive_matches';
    const where = "WHERE json_extract(a.match_json,'$.state')='review' AND json_array_length(a.candidates_json)>0";
    const result = this.library.db.prepare(`SELECT g.id,g.name,g.vendor,g.version,g.sha256,a.match_json,a.candidates_json
      FROM ${table} a JOIN games g ON g.id=a.game_id ${where}
      ORDER BY g.name,g.id LIMIT ? OFFSET ?`).all(PAGE_SIZE + 1, page * PAGE_SIZE) as unknown as (LocalGame & MatchRow)[];
    return { rows: result.slice(0, PAGE_SIZE).map(row => ({
      gameId: row.id, name: this.library.get(row.id)?.name ?? row.name, vendor: row.vendor, version: row.version, sha256: row.sha256,
      match: JSON.parse(row.match_json) as ArchiveMatch, candidates: JSON.parse(row.candidates_json) as ArchiveBuild[],
    })), more: result.length > PAGE_SIZE };
  }

  apply(index: ArchiveIndex): ArchiveMatchJob {
    if (this.checkpoint?.report.state !== 'preview') throw new UploadError('archive_no_preview', 'Run a preview before applying archive matches', 409);
    const report = this.checkpoint.report;
    if (report.indexVersion !== index.info.version) throw new UploadError('archive_index_mismatch', 'Archive index version mismatch. Start a new match.', 409);
    const db = this.library.db;
    db.exec('BEGIN');
    try {
      db.exec(`INSERT OR REPLACE INTO archive_matches SELECT * FROM archive_preview p WHERE NOT EXISTS (
        SELECT 1 FROM archive_matches a WHERE p.game_id=a.game_id AND json_extract(a.match_json,'$.state')='manual'
      )`);
      db.exec('DELETE FROM archive_preview');
      report.state = 'applied';
      this.save();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      report.state = 'preview';
      throw error;
    }
    return report;
  }

  confirm(gameId: string, sha: string | null): ArchiveMatch {
    const game = this.library.get(gameId);
    const row = this.library.db.prepare('SELECT match_json,candidates_json FROM archive_matches WHERE game_id=?').get(gameId) as unknown as MatchRow | undefined;
    const current = row && JSON.parse(row.match_json) as ArchiveMatch;
    if (!game || !row || current?.state !== 'review') throw new UploadError('archive_no_review', 'No archive match to review for this game', 404);
    const candidate = sha ? (JSON.parse(row.candidates_json) as ArchiveBuild[]).find(build => build.sha256 === sha) : null;
    if (sha && !candidate) throw new UploadError('archive_bad_candidate', 'Choose a build from the review list');
    const match = provenance(current.indexVersion, candidate ? 'manual' : 'unknown', game.sha256, candidate ?? null);
    this.library.db.prepare("UPDATE archive_matches SET match_json=?,candidates_json='[]' WHERE game_id=?").run(JSON.stringify(match), gameId);
    return match;
  }

  exact(gameId: string, version: string, build: ArchiveBuild): void {
    this.library.db.prepare("INSERT OR REPLACE INTO archive_matches VALUES (?,?,'[]')").run(gameId, JSON.stringify(provenance(version, 'exact', build.sha256, build)));
  }
}
