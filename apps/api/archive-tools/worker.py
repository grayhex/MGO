"""Single-artifact jobs. MGO invokes this with server-owned paths and a validated SHA-256."""
import sys
from pathlib import Path
import shutil
import resource

MIB = 1024 * 1024
resource.setrlimit(resource.RLIMIT_AS, (320 * MIB, 320 * MIB))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
if sys.argv[1] == "index":
    from build_index import main
    main(*sys.argv[2:])
elif sys.argv[1] == "download":
    from jarchive_download import main
    sha, output, cache, upload_mib = sys.argv[2:]
    # Keep at most 256 MiB from earlier attempts. The transport caps the next attempt at another 256 MiB.
    cache_dir = Path(cache)
    cache_bytes = sum(p.stat().st_size for p in cache_dir.rglob("*") if p.is_file())
    if cache_bytes > 256 * MIB:
        shutil.rmtree(cache_dir)
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * MIB, 64 * MIB))
    sys.exit(main([sha, "--output", output, "--cache-dir", cache,
                   "--time-limit", "360", "--stall-limit", "45", "--request-timeout", "20",
                   "--max-download-mib", "192", "--max-jar-mib", upload_mib, "--route-passes", "1"]))
else:
    raise SystemExit("Unknown archive job")
