"""Restricted HTTP transport used by the index builder and the pinned downloader."""
import ipaddress
import os
import re
import socket
import subprocess
import time
from urllib.parse import unquote, urlsplit

PROJECT = "/toca-1/new-j2me-software-archive-search/"
PAGES = "/new-j2me-software-archive-search/"
MIB = 1024 * 1024
remaining = 256 * MIB


def route(url):
    parts = urlsplit(url)
    host = parts.hostname
    pathname = unquote(parts.path)
    if (parts.scheme != "https" or parts.netloc != host or parts.fragment
            or re.search(r"%(?:00|2f|5c|25)", parts.path, re.I)
            or any(c in pathname for c in "\\?\x00\r\n") or ".." in pathname.split("/")):
        raise ValueError("Archive URL is outside the allowed origins")
    if parts.query:
        raise ValueError("Archive URL has an unsupported query")
    if host == "raw.githubusercontent.com" and re.fullmatch(PROJECT + r"[a-f0-9]{40}/data/(?:manifest\.json|mini/cli\.json\.gz|records/\d{4}\.json\.gz)", pathname):
        return "/raw"
    if host == "toca-1.github.io" and re.fullmatch(PAGES + r"(?:retrieval/v1/(?:manifest\.json|sha(?:1|256)/[0-9a-f]{1,2}\.json\.gz)|data/mini/cli\.json\.gz)", pathname):
        return "/pages"
    if host == "archive.org" and (pathname == "/metadata/96x65pixels_j2me" or ia_path(parts.path, "/download/")):
        return "/ia"
    if host and re.fullmatch(r"ia\d{4,8}\.us\.archive\.org", host):
        prefix = re.match(r"/\d+/items/", parts.path)
        if prefix and ia_path(parts.path, prefix.group()):
            return "/store/" + host
    raise ValueError("Archive URL is outside the allowed origins")


def ia_path(pathname, prefix):
    return pathname in (prefix + "96x65pixels_j2me/JARchive_v11.7z", prefix + "96x65pixels_j2me/JARchiveLite_v11.7z") or bool(
        re.fullmatch(re.escape(prefix) + r"96x65pixels_j2me_mini/(?:%23|A-B|C-D|E-G|H-L|M-O|P-R|S|T-Z)\.7z/[A-Za-z0-9_.~%\-]+\.[jJ][aA][rR]", pathname)
    )


def guarded_curl(command, *, timeout, **kwargs):
    """Follow redirects one at a time. The redirect target gets the same checks as the original URL."""
    global remaining
    proxy = os.environ.get("MGO_ARCHIVE_PROXY_URL", "").rstrip("/")
    url = command[-1]
    deadline = time.monotonic() + timeout
    args = command[1:-1]
    args.remove("--location")
    redirects = args.index("--max-redirs")
    max_redirects = int(args[redirects + 1])
    del args[redirects:redirects + 2]
    if "--write-out" in args:
        args[args.index("--write-out") + 1] = "\n%{http_code}\n%{redirect_url}\n%{size_download}"
        body_in_stdout = False
    else:
        args.extend(["--write-out", "\n%{http_code}\n%{redirect_url}\n%{size_download}"])
        body_in_stdout = True
    limit = args.index("--max-filesize") + 1
    max_bytes = int(args[limit])
    time_limit = args.index("--max-time") + 1
    direct_limit = float(args[time_limit])
    for _ in range(max_redirects + 1):
        try:
            endpoint = route(url)
            parts = urlsplit(url)
            budget = min(deadline - time.monotonic(), direct_limit)
            if budget <= 0 or remaining <= 0:
                raise ValueError("Archive transfer budget exhausted")
            args[time_limit] = str(budget)
            args[limit] = str(min(max_bytes, remaining))
            # Disable curl config and environment proxies. The only optional proxy is the app's fixed gateway.
            cmd = ["curl", "--disable", "--globoff", "--noproxy", "*", *args]
            proto = cmd.index("--proto") + 1 if "--proto" in cmd else None
            if proto is not None:
                cmd[proto] = "=https,http" if proxy else "=https"
            if proxy:
                target = proxy + "/j2me-archive" + endpoint + parts.path
                if parts.query:
                    target += "?" + parts.query
            else:
                ips = {addr[4][0] for addr in socket.getaddrinfo(parts.hostname, 443, type=socket.SOCK_STREAM)}
                if not ips or not all(ipaddress.ip_address(ip).is_global and not ipaddress.ip_address(ip).is_multicast for ip in ips):
                    raise ValueError("Archive origin did not resolve to public IP addresses")
                formatted = ",".join(f"[{ip}]" if ":" in ip else ip for ip in sorted(ips))
                cmd += ["--resolve", f"{parts.hostname}:443:{formatted}"]
                target = url
        except (OSError, ValueError) as exc:
            raise OSError(f"Archive metadata network is unavailable: {exc}") from exc
        done = subprocess.run([*cmd, target], capture_output=True, timeout=budget + 1, check=False)
        response = done.stdout.rsplit(b"\n", 3)
        if len(response) != 4:
            raise OSError(done.stderr.decode("utf-8", "replace").strip()[-180:] or "Archive request failed")
        payload, status, redirect, size = response
        remaining -= int(size or 0)
        if done.returncode == 0 and status in (b"301", b"302", b"303", b"307", b"308") and redirect:
            url = redirect.decode("ascii")
            continue
        return subprocess.CompletedProcess(command, done.returncode, payload if body_in_stdout else status, done.stderr)
    raise OSError("Too many archive redirects")
