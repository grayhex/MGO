// What a client of the mgo-symbian service may ask EKA2L1. EKA2L1's control API has no authentication and can write files anywhere
// ("host:" paths, PUT /v1/files) and change its configuration, so the service never passes it through as it is: only the routes the
// MGO adapter needs, with paths pinned to the directories of the running instance.
import path from 'node:path';

const GET_OK = [
  /^\/v1$/, /^\/v1\/status$/, /^\/v1\/capabilities$/, /^\/v1\/keys$/, /^\/v1\/apps$/, /^\/v1\/devices$/, /^\/v1\/session$/,
  /^\/v1\/screenshot$/, /^\/v1\/jobs(\/[A-Za-z0-9_-]{1,64})?$/, /^\/v1\/log$/, /^\/v1\/session\/(screen-mode|frame-limit)$/,
];
const POST_OK = [
  /^\/v1\/input\/(key|touch|text|sequence|release)$/, /^\/v1\/wait$/, /^\/v1\/apps\/(0x)?[0-9A-Fa-f]{1,8}\/launch$/,
  /^\/v1\/emulator\/(pause|resume)$/, /^\/v1\/devices\/rescan$/, /^\/v1\/devices\/[A-Za-z0-9._-]{1,32}\/boot$/,
];
const PUT_OK = [/^\/v1\/session\/frame-limit$/];
const DELETE_OK = [/^\/v1\/session$/];

/** Install types EKA2L1's `/v1/apps` knows. */
export const INSTALL_TYPES = new Set(['sis', 'ngage', 'ngage2']);

function under(dir: string, p: unknown) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return false;
  const rel = path.relative(dir, path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

interface ControlRequest { method: string; pathname: string; body: unknown; inputDir: string | null }

/** Returns an HTTP denial or null when the request may pass through. */
export function checkControl(r: ControlRequest) {
  const deny = (message: string, status = 403, code = 'forbidden') => ({ status, code, message });
  const lists: Record<string, RegExp[]> = { GET: GET_OK, POST: POST_OK, PUT: PUT_OK, DELETE: DELETE_OK };
  const list = lists[r.method];
  if (r.method === 'POST' && r.pathname === '/v1/apps') {
    if (!r.inputDir) return deny('no instance is running', 409, 'no_instance');
    if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body)) return deny('a JSON object is required', 400, 'bad_request');
    const b = r.body as { path?: unknown; paths?: unknown; type?: unknown };
    const paths: unknown[] = Array.isArray(b.paths) ? b.paths : [b.path];
    if (!paths.length || paths.length > 8) return deny('one to eight paths', 400, 'bad_request');
    for (const p of paths) if (!under(r.inputDir, p)) return deny('only files uploaded to this instance can be installed', 403, 'path_not_allowed');
    if (b.type !== undefined && (typeof b.type !== 'string' || !INSTALL_TYPES.has(b.type))) return deny('unknown install type', 400, 'bad_request');
    return null;
  }
  if (!list || !list.some((re) => re.test(r.pathname))) return deny(`${r.method} ${r.pathname} is not available through the MGO service`);
  return null;
}

/** Names of uploaded files: a plain file name, nothing else. */
export function safeName(name: unknown) {
  if (typeof name !== 'string') return null;
  const n = name.normalize('NFKC');
  if (!n || n.length > 120 || /[\\/\0:*?"<>|]/.test(n) || n.startsWith('.') || n.includes('..')) return null;
  return n;
}

/** Save keys are the 32 hex characters MGO derives; anything else never becomes a path. */
export const SAVE_KEY = /^[0-9a-f]{32}$/;
