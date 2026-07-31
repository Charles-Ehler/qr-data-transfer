import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { compressForTransfer, decompressTransfer } from "../lib/compression";
import {
  crc32,
  createDroplet,
  createTransferSource,
  decodeTransferFrame,
  encodeDescriptor,
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

const fixedSession = new Uint8Array([1, 2, 3, 4, 5, 6]);

test("compact descriptor and data frames round-trip independently", () => {
  const bytes = deterministicBytes(4097);
  const source = createTransferSource(bytes, {
    filename: "camera-notes.txt",
    mime: "text/plain",
    blockSize: 300,
    sessionBytes: fixedSession,
  });
  const descriptor = decodeTransferFrame(encodeDescriptor(source));
  assert.equal(descriptor.kind, "descriptor");
  assert.equal(descriptor.kind === "descriptor" && descriptor.meta.filename, "camera-notes.txt");

  const original = createDroplet(source, 17);
  const data = decodeTransferFrame(encodeDroplet(original));
  assert.equal(data.kind, "data");
  assert.equal(data.kind === "data" && data.sequence, original.sequence);
  assert.deepEqual(data.kind === "data" && data.payload, original.payload);
  assert.ok(
    encodeDroplet(original).length < 520,
    "compact payload frame should not repeat filename and MIME metadata",
  );
});

test("damaged frames are rejected by the per-frame checksum", () => {
  const source = createTransferSource(deterministicBytes(2048), {
    filename: "integrity.bin",
    blockSize: 300,
    sessionBytes: new Uint8Array(6).fill(9),
  });
  const valid = encodeDroplet(createDroplet(source, 1));
  const pivot = Math.floor(valid.length * 0.7);
  const damaged =
    valid.slice(0, pivot) +
    (valid[pivot] === "A" ? "B" : "A") +
    valid.slice(pivot + 1);
  assert.throws(() => decodeTransferFrame(damaged), /checksum|Base45|Invalid/i);
});

test("level-9 compression is used only when it saves optical payload", async () => {
  const text = new TextEncoder().encode("camera transfer telemetry,".repeat(8000));
  const compressed = await compressForTransfer(text);
  assert.equal(compressed.mode, "gzip");
  assert.ok(compressed.bytes.length < text.length * 0.02);
  assert.deepEqual(await decompressTransfer(compressed.bytes, compressed.mode), text);

  const random = deterministicBytes(16 * 1024);
  const incompressible = await compressForTransfer(random);
  assert.equal(incompressible.mode, "none");
  assert.deepEqual(incompressible.bytes, random);
});

test("fountain repair recovers through drop, reorder, duplicate, and corruption loss", () => {
  const bytes = deterministicBytes(96 * 1024 + 17);
  const source = createTransferSource(bytes, {
    filename: "field-recording.raw",
    mime: "application/octet-stream",
    blockSize: 300,
    sessionBytes: new Uint8Array([11, 22, 33, 44, 55, 66]),
  });
  const random = seededRandom(0xdecafbad);
  const candidates: string[] = [];
  const maximumSequence = source.meta.blockCount * 7;

  for (let sequence = 0; sequence < maximumSequence; sequence += 1) {
    if (random() < 0.42) continue;
    const frame = encodeDroplet(createDroplet(source, sequence));
    if (random() < 0.08) continue;
    candidates.push(frame);
    if (random() < 0.06) candidates.push(frame);
  }
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }

  const descriptor = decodeTransferFrame(encodeDescriptor(source));
  assert.equal(descriptor.kind, "descriptor");
  const decoder = new FountainDecoder();
  if (descriptor.kind === "descriptor") decoder.initialize(descriptor.meta);
  for (const encoded of candidates) {
    const frame = decodeTransferFrame(encoded);
    if (frame.kind === "data") decoder.receiveData(frame);
    if (decoder.isComplete) break;
  }
  assert.equal(
    decoder.isComplete,
    true,
    `only recovered ${decoder.solvedCount}/${decoder.totalCount} blocks`,
  );
  assert.deepEqual(decoder.result(), bytes);
});

test("compressed files verify both transmitted and original checksums", async () => {
  const original = new TextEncoder().encode("air-gapped-data\n".repeat(12000));
  const compressed = await compressForTransfer(original);
  const source = createTransferSource(compressed.bytes, {
    filename: "records.csv",
    mime: "text/csv",
    blockSize: 280,
    sessionBytes: new Uint8Array([9, 8, 7, 6, 5, 4]),
    originalSize: original.length,
    originalCrc: crc32(original),
    compression: compressed.mode,
  });
  const descriptor = decodeTransferFrame(encodeDescriptor(source));
  assert.equal(descriptor.kind, "descriptor");
  const decoder = new FountainDecoder();
  if (descriptor.kind === "descriptor") decoder.initialize(descriptor.meta);
  for (let sequence = 0; sequence < source.meta.blockCount; sequence += 1) {
    const frame = decodeTransferFrame(encodeDroplet(createDroplet(source, sequence)));
    if (frame.kind === "data") decoder.receiveData(frame);
  }
  const recovered = await decompressTransfer(decoder.result(), source.meta.compression);
  assert.equal(crc32(recovered), source.meta.fileCrc);
  assert.deepEqual(recovered, original);
});

