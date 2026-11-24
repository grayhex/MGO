"""Single-artifact jobs. MGO invokes this with server-owned paths and a validated SHA-256."""
import sys
from pathlib import Path
import resource

MIB = 1024 * 1024
resource.setrlimit(resource.RLIMIT_AS, (320 * MIB, 320 * MIB))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
if sys.argv[1] == "index":
    from build_index import main
    main(*sys.argv[2:])
elif sys.argv[1] == "download":
    from jarchive_download import main
    sha, output, cache, upload_mib, *sources = sys.argv[2:]
    # Preserve the most recently used compressed ranges across different games.
    ranges = list((Path(cache) / "ranges").rglob("*.bin"))
    old_ranges = sorted((p.stat().st_mtime, p.stat().st_size, p) for p in ranges)
    cache_bytes = sum(size for _, size, _ in old_ranges)
    for _, size, file in old_ranges:
        if cache_bytes <= 256 * MIB:
            break
        file.unlink(missing_ok=True)
        file.with_suffix(".bin.sha256").unlink(missing_ok=True)
        cache_bytes -= size
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * MIB, 64 * MIB))
    sys.exit(main([sha, "--output", output, "--cache-dir", cache,
                   "--time-limit", "45", "--stall-limit", "15", "--request-timeout", "8",
                   "--source", sources[0] if sources else "auto", "--max-download-mib", "8",
                   "--max-decode-mib", "16", "--max-jar-mib", upload_mib, "--route-passes", "1"]))
else:
    raise SystemExit("Unknown archive job")
