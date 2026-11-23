"""Build an independent read-only SQLite database from the pinned record shards."""
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
import subprocess
import unicodedata
from urllib.parse import unquote

from transport import guarded_curl, MIB

COLLECTIONS = ("JARchiveLite v11", "JARchive v11", "96x65pixels J2ME mini")
ARCHIVE_FILES = ("JARchiveLite_v11.7z", "JARchive_v11.7z")
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
    command = ["curl", "--silent", "--show-error", "--location", "--fail",
               "--max-redirs", "4", "--connect-timeout", "8", "--max-time", "20",
               "--max-filesize", str(cap), "--output", str(output),
               "--write-out", "%{http_code}", url]
    for attempt in range(3):
        try:
            done = guarded_curl(command, timeout=22)
            status = done.stdout.decode("ascii", "replace")
            if done.returncode == 0 and status == "200" and output.stat().st_size <= cap:
                return
            reason = f"HTTP {status}" if status != "000" else f"curl exit {done.returncode}"
            if status not in ("000", "200", "429", "502", "503", "504"):
                break
        except (OSError, subprocess.TimeoutExpired) as exc:
            reason = str(exc)
        if attempt < 2:
            time.sleep(2 ** attempt)
    raise ValueError(f"Archive source unavailable: {url.rsplit('/', 1)[-1]} ({reason})")


def fetch_blob(origin, name, output, cap, digests):
    fetch(f"{origin}/{name}", output, cap)
    data = output.read_bytes()
    blob = hashlib.sha1(f"blob {len(data)}\x00".encode() + data).hexdigest()
    if blob != digests.get(name):
        raise ValueError(f"Archive index verification failed: {name}")


def key(value):
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", value).lower()))


def bounded_json(file, gz):
    opener = gzip.open if gz else open
    with opener(file, "rb") as stream:
        data = stream.read(8 * MIB + 1)
        if len(data) > 8 * MIB:
            raise ValueError("Archive shard exceeds decompression limit")
        return json.loads(data)


def add_shard(db, records, offset, mini):
    builds = []
    texts = []
    for rowid, (sha, sha1, size, sources, values) in enumerate(records, offset + 1):
        if (not re.fullmatch(r"[a-f0-9]{64}", sha) or not re.fullmatch(r"[a-f0-9]{40}", sha1)
                or not isinstance(size, int) or not 0 < size <= 2**31 or not sources):
            raise ValueError("Archive index version mismatch: JAR metadata schema")
        code, filename, archive_path, crc = min(sources, key=lambda src: src[0])
        if code not in (0, 1, 2) or not re.fullmatch(r"[a-fA-F0-9]{8}", crc):
            raise ValueError("Archive index version mismatch: JAR source")
        if code == 2:
            mini_sha1, member, mini_size, mini_crc = mini[sha]
            archive_file = unquote(member.split("/", 1)[0])
            if (mini_sha1 != sha1 or mini_size != size or mini_crc.lower() != crc.lower()
                    or archive_file not in ("#.7z", "A-B.7z", "C-D.7z", "E-G.7z", "H-L.7z", "M-O.7z", "P-R.7z", "S.7z", "T-Z.7z")):
                raise ValueError("Archive index version mismatch: Mini source")
        else:
            archive_file = ARCHIVE_FILES[code]
        if not isinstance(values, list) or len(values) != 5:
            raise ValueError("Archive index version mismatch: MIDlet metadata schema")
        title, vendor, version, cldc, midp = [str(value or "")[:512] for value in values]
        builds.append((rowid, sha, sha1, crc.lower(), size, filename, COLLECTIONS[code], archive_path, archive_file,
                       title, vendor, version, cldc, midp, key(title), key(vendor)))
        texts.append((rowid, " ".join([title, vendor, *(src[1] for src in sources)])))
    db.executemany("""INSERT INTO builds(id,sha256,sha1,crc32,size,filename,collection,archivePath,archiveFile,
                   title,vendor,version,cldc,midp,titleKey,vendorKey) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", builds)
    db.executemany("INSERT INTO search(rowid,text) VALUES (?,?)", texts)


def main(output, source, version, rows, builds, max_bytes):
    output, rows, builds, max_bytes = Path(output), int(rows), int(builds), int(max_bytes)
    digests = {name: digest for digest, name in (
        line.split() for line in Path(__file__).with_name("index-v2.blobs").read_text().splitlines() if line and not line.startswith("#")
    )}
    scratch = output.parent / "shard"
    fetch_blob(source, "manifest.json", scratch, MIB, digests)
    manifest = bounded_json(scratch, False)
    if (manifest["schema_version"], manifest["total_rows"], manifest["unique_files"], manifest["record_chunk"]) != (4, rows, builds, 4096):
        raise ValueError("Archive index version mismatch: published manifest")
    fetch_blob(source, "mini/cli.json.gz", scratch, MIB, digests)
    mini = bounded_json(scratch, True)["sha256"]
    with sqlite3.connect(output) as db:
        db.executescript(SCHEMA)
        db.execute(f"PRAGMA max_page_count = {max_bytes // db.execute('PRAGMA page_size').fetchone()[0]}")
        db.executescript(INDEXES)
        for offset in range(0, builds, 4096):
            fetch_blob(source, f"records/{offset // 4096:04}.json.gz", scratch, 2 * MIB, digests)
            records = bounded_json(scratch, True)
            if len(records) != min(4096, builds - offset):
                raise ValueError("Archive index version mismatch: shard length")
            add_shard(db, records, offset, mini)
            db.commit()
            print(f"index {min(builds, offset + 4096)} {builds}", flush=True)
        if db.execute("SELECT count(*) FROM search").fetchone()[0] != builds:
            raise ValueError("Archive index version mismatch: incomplete search table")
        db.execute("INSERT INTO info VALUES (?,?,?)", (version, datetime.now(timezone.utc).isoformat(), builds))
        if db.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise ValueError("Archive index failed integrity check")
    print(f"Verified {builds} JAR builds", flush=True)
