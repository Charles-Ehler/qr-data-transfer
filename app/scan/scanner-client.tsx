"use client";

import jsQR from "jsqr";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeDroplet,
  FountainDecoder,
  formatBytes,
  FRAME_PREFIX,
  TransferMeta,
} from "@/lib/qr-transfer";

type ScanState = "idle" | "starting" | "scanning" | "receiving" | "complete" | "error";

export function ScannerClient() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const decoderRef = useRef(new FountainDecoder());
  const scanningRef = useRef(false);
  const lastFrameAtRef = useRef(0);
  const downloadUrlRef = useRef("");
  const [state, setState] = useState<ScanState>("idle");
  const [progress, setProgress] = useState(0);
  const [solved, setSolved] = useState(0);
  const [frames, setFrames] = useState(0);
  const [meta, setMeta] = useState<TransferMeta>();
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");
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
    setState("complete");
    stopCamera();
    navigator.vibrate?.([80, 40, 120]);
  }, [stopCamera]);

  const scanVideo = useCallback(function scanVideoFrame() {
    if (!scanningRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const now = performance.now();
      if (now - lastFrameAtRef.current >= 70) {
        lastFrameAtRef.current = now;
        const maxDimension = 960;
        const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(image.data, image.width, image.height, {
            inversionAttempts: "dontInvert",
          });
          if (code?.data.startsWith(FRAME_PREFIX)) {
            try {
              const droplet = decodeDroplet(code.data);
              const result = decoderRef.current.receive(droplet);
              if (result.accepted) {
                setMeta(droplet.meta);
                setFrames((current) => current + 1);
                setSolved(result.solved);
                setProgress(result.total ? result.solved / result.total : 0);
                setState(result.complete ? "complete" : "receiving");
                if (result.complete) {
                  finishTransfer();
                  return;
                }
              }
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : "";
              if (message.includes("different transfer")) setError(message);
              // Bad checksums and partial camera reads are expected and ignored.
            }
          }
        }
      }
    }
    window.requestAnimationFrame(scanVideoFrame);
  }, [finishTransfer]);

  const startCamera = useCallback(async () => {
    setError("");
    setState("starting");
    decoderRef.current = new FountainDecoder();
    setMeta(undefined);
    setProgress(0);
    setSolved(0);
    setFrames(0);
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = "";
      setDownloadUrl("");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & {
        torch?: boolean;
      };
      setTorchAvailable(Boolean(capabilities?.torch));
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
          {complete ? (
            <div className="complete-mark" aria-hidden="true">✓</div>
          ) : null}
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
          ) : (
            <p className="scan-hint">Use the rear camera 20–60 cm from the sending screen.</p>
          )}

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
              onClick={active ? stopCamera : startCamera}
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
        <div><span>1</span><p>Turn the sending screen brightness up.</p></div>
        <div><span>2</span><p>Hold steady enough to keep the full QR visible.</p></div>
        <div><span>3</span><p>Stay on this page until the checksum reaches 100%.</p></div>
      </section>
    </main>
  );
}
