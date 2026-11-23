# J2ME Archive worker

`jarchive_download.py` is from toca-1's New J2ME Software Archive Search at
`d0775dcca7061a5e64584f03ae18b21a3ca3546f` under the MIT license.
MGO uses the original single-JAR verification and LZMA2 range extraction.
The four curl calls go through `transport.py` and ZIP expansion is checked before
the upstream CRC verification. This package requires Python 3.9+ with SQLite
FTS5, curl and the standard-library gzip/lzma modules.

The archive data and the software contained in it have separate terms.
[Upstream source](https://github.com/toca-1/new-j2me-software-archive-search/tree/d0775dcca7061a5e64584f03ae18b21a3ca3546f)
