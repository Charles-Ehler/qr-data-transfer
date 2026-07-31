import {
  prepareZXingModule,
  readBarcodes,
} from "zxing-wasm/reader";
import zxingReaderWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

let ready: Promise<unknown> | undefined;

export function prepareQrScanner() {
  if (!ready) {
    ready = Promise.resolve(
      prepareZXingModule({
        overrides: {
          locateFile: (path: string) =>
            path.endsWith(".wasm") ? zxingReaderWasmUrl : path,
        },
        equalityFn: Object.is,
        fireImmediately: true,
      }),
    );
  }
  return ready;
}

export async function scanRawQr(
  image: ImageData,
  robust: boolean,
): Promise<Uint8Array | null> {
  await prepareQrScanner();
  const results = await readBarcodes(image, {
    formats: ["QRCode"],
    tryHarder: robust,
    tryRotate: false,
    tryInvert: false,
    tryDownscale: false,
    tryDenoise: false,
    binarizer: robust ? "LocalAverage" : "GlobalHistogram",
    maxNumberOfSymbols: 1,
    textMode: "Plain",
  });
  const result = results.find(
    (candidate) =>
      candidate.isValid &&
      candidate.symbology === "QRCode" &&
      candidate.bytes.length > 0,
  );
  return result ? new Uint8Array(result.bytes) : null;
}
