"use client";

import jsQR from "jsqr";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeDroplet,
  FountainDecoder,
  formatBytes,
  FRAME_PREFIX,
  LEGACY_FRAME_PREFIX,
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

function getBarcodeDetectorConstructor() {
  return (
    globalThis as typeof globalThis & {
      BarcodeDetector?: BarcodeDetectorConstructor;
    }
  ).BarcodeDetector;
}

export function ScannerClient() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const detectorRef = useRef<NativeBarcodeDetector | undefined>(undefined);
  const decoderRef = useRef(new FountainDecoder());
  const scanningRef = useRef(false);
  const downloadUrlRef = useRef("");
  const scanStartedAtRef = useRef(0);
  const lastQrAtRef = useRef(0);
  const qrReadsRef = useRef(0);
  const acceptedFramesRef = useRef(0);
  const [state, setState] = useState<ScanState>("idle");
  const [progress, setProgress] = useState(0);
  const [solved, setSolved] = useState(0);
  const [frames, setFrames] = useState(0);
  const [qrReads, setQrReads] = useState(0);
  const [badFrames, setBadFrames] = useState(0);
  const [meta, setMeta] = useState<TransferMeta>();
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");
  const [guidance, setGuidance] = useState("Center the entire QR inside the four corners.");
  const [detectorMode, setDetectorMode] = useState<DetectorMode>("software");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const stopCamera = useCallback(() => {
    scanningRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
  }, []);

  const finishTransfer = useCallback(() => {
    const decoder = decoderRef.current;
    const bytes = decoder.result();
    const type = decoder.meta?.mime || "application/octet-stream";
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = url;
    setDownloadUrl(url);
    setProgress(1);
    setGuidance("File checksum verified. It is safe to save.");
    setState("complete");
    stopCamera();
    navigator.vibrate?.([80, 40, 120]);
  }, [stopCamera]);

  const acceptQrValue = useCallback(
    (value: string) => {
      qrReadsRef.current += 1;
      lastQrAtRef.current = performance.now();
      setQrReads(qrReadsRef.current);

      if (value.startsWith(LEGACY_FRAME_PREFIX)) {
        setGuidance("An older QRFerry sender is visible. Reload the sending screen, then restart its stream.");
        return;
      }
      if (!value.startsWith(FRAME_PREFIX)) {
        setGuidance("A QR code is visible, but it is not a QRFerry transfer.");
        return;
      }

      try {
        const droplet = decodeDroplet(value);
        const result = decoderRef.current.receive(droplet);
        if (result.accepted) {
          acceptedFramesRef.current += 1;
          setMeta(droplet.meta);
          setFrames(acceptedFramesRef.current);
          setSolved(result.solved);
          setProgress(result.total ? result.solved / result.total : 0);
          setGuidance(
            result.solved === 0
              ? "QR locked. Keep the phone steady while repair frames arrive."
              : "Signal locked. Keep the full QR inside the corners.",
          );
          setState(result.complete ? "complete" : "receiving");
          if (result.complete) finishTransfer();
        } else if (result.duplicate) {
          setGuidance("QR locked. Waiting for the sending screen to advance.");
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        setBadFrames((current) => current + 1);
        setGuidance("QR found, but this frame was blurred. Hold steady—the next one can replace it.");
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

        // The on-screen reticle is square. Cropping to the matching central
        // camera region makes each QR module substantially larger for decoders.
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

        let nativeRead = false;
        if (detectorRef.current) {
          try {
            const barcodes = await detectorRef.current.detect(canvas);
            for (const barcode of barcodes) {
              if (barcode.rawValue) {
                nativeRead = true;
                acceptQrValue(barcode.rawValue);
                break;
              }
            }
          } catch {
            detectorRef.current = undefined;
            setDetectorMode("software");
          }
        }

        if (!nativeRead) {
          const image = context.getImageData(0, 0, scanSize, scanSize);
          const code = jsQR(image.data, image.width, image.height, {
            inversionAttempts: "attemptBoth",
          });
          if (code?.data) acceptQrValue(code.data);
        }
      };

      void runScan().finally(() => {
        if (scanningRef.current) {
          window.setTimeout(
            () => window.requestAnimationFrame(scanVideoFrame),
            35,
          );
        }
      });
    },
    [acceptQrValue],
  );

  const startCamera = useCallback(async () => {
    setError("");
    setGuidance("Center the entire QR inside the four corners.");
    setState("starting");
    decoderRef.current = new FountainDecoder();
    qrReadsRef.current = 0;
    acceptedFramesRef.current = 0;
    lastQrAtRef.current = 0;
    scanStartedAtRef.current = performance.now();
    setMeta(undefined);
    setProgress(0);
    setSolved(0);
    setFrames(0);
    setQrReads(0);
    setBadFrames(0);
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
        setGuidance("No QR detected. Use Robust mode, move closer, and keep all four white margins visible.");
      } else if (elapsed > 4000) {
        setGuidance("Still looking. Move closer until the QR nearly fills the guide.");
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

  return (
    <main className="scanner-page">
      <section className="scanner-intro">
        <p className="eyebrow">MOBILE RECEIVER</p>
        <h1>{complete ? "File recovered." : "Point. Hold. Receive."}</h1>
        <p>
          {complete
            ? "Every block passed its checksum. Save the original file to this device."
            : "Keep the moving QR inside the frame. Missed and blurry frames are replaced automatically."}
        </p>
      </section>

      <section className="scanner-shell">
        <div className={`camera-view ${active ? "active" : ""} ${complete ? "complete" : ""}`}>
          <video ref={videoRef} playsInline muted aria-label="Rear camera preview" />
          <canvas ref={canvasRef} hidden />
          <div className="scan-reticle" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
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
                ? "Receiving repair frames"
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

          {meta ? (
            <div className="incoming-file">
              <span className="file-glyph" aria-hidden="true">↓</span>
              <div>
                <strong>{meta.filename}</strong>
                <span>
                  {formatBytes(meta.fileSize)} · {solved.toLocaleString()} of {meta.blockCount.toLocaleString()} blocks
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
        <div><span>1</span><p>Use Robust mode first and turn screen brightness up.</p></div>
        <div><span>2</span><p>Move close enough that the QR nearly fills the guide.</p></div>
        <div><span>3</span><p>Keep every white margin visible until frames are accepted.</p></div>
      </section>
    </main>
  );
}
