"use client";

import QRCode from "qrcode";
import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createDroplet,
  createTransferSource,
  encodeDroplet,
  formatBytes,
  MAX_FILE_BYTES,
  TransferSource,
} from "@/lib/qr-transfer";
import {
  TRANSFER_PRESETS,
  TransferPresetKey,
} from "@/lib/transfer-presets";

function estimateDuration(
  source: TransferSource,
  preset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
) {
  const usefulFramesPerSecond = preset.fps * 0.68;
  const seconds = source.meta.blockCount / usefulFramesPerSecond;
  if (seconds < 60) return `about ${Math.max(1, Math.ceil(seconds))} sec`;
  const minutes = seconds / 60;
  return `about ${minutes >= 10 ? Math.ceil(minutes) : minutes.toFixed(1)} min`;
}

export function SendClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrStageRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<TransferSource | undefined>(undefined);
  const sequenceRef = useRef(0);
  const [fileData, setFileData] = useState<{ file: File; bytes: Uint8Array }>();
  const [source, setSource] = useState<TransferSource>();
  const [presetKey, setPresetKey] = useState<TransferPresetKey>("robust");
  const [playing, setPlaying] = useState(false);
  const [frameNumber, setFrameNumber] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const preset = TRANSFER_PRESETS[presetKey];

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  const prepareFile = useCallback(
    async (file: File) => {
      setError("");
      setPlaying(false);
      if (file.size > MAX_FILE_BYTES) {
        setError("Choose a file smaller than 512 MB for this browser-based build.");
        return;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const nextSource = createTransferSource(bytes, {
          filename: file.name,
          mime: file.type || "application/octet-stream",
          blockSize: preset.blockSize,
        });
        setFileData({ file, bytes });
        setSource(nextSource);
        sourceRef.current = nextSource;
        sequenceRef.current = 0;
        setFrameNumber(0);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The file could not be prepared.");
      }
    },
    [preset.blockSize],
  );

  const changePreset = (nextKey: TransferPresetKey) => {
    setPresetKey(nextKey);
    setPlaying(false);
    if (fileData) {
      const next = TRANSFER_PRESETS[nextKey];
      const nextSource = createTransferSource(fileData.bytes, {
        filename: fileData.file.name,
        mime: fileData.file.type || "application/octet-stream",
        blockSize: next.blockSize,
      });
      setSource(nextSource);
      sourceRef.current = nextSource;
      sequenceRef.current = 0;
      setFrameNumber(0);
    }
  };

  const renderFrame = useCallback(
    async (target: TransferSource, sequence: number) => {
      if (!canvasRef.current) return;
      const encoded = encodeDroplet(createDroplet(target, sequence));
      await QRCode.toCanvas(canvasRef.current, encoded, {
        width: 900,
        margin: 6,
        errorCorrectionLevel: preset.ecc,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      });
    },
    [preset.ecc],
  );

  useEffect(() => {
    if (!source) return;
    renderFrame(source, sequenceRef.current).catch(() => {
      setError("The QR frame could not be rendered.");
    });
  }, [source, preset.ecc, renderFrame]);

  useEffect(() => {
    if (!playing || !source) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = 1000 / preset.fps;

    const tick = async () => {
      const started = performance.now();
      const activeSource = sourceRef.current;
      if (!activeSource || cancelled) return;
      try {
        await renderFrame(activeSource, sequenceRef.current);
        sequenceRef.current = (sequenceRef.current + 1) >>> 0;
        if (sequenceRef.current === 0) sequenceRef.current = activeSource.meta.blockCount;
        setFrameNumber(sequenceRef.current);
      } catch {
        setError("QR rendering paused after an unexpected error.");
        setPlaying(false);
        return;
      }
      const remaining = Math.max(0, interval - (performance.now() - started));
      timer = setTimeout(tick, remaining);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [playing, preset.fps, renderFrame, source]);

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) prepareFile(file);
  };

  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) prepareFile(file);
  };

  const scanUrl = useMemo(() => {
    if (typeof window === "undefined") return "/scan";
    return `${window.location.origin}/scan`;
  }, []);

  const copyScanLink = async () => {
    try {
      await navigator.clipboard.writeText(scanUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Copy failed. Open this site on the phone and choose Scan.");
    }
  };

  const toggleFullscreen = async () => {
    if (!qrStageRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await qrStageRef.current.requestFullscreen();
  };

  return (
    <main>
      <section className="sender-hero">
        <div>
          <p className="eyebrow">AIR-GAPPED FILE TRANSFER</p>
          <h1>Move a file<br />through the camera.</h1>
        </div>
        <div className="hero-copy">
          <p>
            Your file stays on your devices. QRFerry turns it into a live stream
            of repairable QR frames—no account, cable, pairing, or cloud upload.
          </p>
          <div className="trust-row">
            <span>Local only</span>
            <span>Loss tolerant</span>
            <span>Open format</span>
          </div>
        </div>
      </section>

      <section className="sender-grid" aria-label="Create a QR transfer">
        <div className="control-panel">
          <div className="step-heading">
            <span>01</span>
            <div>
              <h2>Choose a file</h2>
              <p>Nothing leaves this browser.</p>
            </div>
          </div>

          <div
            className={`drop-zone ${dragging ? "dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={dropFile}
          >
            <input
              ref={inputRef}
              type="file"
              onChange={selectFile}
              aria-label="Choose a file to transfer"
            />
            <button className="file-button" type="button" onClick={() => inputRef.current?.click()}>
              <span aria-hidden="true">＋</span>
              Browse files
            </button>
            <p>or drop one here · up to 512 MB</p>
          </div>

          {fileData && source ? (
            <div className="selected-file">
              <span className="file-glyph" aria-hidden="true">↗</span>
              <div>
                <strong>{fileData.file.name}</strong>
                <span>
                  {formatBytes(fileData.file.size)} · {source.meta.blockCount.toLocaleString()} source blocks
                </span>
              </div>
              <button type="button" onClick={() => inputRef.current?.click()}>
                Change
              </button>
            </div>
          ) : null}

          <div className="step-heading compact">
            <span>02</span>
            <div>
              <h2>Tune the signal</h2>
              <p>Start Robust. Move up only after the phone reads frames.</p>
            </div>
          </div>

          <div className="preset-list" role="radiogroup" aria-label="Signal preset">
            {(Object.keys(TRANSFER_PRESETS) as TransferPresetKey[]).map((key) => {
              const option = TRANSFER_PRESETS[key];
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={presetKey === key}
                  className={presetKey === key ? "selected" : ""}
                  key={key}
                  onClick={() => changePreset(key)}
                >
                  <span className="radio-dot" aria-hidden="true" />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                  <b>{option.fps} fps</b>
                </button>
              );
            })}
          </div>

          {error ? <p className="error-message" role="alert">{error}</p> : null}
        </div>

        <div className="qr-panel">
          <div className="step-heading inverse">
            <span>03</span>
            <div>
              <h2>Play the QR stream</h2>
              <p>Open Scan on the receiving phone and point it here.</p>
            </div>
          </div>

          <div ref={qrStageRef} className={`qr-stage ${source ? "ready" : ""}`}>
            {source ? (
              <canvas ref={canvasRef} aria-label="Animated QR transfer" />
            ) : (
              <div className="qr-placeholder" aria-hidden="true">
                <div className="finder top-left" />
                <div className="finder top-right" />
                <div className="finder bottom-left" />
                <span>QR stream appears here</span>
              </div>
            )}
            <button
              className="fullscreen-button"
              type="button"
              onClick={toggleFullscreen}
              disabled={!source}
              aria-label="Show QR code fullscreen"
            >
              ⛶
            </button>
          </div>

          <div className="stream-status" aria-live="polite">
            <div>
              <span className={`pulse-dot ${playing ? "live" : ""}`} aria-hidden="true" />
              <strong>{playing ? "Broadcasting" : source ? "Ready to broadcast" : "Waiting for a file"}</strong>
            </div>
            <span>
              {source
                ? `${estimateDuration(source, preset)} · frame ${frameNumber.toLocaleString()}`
                : "Camera never needs a network connection"}
            </span>
          </div>

          <button
            className="primary-action"
            type="button"
            disabled={!source}
            onClick={() => setPlaying((current) => !current)}
          >
            <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
            {playing ? "Pause stream" : "Start QR stream"}
          </button>

          <button className="link-action" type="button" onClick={copyScanLink}>
            <span aria-hidden="true">⌁</span>
            {copied ? "Scanner link copied" : "Copy mobile scanner link"}
          </button>
        </div>
      </section>

      <section className="how-it-works">
        <p className="eyebrow">WHY IT KEEPS WORKING</p>
        <div className="how-grid">
          <h2>Miss a frame.<br />Catch the next one.</h2>
          <div className="feature">
            <span>01</span>
            <h3>Repair frames</h3>
            <p>Fresh fountain-code frames rebuild data the camera missed. Order does not matter.</p>
          </div>
          <div className="feature">
            <span>02</span>
            <h3>Frame checksums</h3>
            <p>Motion-blurred or damaged frames are rejected before they can touch the file.</p>
          </div>
          <div className="feature">
            <span>03</span>
            <h3>Adaptive density</h3>
            <p>Trade speed for larger QR modules and stronger correction whenever conditions demand it.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
