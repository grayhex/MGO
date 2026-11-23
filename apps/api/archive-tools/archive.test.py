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

    def test_verified_record_and_mini_map(self):
        sha = "1" * 64
        sha1 = "2" * 40
        record = [sha, sha1, 5, [[2, "Racing.JAR", "Racing.JAR", "d87f7e0c"]], ["Гонки", "Publisher", "2.1", "CLDC-1.0", "MIDP-1.0"]]
        fixture = {
            "manifest.json": json.dumps({"schema_version": 4, "total_rows": 1, "unique_files": 1, "record_chunk": 4096}).encode(),
            "mini/cli.json.gz": gzip.compress(json.dumps({"sha256": {sha: [sha1, "%23.7z/Racing.JAR", 5, "D87F7E0C"]}}).encode()),
            "records/0000.json.gz": gzip.compress(json.dumps([record]).encode()),
        }
        digests = "\n".join(
            hashlib.sha1(f"blob {len(data)}\x00".encode() + data).hexdigest() + " " + name for name, data in fixture.items()
        )
        def fetch(url, target, _cap):
            target.write_bytes(fixture[url.removeprefix("fixture/")])
        with tempfile.TemporaryDirectory() as temp, patch("build_index.fetch", fetch), patch("build_index.Path.read_text", return_value=digests):
            directory = Path(temp)
            result = directory / "verified.sqlite"
            main(result, "fixture", "index-v2", 1, 1, 8388608)
            with sqlite3.connect(result) as db:
                self.assertEqual(db.execute("SELECT title,vendor,version,archiveFile FROM builds WHERE sha256=?", (sha,)).fetchall(), [("Гонки", "Publisher", "2.1", "#.7z")])
                self.assertEqual(db.execute("SELECT count(*) FROM search WHERE search MATCH 'гон*'").fetchone()[0], 1)
            fixture["records/0000.json.gz"] = b"tampered"
            with self.assertRaisesRegex(ValueError, "verification failed: records/0000"):
                main(directory / "mismatch.sqlite", "fixture", "index-v2", 1, 1, 8388608)


if __name__ == "__main__":
    unittest.main()
