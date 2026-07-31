import { gzip, gunzip } from "fflate";

export type CompressionMode = "none" | "gzip";

function gzipAsync(bytes: Uint8Array) {
  return new Promise<Uint8Array>((resolve, reject) => {
    gzip(bytes, { level: 9, mem: 12, mtime: 0 }, (error, compressed) => {
      if (error) reject(error);
      else resolve(compressed);
    });
  });
}

function gunzipAsync(bytes: Uint8Array) {
  return new Promise<Uint8Array>((resolve, reject) => {
    gunzip(bytes, (error, decompressed) => {
      if (error) reject(error);
      else resolve(decompressed);
    });
  });
}

export async function compressForTransfer(bytes: Uint8Array): Promise<{
  bytes: Uint8Array;
  mode: CompressionMode;
  savedBytes: number;
}> {
  if (bytes.length < 768) {
    return { bytes, mode: "none", savedBytes: 0 };
  }

  const compressed = await gzipAsync(bytes);
  // Keep a small safety margin: a token saving is not worth decompression work.
  if (compressed.length + 64 >= bytes.length) {
    return { bytes, mode: "none", savedBytes: 0 };
  }
  return {
    bytes: compressed,
    mode: "gzip",
    savedBytes: bytes.length - compressed.length,
  };
}

export async function decompressTransfer(
  bytes: Uint8Array,
  mode: CompressionMode,
) {
  return mode === "gzip" ? gunzipAsync(bytes) : bytes;
}
