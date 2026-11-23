"""Build an independent read-only SQLite database from the verified CSV and pinned record shards."""
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import unicodedata

from transport import guarded_curl, MIB

COLUMNS = "collection filename archive_path size_bytes crc32 sha1 sha256 archive_file".split()
SCHEMA = """
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = OFF;
PRAGMA cache_size = -12000;
PRAGMA temp_store = FILE;
PRAGMA user_version = 1;
CREATE TABLE info (version TEXT, builtAt TEXT, builds INTEGER);
CREATE TABLE builds (
    id INTEGER PRIMARY KEY, sha256 TEXT UNIQUE, sha1 TEXT, crc32 TEXT, size INTEGER,
    filename TEXT, collection TEXT, archivePath TEXT, archiveFile TEXT,
    title TEXT DEFAULT '', vendor TEXT DEFAULT '', version TEXT DEFAULT '',
    cldc TEXT DEFAULT '', midp TEXT DEFAULT '', titleKey TEXT DEFAULT '', vendorKey TEXT DEFAULT ''
);
"""
INDEXES = """
CREATE INDEX by_crc32 ON builds(crc32);
CREATE INDEX by_sha1 ON builds(sha1);
CREATE INDEX by_identity ON builds(titleKey, vendorKey, id);
CREATE VIRTUAL TABLE search USING fts5(text, content='', tokenize='unicode61', prefix='2 3');
"""


def fetch(url, output, cap):
    done = guarded_curl(["curl", "--silent", "--show-error", "--location", "--fail",
                         "--max-redirs", "4", "--connect-timeout", "8", "--max-time", "75",
                         "--max-filesize", str(cap), "--output", str(output),
                         "--write-out", "%{http_code}", url], timeout=78)
    if done.returncode or done.stdout != b"200" or output.stat().st_size > cap:
        raise ValueError(f"Archive source unavailable (HTTP {done.stdout.decode('ascii', 'replace')})")


def digest_of(file):
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(MIB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def key(value):
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).lower()))


def csv_builds(file, rows):
    with gzip.open(file, "rt", encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != COLUMNS:
            raise ValueError("Archive index version mismatch: CSV schema")
        count = 0
        for row in reader:
            count += 1
            if count > rows or None in row or not all(row.values()):
                raise ValueError("Archive index version mismatch: CSV record")
            sha, sha1, crc = row["sha256"].lower(), row["sha1"].lower(), row["crc32"].lower()
            size = int(row["size_bytes"])
            if (not re.fullmatch(r"[a-f0-9]{64}", sha) or not re.fullmatch(r"[a-f0-9]{40}", sha1)
                    or not re.fullmatch(r"[a-f0-9]{8}", crc) or not 0 < size <= 2**31):
                raise ValueError("Invalid hash or size in verified CSV")
            yield (sha, sha1, crc, size, row["filename"], row["collection"], row["archive_path"], row["archive_file"])
        if count != rows:
            raise ValueError("Archive index version mismatch: CSV row count")


def bounded_json(file, gz):
    opener = gzip.open if gz else open
    with opener(file, "rb") as stream:
        data = stream.read(8 * MIB + 1)
        if len(data) > 8 * MIB:
            raise ValueError("Archive shard exceeds decompression limit")
        return json.loads(data)


def add_shard(db, records):
    texts = []
    for sha, sha1, size, sources, values in records:
        row = db.execute("SELECT id,sha1,size,crc32 FROM builds WHERE sha256=?", (sha,)).fetchone()
        if not row or row[1] != sha1 or row[2] != size or not any(src[3].lower() == row[3] for src in sources):
            raise ValueError("Archive index version mismatch: records disagree with the verified CSV")
        if not isinstance(values, list) or len(values) != 5:
            raise ValueError("Archive index version mismatch: MIDlet metadata schema")
        title, vendor, version, cldc, midp = [str(value or "")[:512] for value in values]
        db.execute("UPDATE builds SET title=?, vendor=?, version=?, cldc=?, midp=?, titleKey=?, vendorKey=? WHERE id=?",
                   (title, vendor, version, cldc, midp, key(title), key(vendor), row[0]))
        texts.append((row[0], " ".join([title, vendor, *(str(src[1]) for src in sources)])))
    # The CSV and shards refer to unique hashes. Duplicate records would break this rowid constraint.
    db.executemany("INSERT INTO search(rowid,text) VALUES (?,?)", texts)


def main(output, url, checksum, source, version, rows, builds, max_bytes, known_csv=None):
    output, rows, builds, max_bytes = Path(output), int(rows), int(builds), int(max_bytes)
    csv.field_size_limit(64 * 1024)
    csv_file = Path(known_csv) if known_csv else output.parent / "verified.csv.gz"
    scratch = output.parent / "shard"
    if not known_csv:
        fetch(url, csv_file, 96 * MIB)
    if digest_of(csv_file) != checksum:
        raise ValueError("Archive index checksum mismatch")
    fetch(source + "/manifest.json", scratch, MIB)
    manifest = bounded_json(scratch, False)
    if (manifest["schema_version"], manifest["total_rows"], manifest["unique_files"], manifest["record_chunk"]) != (4, rows, builds, 4096):
        raise ValueError("Archive index version mismatch: published manifest")
    with sqlite3.connect(output) as db:
        db.executescript(SCHEMA)
        db.execute(f"PRAGMA max_page_count = {max_bytes // db.execute('PRAGMA page_size').fetchone()[0]}")
        db.executemany("INSERT OR IGNORE INTO builds(sha256,sha1,crc32,size,filename,collection,archivePath,archiveFile) VALUES (?,?,?,?,?,?,?,?)",
                       csv_builds(csv_file, rows))
        if db.execute("SELECT count(*) FROM builds").fetchone()[0] != builds:
            raise ValueError("Archive index version mismatch: unique build count")
        db.executescript(INDEXES)
        for i in range((builds + 4095) // 4096):
            fetch(f"{source}/records/{i:04}.json.gz", scratch, 2 * MIB)
            records = bounded_json(scratch, True)
            if len(records) != min(4096, builds - i * 4096):
                raise ValueError("Archive index version mismatch: shard length")
            add_shard(db, records)
            db.commit()
            print(f"index {min(builds, (i + 1) * 4096)} {builds}", flush=True)
        if db.execute("SELECT count(*) FROM search").fetchone()[0] != builds:
            raise ValueError("Archive index version mismatch: incomplete search table")
        db.execute("INSERT INTO info VALUES (?,?,?)", (version, datetime.now(timezone.utc).isoformat(), builds))
        if db.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise ValueError("Archive index failed integrity check")
    print(f"Verified {builds} JAR builds", flush=True)
