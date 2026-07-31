"use client";

import jsQR from "jsqr";
import { useCallback, useEffect, useRef, useState } from "react";
import { decompressTransfer } from "@/lib/compression";
import {
  crc32,
  decodeTransferFrame,
  FountainDecoder,
  formatBytes,
  formatRate,
  FRAME_PREFIX,
  LEGACY_FRAME_PREFIXES,
  TransferMeta,
} from "@/lib/qr-transfer";

type ScanState = "idle" | "starting" | "scanning" | "receiving" | "complete" | "error";
type DetectorMode = "native" | "software";
type DetectedBarcode = { rawValue?: string };
type NativeBarcodeDetector = {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
};
type BarcodeDetectorConstructor = {
  new (options: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};
type RateSample = { at: number; bytes: number };

function getBarcodeDetectorConstructor() {
  return (
    globalThis as typeof globalThis & {
      BarcodeDetector?: BarcodeDetectorConstructor;
    }
  ).BarcodeDetector;
}

function updateRollingRate(samples: RateSample[], bytes: number) {
  const now = performance.now();
  samples.push({ at: now, bytes });
  while (samples.length > 1 && now - samples[0].at > 5000) samples.shift();
  const elapsed = Math.max(1000, now - samples[0].at);
  const total = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  return (total * 1000) / elapsed;
}

function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "calculating";
  if (seconds < 60) return `${Math.ceil(seconds)} sec`;
  const minutes = seconds / 60;
  return `${minutes >= 10 ? Math.ceil(minutes) : minutes.toFixed(1)} min`;
}

