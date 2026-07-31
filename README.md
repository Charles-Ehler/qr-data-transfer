# QRFerry

QRFerry moves a file from one device to another as a live animated QR stream.
The sender and receiver run entirely in the browser; the file is never uploaded
to an application server.

## Use it

1. Open the root page on the sending screen and choose a file.
2. Open `/scan` on the receiving phone and allow rear-camera access.
3. Start the QR stream and keep the complete code inside the phone's guide.
4. Save the file when recovery and the whole-file checksum reach 100%.

Robust mode is the default and uses larger QR modules, longer frame holds, and
stronger per-frame correction. Once the scanner reports accepted frames,
Balanced or Turbo can raise throughput for a bright, steady setup.

## Resilience model

- Each QR uses native QR error correction to survive local image damage.
- A Base45 wire envelope keeps frames in QR's compact alphanumeric mode; every
  preset is capped at QR version 19 even with maximum repeated metadata.
- Each binary frame has a CRC-32 checksum; corrupt frames are discarded.
- The stream begins with systematic source blocks for fast clean transfers.
- It then emits an unlimited robust-soliton fountain stream. Any sufficient set
  of repair frames can reconstruct missed blocks, regardless of order.
- The receiver deduplicates frames, incrementally peels fountain equations, and
  verifies a second CRC-32 over the complete recovered file.

Frame metadata is self-describing and repeated, so the receiver can join after
the animation has already started. The current browser build accepts files up to
512 MB.

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

- packet and metadata round trips;
- per-frame corruption rejection;
- complete recovery with 42% simulated camera-frame loss plus reordering,
  duplicates, and additional corrupt-frame loss;
- an actual `qrcode` raster passed through the same `jsQR` decoder used by the
  mobile scanner;
- production builds and server rendering for both `/` and `/scan`.

Run `npm run lint` and `npx tsc --noEmit` for the additional source checks.
