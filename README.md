# QRFerry

QRFerry moves a file from one device to another as a live animated QR stream.
The sender and receiver run entirely in the browser; the file is never uploaded
to an application server.

## Use it

1. Open the root page on the sending screen and choose a file.
2. Open `/scan` on the receiving phone and allow rear-camera access.
3. Start the QR stream and keep the complete code inside the phone's guide.
4. Save the file when RaptorQ recovery and the whole-file checksum reach 100%.

All modes now use one stable QR target. Robust uses larger modules, Balanced
raises density, and Turbo sends a V30-L byte-mode symbol at 15 display frames
per second. Turbo's nominal payload channel is about 25 KB/s before camera loss
and can be substantially faster in effective file bytes when compression helps.

## Protocol

- Brotli quality 11 and gzip level 9 are both attempted; only the smallest
  representation is retained, and only when it saves optical bytes.
- QR frames use raw byte mode, avoiding the Base45 expansion of the previous
  protocol.
- Every frame carries a compact binary header, a RaptorQ symbol, and CRC-32.
- File metadata is inside the protected RaptorQ object instead of repeating in
  descriptor beacons.
- Source and repair symbols are interleaved. The receiver can join mid-cycle,
  discard blur, accept frames out of order, and reconstruct after receiving
  enough unique symbols.
- Turbo uses one V30-L code at 15 fps. A stable finder geometry is more reliable
  than asking the camera to acquire four independent codes per exposure.
- Rendering uses `fast_qr` compiled to WebAssembly. Scanning uses ZXing-C++
  compiled to WebAssembly. Fountain encoding and decoding use the RFC 6330
  RaptorQ implementation compiled to WebAssembly.
- The receiver verifies the per-frame CRC, the complete RaptorQ object CRC, the
  transmitted compressed payload CRC, and the original file CRC before saving.

## Development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

The project does not require a Python environment. If Python tooling is added,
use `uv` for its environment and dependencies.

## Test harness

```bash
npm test
```

The harness checks:

- metadata, compression, and end-to-end checksum round trips;
- per-frame corruption rejection;
- RaptorQ reconstruction after unordered simulated camera-frame erasures;
- the actual V30-L WebAssembly renderer passed through the actual ZXing-C++
  WebAssembly scanner with exposure noise;
- exact QR capacity for every profile;
- production builds and server rendering for both `/` and `/scan`.

Run `npm run lint` and `npx tsc --noEmit` for the additional source checks.