test("the actual QR encoder and camera decoder preserve a compact payload frame", () => {
  const source = createTransferSource(deterministicBytes(4096), {
    filename: "qr-pipeline.bin",
    blockSize: 360,
    sessionBytes: new Uint8Array([3, 1, 4, 1, 5, 9]),
  });
  const text = encodeDroplet(createDroplet(source, 3));
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
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
  const decoded = decodeTransferFrame(scanned.data);
  assert.equal(decoded.kind === "data" && decoded.sequence, 3);
});

test("software fallback decodes four spatially multiplexed QR lanes", () => {
  const preset = TRANSFER_PRESETS.turbo;
  const source = createTransferSource(deterministicBytes(preset.blockSize * 8), {
    filename: "four-lanes.bin",
    blockSize: preset.blockSize,
    sessionBytes: new Uint8Array([4, 3, 2, 1, 0, 9]),
  });
  const cellSize = 400;
  const compositeSize = cellSize * 2;
  const composite = new Uint8ClampedArray(compositeSize * compositeSize * 4).fill(255);

  for (let lane = 0; lane < 4; lane += 1) {
    const encoded = encodeDroplet(createDroplet(source, lane));
    const qr = QRCode.create(encoded, { errorCorrectionLevel: preset.ecc });
    const margin = 4;
    const scale = Math.floor(cellSize / (qr.modules.size + margin * 2));
    const renderedSize = (qr.modules.size + margin * 2) * scale;
    const inset = Math.floor((cellSize - renderedSize) / 2);
    const cellX = (lane % 2) * cellSize;
    const cellY = Math.floor(lane / 2) * cellSize;
    for (let y = 0; y < renderedSize; y += 1) {
      for (let x = 0; x < renderedSize; x += 1) {
        const moduleX = Math.floor(x / scale) - margin;
        const moduleY = Math.floor(y / scale) - margin;
        const dark =
          moduleX >= 0 &&
          moduleY >= 0 &&
          moduleX < qr.modules.size &&
          moduleY < qr.modules.size &&
          qr.modules.get(moduleY, moduleX);
        const output =
          ((cellY + inset + y) * compositeSize + cellX + inset + x) * 4;
        const value = dark ? 0 : 255;
        composite[output] = value;
        composite[output + 1] = value;
        composite[output + 2] = value;
        composite[output + 3] = 255;
      }
    }
  }

  const sequences = new Set<number>();
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const quadrant = new Uint8ClampedArray(cellSize * cellSize * 4);
      for (let y = 0; y < cellSize; y += 1) {
        const inputStart =
          ((row * cellSize + y) * compositeSize + column * cellSize) * 4;
        quadrant.set(
          composite.subarray(inputStart, inputStart + cellSize * 4),
          y * cellSize * 4,
        );
      }
      const scanned = jsQR(quadrant, cellSize, cellSize, {
        inversionAttempts: "dontInvert",
      });
      assert.ok(scanned, `lane ${row * 2 + column + 1} should decode`);
      const frame = decodeTransferFrame(scanned.data);
      if (frame.kind === "data") sequences.add(frame.sequence);
    }
  }
  assert.deepEqual(Array.from(sequences).sort((a, b) => a - b), [0, 1, 2, 3]);
});

test("all lane payloads stay within camera-friendly QR density", () => {
  const maximumVersions = { robust: 17, balanced: 20, turbo: 14 };
  for (const [name, preset] of Object.entries(TRANSFER_PRESETS)) {
    const source = createTransferSource(deterministicBytes(preset.blockSize * 2), {
      filename:
        "an-extremely-long-desktop-filename-that-must-keep-its-important-extension.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      blockSize: preset.blockSize,
      sessionBytes: new Uint8Array(6).fill(7),
    });
    const encoded = encodeDroplet(createDroplet(source, 0));
    const qr = QRCode.create(encoded, { errorCorrectionLevel: preset.ecc });
    const version = (qr.modules.size - 17) / 4;
    assert.ok(
      version <= maximumVersions[name as keyof typeof maximumVersions],
      `${name} produced QR version ${version}`,
    );
  }
  const turbo = TRANSFER_PRESETS.turbo;
  const robust = TRANSFER_PRESETS.robust;
  assert.ok(
    turbo.blockSize * turbo.fps * turbo.lanes >
      robust.blockSize * robust.fps * robust.lanes * 10,
    "spatial multiplexing should provide more than 10x nominal robust capacity",
  );
});
