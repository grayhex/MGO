import csv
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from build_index import main
from transport import route


class ArchiveWorkerTests(unittest.TestCase):
    def test_allowed_origins_and_minified_routes(self):
        self.assertEqual(route("https://archive.org/download/96x65pixels_j2me/JARchive_v11.7z"), "/ia")
        self.assertEqual(route("https://ia601507.us.archive.org/14/items/96x65pixels_j2me_mini/%23.7z/%E6%B8%B8%E6%88%8F.jar"), "/store/ia601507.us.archive.org")
        for url in [
            "https://archive.org.evil.example/download/96x65pixels_j2me/JARchive_v11.7z",
            "http://archive.org/metadata/96x65pixels_j2me",
            "https://example.com/download/96x65pixels_j2me/JARchive_v11.7z",
            "https://user@archive.org/metadata/96x65pixels_j2me",
            "https://archive.org:1234/metadata/96x65pixels_j2me",
            "https://archive.org/download/96x65pixels_j2me_mini/A-B.7z/%2e%2e%2fabc.jar",
        ]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                route(url)

    def test_verified_csv_and_shard(self):
        sha = "1" * 64
        sha1 = "2" * 40
        record = [sha, sha1, 5, [[0, "Racing.JAR", "Racing.JAR", "d87f7e0c"]], ["Гонки", "Publisher", "2.1", "CLDC-1.0", "MIDP-1.0"]]
        fixture = json.dumps({"schema_version": 4, "total_rows": 2, "unique_files": 1, "record_chunk": 4096}).encode()
        def fetch(url, target, _cap):
            target.write_bytes(fixture if url.endswith("manifest.json") else gzip.compress(json.dumps([record]).encode()))
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "source.csv.gz"
            with gzip.open(source, "wt", newline="") as f:
                out = csv.writer(f)
                out.writerow(["collection", "filename", "archive_path", "size_bytes", "crc32", "sha1", "sha256", "archive_file"])
                for collection in ("first", "second"):
                    out.writerow([collection, "Racing.JAR", "Racing.JAR", 5, "D87F7E0C", sha1, sha, "fixture.7z"])
            checksum = hashlib.sha256(source.read_bytes()).hexdigest()
            with patch("build_index.fetch", fetch):
                args = ("unused", "fixture", "index-v2", 2, 1, 8388608, source)
                with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                    main(directory / "invalid.sqlite", args[0], "0" * 64, *args[1:])
                result = directory / "verified.sqlite"
                main(result, args[0], checksum, *args[1:])
                with sqlite3.connect(result) as db:
                    self.assertEqual(db.execute("SELECT title,vendor,version FROM builds WHERE sha256=?", (sha,)).fetchall(), [("Гонки", "Publisher", "2.1")])
                    self.assertEqual(db.execute("SELECT count(*) FROM search WHERE search MATCH 'гон*'").fetchone()[0], 1)
                record[2] = 6
                with self.assertRaisesRegex(ValueError, "version mismatch"):
                    main(directory / "mismatch.sqlite", args[0], checksum, *args[1:])


if __name__ == "__main__":
    unittest.main()
