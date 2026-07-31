"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decompressTransfer } from "@/lib/compression";
import {
  crc32,
  formatBytes,
  formatRate,
  OpticalFileMeta,
  parseOpticalContainer,
  parseOpticalFrame,
  raptorPacketKey,
} from "@/lib/optical-transfer";

type ScanState =
  | "idle"
  | "starting"
  | "scanning"
  | "receiving"
  | "complete"
  | "error";
type RateSample = { at: number; bytes: number };
type RaptorDecoder = { push(payload: Uint8Array): Uint8Array | null };
type ReceiverSession = {
  session: number;
  containerLength: number;
  originalSize: number;
  compressed: boolean;
  symbolSize: number;
  sourcePacketCount: number;
  decoder: RaptorDecoder;
  seen: Set<string>;
};
type IncomingMeta = Omit<ReceiverSession, "decoder" | "seen">;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: unknown) => void,
  ) => number;
};

function updateRollingRate(samples: RateSample[], bytes: number) {
  const now = performance.now();
  samples.push({ at: now, bytes });
  while (samples.length > 1 && now - samples[0].at > 4000) samples.shift();
  const elapsed = Math.max(750, now - samples[0].at);
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
  const receiverRef = useRef<ReceiverSession | undefined>(undefined);
  const scanningRef = useRef(false);
  const completingRef = useRef(false);
  const downloadUrlRef = useRef("");
  const scanStartedAtRef = useRef(0);
  const lastQrAtRef = useRef(0);
  const qrReadsRef = useRef(0);
  const acceptedFramesRef = useRef(0);
  const missedExposuresRef = useRef(0);
  const decodeFailuresRef = useRef(0);
  const rateSamplesRef = useRef<RateSample[]>([]);
  const [state, setState] = useState<ScanState>("idle");
  const [progress, setProgress] = useState(0);
  const [frames, setFrames] = useState(0);
  const [qrReads, setQrReads] = useState(0);
  const [missedExposures, setMissedExposures] = useState(0);
  const [badFrames, setBadFrames] = useState(0);
  const [opticalRate, setOpticalRate] = useState(0);
  const [incoming, setIncoming] = useState<IncomingMeta>();
  const [fileMeta, setFileMeta] = useState<OpticalFileMeta>();
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");
  const [guidance, setGuidance] = useState(
    "Center the complete QR inside the four corners.",
  );
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const stopCamera = useCallback(() => {
    scanningRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
  }, []);

  const finishTransfer = useCallback(
    async (container: Uint8Array, session: ReceiverSession) => {
      if (completingRef.current) return;
      completingRef.current = true;
      try {
        setGuidance(
          session.compressed
            ? "Optical transfer complete. Decompressing and verifying…"
            : "Optical transfer complete. Verifying the file…",
        );
        if (
          container.length !== session.containerLength ||
          crc32(container) !== session.session
        ) {
          throw new Error("The recovered RaptorQ object failed its checksum.");
        }
        const recovered = parseOpticalContainer(container);
        const bytes = await decompressTransfer(
          recovered.transmitted,
          recovered.meta.compression,
        );
        if (
          bytes.length !== recovered.meta.fileSize ||
          crc32(bytes) !== recovered.meta.fileCrc
        ) {
          throw new Error("The recovered file checksum did not match.");
        }

        const fileBytes = Uint8Array.from(bytes);
        const url = URL.createObjectURL(
          new Blob([fileBytes.buffer], { type: recovered.meta.mime }),
        );
        if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
        downloadUrlRef.current = url;
        setFileMeta(recovered.meta);
        setDownloadUrl(url);
        setProgress(1);
        setGuidance("File decompressed and checksum verified. It is safe to save.");
        setState("complete");
        stopCamera();
        navigator.vibrate?.([80, 40, 120]);
      } catch (cause) {
        setState("error");
        setError(
          cause instanceof Error ? cause.message : "File verification failed.",
        );
        stopCamera();
      } finally {
        completingRef.current = false;
      }
    },
    [stopCamera],
  );

  const acceptQrBytes = useCallback(
    async (bytes: Uint8Array) => {
      qrReadsRef.current += 1;
      lastQrAtRef.current = performance.now();
      setQrReads(qrReadsRef.current);

      let frame;
      try {
        frame = parseOpticalFrame(bytes);
      } catch {
        const textPrefix = new TextDecoder().decode(bytes.subarray(0, 8));
        if (textPrefix.startsWith("QF2") || textPrefix.startsWith("QF3")) {
          setGuidance("An older QRFerry sender is visible. Reload the sending screen.");
          return;
        }
        setBadFrames((current) => current + 1);
        setGuidance("A frame was incomplete. Hold steady—the next one can replace it.");
        return;
      }

      let receiver = receiverRef.current;
      if (!receiver) {
        const { RaptorQWasmDecoder } = await import(
          "@raptorqr/core/fec/raptorq_wasm"
        );
        const decoder = await RaptorQWasmDecoder.create(
          frame.containerLength,
          frame.symbolSize,
        );
        receiver = {
          session: frame.session,
          containerLength: frame.containerLength,
          originalSize: frame.originalSize,
          compressed: frame.compressed,
          symbolSize: frame.symbolSize,
          sourcePacketCount: Math.max(
            1,
            Math.ceil(frame.containerLength / (frame.symbolSize - 4)),
          ),
          decoder,
          seen: new Set<string>(),
        };
        receiverRef.current = receiver;
        setIncoming({
          session: receiver.session,
          containerLength: receiver.containerLength,
          originalSize: receiver.originalSize,
          compressed: receiver.compressed,
          symbolSize: receiver.symbolSize,
          sourcePacketCount: receiver.sourcePacketCount,
        });
        setGuidance("RaptorQ locked. Keep the full white margin visible.");
        setState("receiving");
      }

      if (
        frame.session !== receiver.session ||
        frame.containerLength !== receiver.containerLength ||
        frame.symbolSize !== receiver.symbolSize
      ) {
        setGuidance("A different transfer crossed the camera view. Stay on one sender.");
        return;
      }

      const key = raptorPacketKey(frame);
      if (receiver.seen.has(key)) {
        setGuidance("Signal locked. Waiting for a new RaptorQ symbol.");
        return;
      }
      receiver.seen.add(key);
      acceptedFramesRef.current += 1;
      const accepted = acceptedFramesRef.current;
      const sourceBytes = Math.max(1, frame.symbolSize - 4);
      const rate = updateRollingRate(rateSamplesRef.current, sourceBytes);
      const estimatedProgress = Math.min(
        0.99,
        accepted / (receiver.sourcePacketCount + 2),
      );
      setFrames(accepted);
      setOpticalRate(rate);
      setProgress(estimatedProgress);
      setGuidance("Signal locked. RaptorQ is absorbing dropped exposures.");
      setState("receiving");

      const decoded = receiver.decoder.push(frame.payload);
      if (decoded) await finishTransfer(decoded, receiver);
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

        const sourceSize = Math.floor(
          Math.min(video.videoWidth, video.videoHeight) * 0.96,
        );
        const sourceX = Math.floor((video.videoWidth - sourceSize) / 2);
        const sourceY = Math.floor((video.videoHeight - sourceSize) / 2);
        const scanSize = Math.min(960, sourceSize);
        canvas.width = scanSize;
        canvas.height = scanSize;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.imageSmoothingEnabled = false;
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

        const image = context.getImageData(0, 0, scanSize, scanSize);
        const robustAttempt = decodeFailuresRef.current % 6 === 5;
        const { scanRawQr } = await import("@/lib/qr-scanner");
        const decoded = await scanRawQr(image, robustAttempt);

        if (!decoded) {
          decodeFailuresRef.current += 1;
          missedExposuresRef.current += 1;
          if (missedExposuresRef.current % 5 === 0) {
            setMissedExposures(missedExposuresRef.current);
          }
          return;
        }
        decodeFailuresRef.current = 0;
        await acceptQrBytes(decoded);
      };

      void runScan()
        .catch(() => {
          decodeFailuresRef.current += 1;
          missedExposuresRef.current += 1;
        })
        .finally(() => {
          if (!scanningRef.current) return;
          const video = videoRef.current as VideoWithFrameCallback | null;
          if (video?.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(() => scanVideoFrame());
          } else {
            window.requestAnimationFrame(scanVideoFrame);
          }
        });
    },
    [acceptQrBytes],
  );

  const startCamera = useCallback(async () => {
    setError("");
    setGuidance("Center the complete QR inside the four corners.");
    setState("starting");
    receiverRef.current = undefined;
    completingRef.current = false;
    qrReadsRef.current = 0;
    acceptedFramesRef.current = 0;
    missedExposuresRef.current = 0;
    decodeFailuresRef.current = 0;
    rateSamplesRef.current = [];
    lastQrAtRef.current = 0;
    scanStartedAtRef.current = performance.now();
    setIncoming(undefined);
    setFileMeta(undefined);
    setProgress(0);
    setFrames(0);
    setQrReads(0);
    setMissedExposures(0);
    setBadFrames(0);
    setOpticalRate(0);
    setTorchOn(false);
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = "";
      setDownloadUrl("");
    }

    try {
      const decoderLoad = import("@/lib/qr-scanner").then(({ prepareQrScanner }) =>
        prepareQrScanner(),
      );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60, min: 24 },
        },
      });
      await decoderLoad;
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
      const video = videoRef.current as VideoWithFrameCallback | null;
      if (video?.requestVideoFrameCallback) {
        video.requestVideoFrameCallback(() => scanVideo());
      } else {
        window.requestAnimationFrame(scanVideo);
      }
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
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
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
        setGuidance("No frame decoded. Use Robust mode, move closer, and keep the white margin visible.");
      } else if (elapsed > 4000) {
        setGuidance("Still looking. Move closer until the single QR nearly fills the guide.");
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
  const active =
    state === "scanning" || state === "receiving" || state === "starting";
  const compressionRatio =
    incoming && incoming.containerLength > 0
      ? incoming.originalSize / incoming.containerLength
      : 1;
  const effectiveRate = opticalRate * compressionRatio;
  const recoveredBytes = incoming
    ? Math.min(
        incoming.containerLength,
        frames * Math.max(1, incoming.symbolSize - 4),
      )
    : 0;
  const etaSeconds =
    incoming && opticalRate > 0
      ? (incoming.containerLength - recoveredBytes) / opticalRate
      : Number.POSITIVE_INFINITY;
  const compressionPercent =
    incoming && incoming.originalSize > 0
      ? Math.max(
          0,
          Math.round(
            (1 - incoming.containerLength / incoming.originalSize) * 100,
          ),
        )
      : 0;

  return (
    <main className="scanner-page">
      <section className="scanner-intro">
        <p className="eyebrow">RAPTORQ MOBILE RECEIVER</p>
        <h1>{complete ? "File recovered." : "Point. Hold. Receive."}</h1>
        <p>
          {complete
            ? "The RaptorQ object and original file both passed end-to-end checksums."
            : "A native-speed scanner reads one raw-binary QR per exposure; missed frames do not matter."}
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
          {state === "starting" ? <div className="camera-loading">Loading optical decoder…</div> : null}
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
                ? "Receiving RaptorQ symbols"
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
              <span>Effective file rate</span>
              <strong>{effectiveRate > 0 ? formatRate(effectiveRate) : "—"}</strong>
              <small>
                {incoming?.compressed
                  ? `${formatRate(opticalRate)} optical · ${compressionPercent}% compressed`
                  : `${formatRate(opticalRate)} accepted optical data`}
              </small>
            </div>
            <div>
              <span>Estimated remaining</span>
              <strong>{complete ? "Complete" : formatEta(etaSeconds)}</strong>
              <small>
                {incoming
                  ? `${formatBytes(recoveredBytes)} of ${formatBytes(incoming.containerLength)} encoded`
                  : "Waiting for first RaptorQ symbol"}
              </small>
            </div>
          </div>

          {incoming ? (
            <div className="incoming-file">
              <span className="file-glyph" aria-hidden="true">↓</span>
              <div>
                <strong>{fileMeta?.filename || "Incoming file"}</strong>
                <span>
                  {formatBytes(incoming.originalSize)}
                  {incoming.compressed ? ` · ${compressionPercent}% compression` : ""}
                  {" · "}
                  {frames.toLocaleString()} / ~{incoming.sourcePacketCount.toLocaleString()} symbols
                </span>
              </div>
              <b>RQ</b>
            </div>
          ) : null}

          <div className="scan-diagnostics" aria-live="polite">
            <span><b>{qrReads}</b> QR reads</span>
            <span><b>{frames}</b> unique</span>
            <span><b>{missedExposures}</b> missed</span>
            <span><b>{badFrames}</b> rejected</span>
          </div>
          <p className="scan-hint">{guidance}</p>

          {error ? <p className="error-message" role="alert">{error}</p> : null}

          {complete && downloadUrl && fileMeta ? (
            <a className="primary-action" href={downloadUrl} download={fileMeta.filename}>
              <span aria-hidden="true">↓</span>
              Save {fileMeta.filename}
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
              {state === "starting" ? "Loading…" : active ? "Stop camera" : "Start camera"}
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
        <div><span>1</span><p>Use Turbo when a single QR stays sharp and nearly fills the guide.</p></div>
        <div><span>2</span><p>The rate shown is measured from unique camera-decoded symbols.</p></div>
        <div><span>3</span><p>If the missed counter climbs faster than unique reads, step down one mode.</p></div>
      </section>
    </main>
  );
}
