import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import jsQR from "jsqr";
import {
  createDroplet,
  createTransferSource,
  decodeDroplet,
  encodeDroplet,
  FountainDecoder,
} from "../lib/qr-transfer";
import { TRANSFER_PRESETS } from "../lib/transfer-presets";

function deterministicBytes(length: number) {
  const output = new Uint8Array(length);
  let state = 0x6d2b79f5;
  for (let index = 0; index < length; index += 1) {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    output[index] = (state ^ (state >>> 14)) & 0xff;
  }
  return output;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

test("a QR frame round-trips its metadata and payload", () => {
  const bytes = deterministicBytes(4097);
  const source = createTransferSource(bytes, {
    filename: "camera-notes.txt",
    mime: "text/plain",
    blockSize: 300,
    sessionBytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  });
  const original = createDroplet(source, 17);
  const decoded = decodeDroplet(encodeDroplet(original));

  assert.equal(decoded.sequence, original.sequence);
  assert.equal(decoded.meta.filename, "camera-notes.txt");
  assert.equal(decoded.meta.fileSize, bytes.length);
  assert.deepEqual(decoded.indices, original.indices);
  assert.deepEqual(decoded.payload, original.payload);
});

test("damaged frames are rejected by the per-frame checksum", () => {
  const source = createTransferSource(deterministicBytes(2048), {
    filename: "integrity.bin",
    blockSize: 300,
    sessionBytes: new Uint8Array(8).fill(9),
  });
  const valid = encodeDroplet(createDroplet(source, 1));
  const pivot = Math.floor(valid.length * 0.7);
  const damaged =
    valid.slice(0, pivot) +
    (valid[pivot] === "A" ? "B" : "A") +
    valid.slice(pivot + 1);

  assert.throws(() => decodeDroplet(damaged), /checksum|Base45|Invalid/i);
});

test("fountain repair recovers a file through drop, reorder, duplicate, and corruption loss", () => {
  const bytes = deterministicBytes(96 * 1024 + 17);
  const source = createTransferSource(bytes, {
    filename: "field-recording.raw",
    mime: "application/octet-stream",
    blockSize: 300,
    sessionBytes: new Uint8Array([11, 22, 33, 44, 55, 66, 77, 88]),
  });
  const random = seededRandom(0xdecafbad);
  const candidates: string[] = [];
  const maximumSequence = source.meta.blockCount * 7;

  for (let sequence = 0; sequence < maximumSequence; sequence += 1) {
    if (random() < 0.42) continue; // Simulated camera frame loss.
    const frame = encodeDroplet(createDroplet(source, sequence));
    if (random() < 0.08) continue; // Simulated undecodable/corrupt QR.
    candidates.push(frame);
    if (random() < 0.06) candidates.push(frame); // Camera sees the same frame twice.
  }

  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }

  const decoder = new FountainDecoder();
  for (const frame of candidates) {
    decoder.receive(decodeDroplet(frame));
    if (decoder.isComplete) break;
  }

  assert.equal(decoder.isComplete, true, `only recovered ${decoder.solvedCount}/${decoder.totalCount} blocks`);
  assert.deepEqual(decoder.result(), bytes);
});

test("the actual QR encoder and camera decoder preserve a transfer frame", () => {
  const source = createTransferSource(deterministicBytes(4096), {
    filename: "qr-pipeline.bin",
    blockSize: 300,
    sessionBytes: new Uint8Array([3, 1, 4, 1, 5, 9, 2, 6]),
  });
  const text = encodeDroplet(createDroplet(source, 3));
  const qr = QRCode.create(text, { errorCorrectionLevel: "Q" });
  const margin = 4;
  const scale = 5;
  const width = (qr.modules.size + margin * 2) * scale;
  const rgba = new Uint8ClampedArray(width * width * 4);
  const random = seededRandom(12345);

  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const moduleX = Math.floor(x / scale) - margin;
      const moduleY = Math.floor(y / scale) - margin;
      const dark =
        moduleX >= 0 &&
        moduleY >= 0 &&
        moduleX < qr.modules.size &&
        moduleY < qr.modules.size &&
        qr.modules.get(moduleY, moduleX);
      const cameraNoise = Math.floor(random() * 23);
      const value = dark ? cameraNoise : 255 - cameraNoise;
      const offset = (y * width + x) * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }

  const scanned = jsQR(rgba, width, width, { inversionAttempts: "dontInvert" });
  assert.ok(scanned, "jsQR should decode the rasterized camera frame");
  assert.equal(scanned.data, text);
  assert.equal(decodeDroplet(scanned.data).sequence, 3);
});

test("every camera preset stays at QR version 19 or below with maximum metadata", () => {
  for (const [name, preset] of Object.entries(TRANSFER_PRESETS)) {
    const source = createTransferSource(deterministicBytes(preset.blockSize * 2), {
      filename:
        "an-extremely-long-desktop-filename-that-must-keep-its-important-extension.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      blockSize: preset.blockSize,
      sessionBytes: new Uint8Array(8).fill(7),
    });
    const encoded = encodeDroplet(createDroplet(source, 0));
    const qr = QRCode.create(encoded, { errorCorrectionLevel: preset.ecc });
    const version = (qr.modules.size - 17) / 4;

    assert.ok(
      version <= 19,
      `${name} produced QR version ${version}, which is too dense for reliable camera pickup`,
    );
    assert.match(source.meta.filename, /…\.pptx$/);
  }
});
