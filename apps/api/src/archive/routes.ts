import type { FastifyInstance } from 'fastify';
import { UploadError } from '../jar.js';
import { SHA256 } from './index.js';
import type { ArchiveService } from './service.js';

type Query = { q?: string; within?: string; page?: string };
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new UploadError('archive_bad_hash', 'Select a valid SHA-256 from the archive');
  return value;
};
const text = (value: unknown, cap: number, fallback = ''): string => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > cap) throw new UploadError('archive_bad_input', 'The archive input is too long or invalid');
  return value;
};

export function registerArchiveRoutes(app: FastifyInstance, archive: ArchiveService): void {
  const prefix = '/api/archive';
  app.get(prefix, () => archive.status());
  app.post(prefix + '/index', (_req, reply) => reply.code(202).send(archive.installIndex()));
  app.delete(prefix + '/index/job', () => ({ cancelled: archive.cancel('index') }));
  app.delete(prefix + '/index', (_req, reply) => { archive.removeIndex(); return reply.code(204).send(); });

  app.get<{ Querystring: Query }>(prefix + '/search', req => archive.search(text(req.query.q, 160), text(req.query.within, 100), Number(req.query.page ?? 0)));
  app.get<{ Params: { sha: string } }>(prefix + '/builds/:sha', req => archive.detail(hash(req.params.sha)));

  app.post<{ Body: { resume?: boolean } }>(prefix + '/match', (req, reply) => reply.code(202).send(archive.startMatch(req.body?.resume === true)));
  app.delete(prefix + '/match/job', () => ({ paused: archive.matching.pause() }));
  app.post(prefix + '/match/apply', () => archive.matching.apply(archive.requireIndex()));
  app.get<{ Querystring: { preview?: string; page?: string } }>(prefix + '/match/results', req => archive.matching.rows(req.query.preview === '1', Number(req.query.page ?? 0)));
  app.put<{ Params: { id: string }; Body: { sha256: string | null } }>(prefix + '/match/:id', req => {
    return archive.matching.confirm(req.params.id, req.body?.sha256 === null ? null : hash(req.body?.sha256));
  });

  app.get(prefix + '/curated', () => ({ count: archive.curatedTitles().length, job: archive.currentCurated() }));
  app.get(prefix + '/curated/preview', async () => ({ titles: await archive.previewCurated() }));
  app.post<{ Body: { selection?: { title: string; sha256: string }[]; confirmed?: boolean } }>(prefix + '/curated', async (req, reply) => {
    if (req.body?.confirmed !== true || !Array.isArray(req.body.selection)) throw new UploadError('archive_bad_selection', 'Confirm the selected builds first');
    const selection = req.body.selection.map(row => ({ title: text(row?.title, 200), sha256: hash(row?.sha256) }));
    return reply.code(202).send(await archive.importCurated(selection));
  });
  app.delete(prefix + '/curated', () => ({ cancelled: archive.cancelCurated() }));

  app.get(prefix + '/download', () => ({ job: archive.currentDownload() }));
  app.post<{ Body: { sha256: string; root?: string; folder?: string } }>(prefix + '/download', (req, reply) => reply.code(202).send(archive.startDownload(
    hash(req.body?.sha256), text(req.body?.root, 16, 'managed'), text(req.body?.folder, 800, 'J2ME Archive'),
  )));
  app.delete(prefix + '/download', () => ({ cancelled: archive.cancel('download') }));
}
