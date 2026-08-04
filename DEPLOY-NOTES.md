# Static / GitHub Pages deployment notes

This branch adds a static-hosting path to QRFerry. Nothing about the transfer
protocol, the WASM codecs, or the UI was changed — the app still does all
compression, RaptorQ encoding, QR rendering and camera decoding in the browser.

## What changed

1. **Self-hosted fonts.** `next/font/google` emitted a runtime request to
   `fonts.googleapis.com`, which meant the app needed the public internet just
   to draw text — awkward for a tool whose entire point is working across an
   air gap. Geist Sans and Geist Mono are now bundled as variable `woff2` files
   in `public/fonts/` and declared with `@font-face` in `app/globals.css`.
   The app now makes **zero third-party network requests**.

2. **Configurable base path.** `vite.config.ts` reads `QRF_BASE`, so the build
   can be served from a domain root or from a subdirectory such as a GitHub
   Pages project site. Everything that hardcoded a root-relative path was
   updated to derive from it: header navigation, the service worker (which
   reads its own registration scope), the web manifest, metadata icons, and the
   "copy mobile scanner link" URL.

3. **Removed the request-header dependency in metadata.** `generateMetadata`
   called `headers()` to build a `metadataBase`, which is meaningless in a
   prerendered file and produced absolute URLs pointing at the build host.

4. **`scripts/export-static.sh`** builds, boots the production server, and
   writes a fully static `out/` directory (prerendered `/` and `/scan`, the
   manifest, `.nojekyll`, and a `404.html` fallback).

5. **`.github/workflows/pages.yml`** runs that script on pushes to the `pages`
   branch and publishes to GitHub Pages, deriving the base path from the
   repository name automatically.

## Verified

Built, exported, served from a `/qr-data-transfer/` subpath, and tested
end-to-end with a headless sender and a headless receiver fed the sender's own
QR stream as a synthetic camera device:

- 706-byte file encoded, streamed at the Robust profile, decoded in ~4 s
- per-frame CRC, RaptorQ object CRC, payload CRC and file CRC all verified
- recovered file byte-identical to the original (`cmp` clean)
- zero failed network requests, including no font or CDN calls
- header navigation between sender and receiver works as full page loads,
  which is what a static host requires

## Rebuilding by hand

```bash
npm ci
QRF_BASE=/qr-data-transfer/ ./scripts/export-static.sh out
```

Then serve `out/` from any static host. HTTPS is required for camera access on
phones (GitHub Pages provides it).