export function ScannerClient() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const detectorRef = useRef<NativeBarcodeDetector | undefined>(undefined);
  const decoderRef = useRef(new FountainDecoder());
  const scanningRef = useRef(false);
  const completingRef = useRef(false);
  const downloadUrlRef = useRef("");
  const scanStartedAtRef = useRef(0);
  const lastQrAtRef = useRef(0);
  const qrReadsRef = useRef(0);
  const acceptedFramesRef = useRef(0);
  const lastSolvedRef = useRef(0);
  const channelSamplesRef = useRef<RateSample[]>([]);
  const usefulSamplesRef = useRef<RateSample[]>([]);
  const [state, setState] = useState<ScanState>("idle");
  const [progress, setProgress] = useState(0);
  const [solved, setSolved] = useState(0);
  const [frames, setFrames] = useState(0);
  const [qrReads, setQrReads] = useState(0);
  const [badFrames, setBadFrames] = useState(0);
  const [channelRate, setChannelRate] = useState(0);
  const [usefulRate, setUsefulRate] = useState(0);
  const [meta, setMeta] = useState<TransferMeta>();
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");
  const [guidance, setGuidance] = useState("Center the entire QR field inside the four corners.");
  const [detectorMode, setDetectorMode] = useState<DetectorMode>("software");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const stopCamera = useCallback(() => {
    scanningRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
  }, []);

  const finishTransfer = useCallback(async () => {
    if (completingRef.current) return;
    completingRef.current = true;
    const decoder = decoderRef.current;
    try {
      setGuidance(
        decoder.meta?.compression === "gzip"
          ? "Optical transfer complete. Decompressing and verifying…"
          : "Optical transfer complete. Verifying the file…",
      );
      const transmitted = decoder.result();
      const bytes = await decompressTransfer(
        transmitted,
        decoder.meta?.compression ?? "none",
      );
      if (
        !decoder.meta ||
        bytes.length !== decoder.meta.fileSize ||
        crc32(bytes) !== decoder.meta.fileCrc
      ) {
        throw new Error("The recovered file checksum did not match.");
      }
      const type = decoder.meta.mime || "application/octet-stream";
      const fileBytes = Uint8Array.from(bytes);
      const url = URL.createObjectURL(new Blob([fileBytes.buffer], { type }));
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = url;
      setDownloadUrl(url);
      setProgress(1);
      setGuidance("File decompressed and checksum verified. It is safe to save.");
      setState("complete");
      stopCamera();
      navigator.vibrate?.([80, 40, 120]);
    } catch (cause) {
      setState("error");
      setError(cause instanceof Error ? cause.message : "File verification failed.");
      stopCamera();
    } finally {
      completingRef.current = false;
    }
  }, [stopCamera]);

  const acceptQrValue = useCallback(
    (value: string) => {
      qrReadsRef.current += 1;
      lastQrAtRef.current = performance.now();
      setQrReads(qrReadsRef.current);

      if (LEGACY_FRAME_PREFIXES.some((prefix) => value.startsWith(prefix))) {
        setGuidance("An older QRFerry sender is visible. Reload the sending screen.");
        return;
      }
      if (!value.startsWith(FRAME_PREFIX)) {
        setGuidance("A QR code is visible, but it is not a current QRFerry transfer.");
        return;
      }

      try {
        const frame = decodeTransferFrame(value);
        if (frame.kind === "descriptor") {
          decoderRef.current.initialize(frame.meta);
          setMeta(frame.meta);
          setGuidance(
            frame.meta.compression === "gzip"
              ? "Transfer locked. Compressed payload frames are arriving."
              : "Transfer locked. Payload frames are arriving.",
          );
          setState("receiving");
          return;
        }

        if (!decoderRef.current.meta) {
          setGuidance("Payload seen. Waiting for the next metadata beacon.");
          return;
        }

        const result = decoderRef.current.receiveData(frame);
        if (result.accepted) {
          acceptedFramesRef.current += 1;
          const solvedDelta = Math.max(0, result.solved - lastSolvedRef.current);
          lastSolvedRef.current = result.solved;
          setFrames(acceptedFramesRef.current);
          setSolved(result.solved);
          setProgress(result.total ? result.solved / result.total : 0);
          setChannelRate(
            updateRollingRate(channelSamplesRef.current, frame.payload.length),
          );
          setUsefulRate(
            updateRollingRate(
              usefulSamplesRef.current,
              solvedDelta * frame.payload.length,
            ),
          );
          setGuidance("Signal locked. Keep the complete QR field inside the corners.");
          setState(result.complete ? "receiving" : "receiving");
          if (result.complete) void finishTransfer();
        } else if (result.duplicate) {
          setGuidance("Signal locked. Waiting for the sending screen to advance.");
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        setBadFrames((current) => current + 1);
        setGuidance("A frame was blurred or incomplete. Hold steady—the next one can replace it.");
        if (message.includes("different transfer")) setError(message);
      }
    },
    [finishTransfer],
  );

  const scanVideo = useCallback(
    function scanVideoFrame() {
      if (!scanningRef.current) return;
      const runScan = async () => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (
          !video ||
          !canvas ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          video.videoWidth === 0 ||
          video.videoHeight === 0
        ) {
          return;
        }

        const sourceSize = Math.floor(Math.min(video.videoWidth, video.videoHeight) * 0.94);
        const sourceX = Math.floor((video.videoWidth - sourceSize) / 2);
        const sourceY = Math.floor((video.videoHeight - sourceSize) / 2);
        const scanSize = Math.min(800, sourceSize);
        canvas.width = scanSize;
        canvas.height = scanSize;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.drawImage(
          video,
          sourceX,
          sourceY,
          sourceSize,
          sourceSize,
          0,
          0,
          scanSize,
          scanSize,
        );

        const values = new Set<string>();
        if (detectorRef.current) {
          try {
            const barcodes = await detectorRef.current.detect(canvas);
            for (const barcode of barcodes) {
              if (barcode.rawValue) values.add(barcode.rawValue);
            }
          } catch {
            detectorRef.current = undefined;
            setDetectorMode("software");
          }
        }

        if (values.size === 0) {
          const fullImage = context.getImageData(0, 0, scanSize, scanSize);
          const fullCode = jsQR(fullImage.data, scanSize, scanSize, {
            inversionAttempts: "attemptBoth",
          });
          if (fullCode?.data) values.add(fullCode.data);

          const fullWidth = fullCode
            ? Math.hypot(
                fullCode.location.topRightCorner.x - fullCode.location.topLeftCorner.x,
                fullCode.location.topRightCorner.y - fullCode.location.topLeftCorner.y,
              )
            : 0;
          const mayBeMultiplexed = !fullCode || fullWidth < scanSize * 0.55;
          if (mayBeMultiplexed) {
            const half = Math.floor(scanSize / 2);
            for (let row = 0; row < 2; row += 1) {
              for (let column = 0; column < 2; column += 1) {
                const quadrant = context.getImageData(column * half, row * half, half, half);
                const code = jsQR(quadrant.data, half, half, {
                  inversionAttempts: "dontInvert",
                });
                if (code?.data) values.add(code.data);
              }
            }
          }
        }

        for (const value of values) acceptQrValue(value);
      };

      void runScan().finally(() => {
        if (scanningRef.current) {
          window.setTimeout(
            () => window.requestAnimationFrame(scanVideoFrame),
            20,
          );
        }
      });
    },
    [acceptQrValue],
  );

  const startCamera = useCallback(async () => {
    setError("");
    setGuidance("Center the entire QR field inside the four corners.");
    setState("starting");
    decoderRef.current = new FountainDecoder();
    completingRef.current = false;
    qrReadsRef.current = 0;
    acceptedFramesRef.current = 0;
    lastSolvedRef.current = 0;
    channelSamplesRef.current = [];
    usefulSamplesRef.current = [];
    lastQrAtRef.current = 0;
    scanStartedAtRef.current = performance.now();
    setMeta(undefined);
    setProgress(0);
    setSolved(0);
    setFrames(0);
    setQrReads(0);
    setBadFrames(0);
    setChannelRate(0);
    setUsefulRate(0);
    setTorchOn(false);
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = "";
      setDownloadUrl("");
    }

    try {
      const Detector = getBarcodeDetectorConstructor();
      if (Detector) {
        const formats = await Detector.getSupportedFormats?.();
        if (!formats || formats.includes("qr_code")) {
          detectorRef.current = new Detector({ formats: ["qr_code"] });
          setDetectorMode("native");
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & {
        focusMode?: string[];
        torch?: boolean;
      };
      setTorchAvailable(Boolean(capabilities?.torch));
      if (capabilities?.focusMode?.includes("continuous")) {
        await track
          .applyConstraints({
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          })
          .catch(() => undefined);
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      scanningRef.current = true;
      setState("scanning");
      window.requestAnimationFrame(scanVideo);
    } catch (cause) {
      stopCamera();
      setState("error");
      const name = cause instanceof DOMException ? cause.name : "";
      setError(
        name === "NotAllowedError"
          ? "Camera access was blocked. Allow camera access in your browser settings and try again."
          : "The rear camera could not be started. Camera scanning needs HTTPS or localhost.",
      );
    }
  }, [scanVideo, stopCamera]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!scanningRef.current || acceptedFramesRef.current > 0) return;
      const now = performance.now();
      if (lastQrAtRef.current > 0 && now - lastQrAtRef.current < 3000) return;
      const elapsed = now - scanStartedAtRef.current;
      if (elapsed > 8000) {
        setGuidance("No QR detected. Use Robust mode, move closer, and keep every white margin visible.");
      } else if (elapsed > 4000) {
        setGuidance("Still looking. Move closer until the QR field nearly fills the guide.");
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    };
  }, [stopCamera]);

  const complete = state === "complete";
  const active = state === "scanning" || state === "receiving" || state === "starting";
  const compressionRatio =
    meta && meta.transmittedSize > 0 ? meta.fileSize / meta.transmittedSize : 1;
  const effectiveRate = usefulRate * compressionRatio;
  const recoveredBytes = meta
    ? Math.min(meta.transmittedSize, solved * meta.blockSize)
    : 0;
  const etaSeconds =
    meta && usefulRate > 0
      ? (meta.transmittedSize - recoveredBytes) / usefulRate
      : Number.POSITIVE_INFINITY;
  const compressionPercent =
    meta && meta.fileSize > 0
      ? Math.round((1 - meta.transmittedSize / meta.fileSize) * 100)
      : 0;

  return (
    <main className="scanner-page">
      <section className="scanner-intro">
        <p className="eyebrow">MULTI-LANE MOBILE RECEIVER</p>
        <h1>{complete ? "File recovered." : "Point. Hold. Receive."}</h1>
        <p>
          {complete
            ? "Every block passed both transmitted and original-file checksums."
            : "The scanner can read one robust code or four parallel Turbo lanes per exposure."}
        </p>
      </section>

      <section className="scanner-shell">
        <div className={`camera-view ${active ? "active" : ""} ${complete ? "complete" : ""}`}>
          <video ref={videoRef} playsInline muted aria-label="Rear camera preview" />
          <canvas ref={canvasRef} hidden />
          <div className="scan-reticle" aria-hidden="true">
            <i /><i /><i /><i />
          </div>
          {!active && !complete ? (
            <div className="camera-empty">
              <span className="camera-icon" aria-hidden="true">◎</span>
              <strong>Camera is off</strong>
              <span>The video stays on this device.</span>
            </div>
          ) : null}
          {state === "starting" ? <div className="camera-loading">Starting camera…</div> : null}
          {complete ? <div className="complete-mark" aria-hidden="true">✓</div> : null}
          {torchAvailable && active ? (
            <button className="torch-button" type="button" onClick={toggleTorch}>
              {torchOn ? "Light off" : "Light on"}
            </button>
          ) : null}
        </div>

        <div className="receive-card">
          <div className="receive-status">
            <span className={`pulse-dot ${active ? "live" : ""}`} aria-hidden="true" />
            <strong>
              {state === "receiving"
                ? "Receiving compact repair frames"
                : state === "scanning"
                  ? "Looking for QRFerry"
                  : complete
                    ? "Transfer verified"
                    : "Ready to scan"}
            </strong>
            <b>{Math.round(progress * 100)}%</b>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="File recovery progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span style={{ width: `${progress * 100}%` }} />
          </div>

          <div className="rate-panel" aria-live="polite">
            <div>
              <span>Useful transfer rate</span>
              <strong>{effectiveRate > 0 ? formatRate(effectiveRate) : "—"}</strong>
              <small>{meta?.compression === "gzip" ? `${formatRate(usefulRate)} optical · ${compressionPercent}% compressed` : `${formatRate(channelRate)} optical channel`}</small>
            </div>
            <div>
              <span>Estimated remaining</span>
              <strong>{complete ? "Complete" : formatEta(etaSeconds)}</strong>
              <small>{meta ? `${formatBytes(recoveredBytes)} of ${formatBytes(meta.transmittedSize)} encoded` : "Waiting for descriptor"}</small>
            </div>
          </div>

          {meta ? (
            <div className="incoming-file">
              <span className="file-glyph" aria-hidden="true">↓</span>
              <div>
                <strong>{meta.filename}</strong>
                <span>
                  {formatBytes(meta.fileSize)}
                  {meta.compression === "gzip" ? ` · ${compressionPercent}% compression` : ""}
                  {" · "}{solved.toLocaleString()} / {meta.blockCount.toLocaleString()} blocks
                </span>
              </div>
              <b>{frames}</b>
            </div>
          ) : null}

          <div className="scan-diagnostics" aria-live="polite">
            <span><b>{qrReads}</b> QR reads</span>
            <span><b>{frames}</b> accepted</span>
            <span><b>{badFrames}</b> blurred</span>
            <span><b>{detectorMode}</b> detector</span>
          </div>
          <p className="scan-hint">{guidance}</p>

          {error ? <p className="error-message" role="alert">{error}</p> : null}

          {complete && downloadUrl && meta ? (
            <a className="primary-action" href={downloadUrl} download={meta.filename}>
              <span aria-hidden="true">↓</span>
              Save {meta.filename}
            </a>
          ) : (
            <button
              className="primary-action"
              type="button"
              disabled={state === "starting"}
              onClick={
                active
                  ? () => {
                      stopCamera();
                      setState("idle");
                      setGuidance("Camera stopped. Start it again when ready.");
                    }
                  : startCamera
              }
            >
              <span aria-hidden="true">{active ? "■" : "◎"}</span>
              {state === "starting" ? "Starting…" : active ? "Stop camera" : "Start camera"}
            </button>
          )}

          {complete ? (
            <button className="link-action" type="button" onClick={startCamera}>
              Scan another transfer
            </button>
          ) : null}
        </div>
      </section>

      <section className="scan-tips">
        <div><span>1</span><p>Use Turbo only when all four codes remain sharp and visible.</p></div>
        <div><span>2</span><p>Useful rate includes the gain from pre-transfer compression.</p></div>
        <div><span>3</span><p>If accepted frames stall, step down one channel mode.</p></div>
      </section>
    </main>
  );
}
