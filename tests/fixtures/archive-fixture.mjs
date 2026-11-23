import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function archiveBuild(bytes, fields = {}) {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha1: createHash('sha1').update(bytes).digest('hex'),
    crc32: 'cd12ab34',
    size: bytes.length,
    filename: 'Archive Racer.jar',
    collection: 'Test collection',
    archivePath: 'Free games/Archive Racer.jar',
    archiveFile: 'fixture.7z',
    title: 'Archive Racer',
    vendor: 'Test Vendor',
    version: '1.0.0',
    cldc: 'CLDC-1.0',
    midp: 'MIDP-2.0',
    ...fields,
  };
}

export function writeArchiveFixture(file, builds, { snapshotCount = 621715, version = 'index-v2' } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE info (version TEXT,builtAt TEXT,builds INTEGER);
    CREATE TABLE builds (
      id INTEGER PRIMARY KEY,sha256 TEXT UNIQUE,sha1 TEXT,crc32 TEXT,size INTEGER,
      filename TEXT,collection TEXT,archivePath TEXT,archiveFile TEXT,title TEXT,vendor TEXT,version TEXT,cldc TEXT,midp TEXT,
      titleKey TEXT,vendorKey TEXT
    );
    CREATE VIRTUAL TABLE search USING fts5(text, content='', tokenize='unicode61', prefix='2 3');
  `);
  db.prepare('INSERT INTO info VALUES (?, ?, ?)').run(version, new Date().toISOString(), snapshotCount);
  const row = db.prepare('INSERT INTO builds VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const fts = db.prepare('INSERT INTO search(rowid,text) VALUES (?,?)');
  const key = s => (s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
  for (const b of builds) {
    const { lastInsertRowid } = row.run(b.sha256, b.sha1, b.crc32, b.size, b.filename, b.collection, b.archivePath, b.archiveFile, b.title, b.vendor, b.version, b.cldc, b.midp, key(b.title), key(b.vendor));
    fts.run(lastInsertRowid, `${b.filename} ${b.title} ${b.vendor}`);
  }
  db.close();
}

export function archiveFixtureWorker(builds, contents, overrides = {}) {
  return async ([mode, ...args], _workspace, _proxy, signal, progress) => {
    if (mode === 'index') {
      if (overrides.indexError) throw Error(overrides.indexError);
      writeArchiveFixture(args[0], builds);
      progress('index 621715 621715');
    } else {
      if (overrides.delay) await new Promise(resolve => {
        const timer = setTimeout(resolve, overrides.delay);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      signal.throwIfAborted();
      const bytes = contents.get(args[0]);
      if (!bytes) throw Error('Fixture unavailable');
      writeFileSync(args[1], bytes);
      progress('Verified fixture');
    }
  };
}
