# Illustration originals

These PNGs are generated source illustrations used to build the website assets. They are original illustrations based on references, not copied reference photographs. Export masks, crops, coordinates and conversions live in tools/phones/export_assets.py.

Each `source.png` is the current illustration for that handset.

The handsets are visual review drafts. See apps/web/public/phones/README.md for native resolution and the integration contract.

Measured models retain source.png, source-space layout.json, silhouette.svg and generation.json. Export them with `python3 tools/phones/export_measured.py`. The exporter applies alpha masks, cropping, resampling and format conversion. Each reference dossier links to the source photographs and records their checksums.
