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
import { compressForTransfer, CompressionMode } from "@/lib/compression";
import {
  crc32,
  createDroplet,
  createTransferSource,
  encodeDescriptor,
  encodeDroplet,
  formatBytes,
  formatRate,
  MAX_FILE_BYTES,
  TransferSource,
} from "@/lib/qr-transfer";
import {
  TRANSFER_PRESETS,
  TransferPresetKey,
} from "@/lib/transfer-presets";

type PreparedFile = {
  file: File;
  transferBytes: Uint8Array;
  compression: CompressionMode;
  originalCrc: number;
};

function descriptorCadence(lanes: number) {
  return lanes === 1 ? 8 : 16;
}

function dataFramesPerSecond(
  preset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
) {
  return preset.fps * (preset.lanes - 1 / descriptorCadence(preset.lanes));
}

function estimateDuration(
  source: TransferSource,
  preset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
) {
  const usefulFramesPerSecond = dataFramesPerSecond(preset) * 0.68;
  const seconds = source.meta.blockCount / usefulFramesPerSecond;
  if (seconds < 60) return `about ${Math.max(1, Math.ceil(seconds))} sec`;
  const minutes = seconds / 60;
  return `about ${minutes >= 10 ? Math.ceil(minutes) : minutes.toFixed(1)} min`;
}

export function SendClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const qrStageRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<TransferSource | undefined>(undefined);
  const sequenceRef = useRef(0);
  const batchRef = useRef(0);
  const [fileData, setFileData] = useState<PreparedFile>();
  const [source, setSource] = useState<TransferSource>();
  const [presetKey, setPresetKey] = useState<TransferPresetKey>("robust");
  const [playing, setPlaying] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [frameNumber, setFrameNumber] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const preset = TRANSFER_PRESETS[presetKey];

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  const makeSource = useCallback(
    (
      prepared: PreparedFile,
      nextPreset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
    ) =>
      createTransferSource(prepared.transferBytes, {
        filename: prepared.file.name,
        mime: prepared.file.type || "application/octet-stream",
        blockSize: nextPreset.blockSize,
        originalSize: prepared.file.size,
        originalCrc: prepared.originalCrc,
        compression: prepared.compression,
      }),
    [],
  );

  const resetBroadcast = (nextSource: TransferSource) => {
    setSource(nextSource);
    sourceRef.current = nextSource;
    sequenceRef.current = 0;
    batchRef.current = 0;
    setFrameNumber(0);
  };

  const prepareFile = useCallback(
    async (file: File) => {
      setError("");
      setPlaying(false);
      if (file.size > MAX_FILE_BYTES) {
        setError("Choose a file smaller than 512 MB for this browser-based build.");
        return;
      }
      setProcessing(true);
      try {
        const originalBytes = new Uint8Array(await file.arrayBuffer());
        const originalCrc = crc32(originalBytes);
        const compressed = await compressForTransfer(originalBytes);
        const prepared: PreparedFile = {
          file,
          transferBytes: compressed.bytes,
          compression: compressed.mode,
          originalCrc,
        };
        const nextSource = makeSource(prepared, preset);
        setFileData(prepared);
        resetBroadcast(nextSource);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The file could not be prepared.");
      } finally {
        setProcessing(false);
      }
    },
    [makeSource, preset],
  );

  const changePreset = (nextKey: TransferPresetKey) => {
    setPresetKey(nextKey);
    setPlaying(false);
    if (fileData) resetBroadcast(makeSource(fileData, TRANSFER_PRESETS[nextKey]));
  };

  const renderCode = useCallback(
    async (
      canvas: HTMLCanvasElement | null,
      encoded: string,
      errorCorrectionLevel: "L" | "M" | "Q" | "H",
      lanes: number,
    ) => {
      if (!canvas) return;
      await QRCode.toCanvas(canvas, encoded, {
        width: lanes === 1 ? 900 : 440,
        margin: lanes === 1 ? 6 : 4,
        errorCorrectionLevel,
        color: { dark: "#000000", light: "#ffffff" },
      });
    },
    [],
  );

  const renderPreview = useCallback(
    async (target: TransferSource) => {
      const descriptor = encodeDescriptor(target);
      await Promise.all(
        Array.from({ length: preset.lanes }, (_, lane) =>
          renderCode(canvasRefs.current[lane], descriptor, "H", preset.lanes),
        ),
      );
    },
    [preset.lanes, renderCode],
  );

  const renderBatch = useCallback(
    async (target: TransferSource) => {
      const cadence = descriptorCadence(preset.lanes);
      let nextSequence = sequenceRef.current;
      const currentBatch = batchRef.current;
      const renders = Array.from({ length: preset.lanes }, (_, lane) => {
        const isDescriptor = lane === 0 && currentBatch % cadence === 0;
        if (isDescriptor) {
          return renderCode(
            canvasRefs.current[lane],
            encodeDescriptor(target),
            "H",
            preset.lanes,
          );
        }
        const encoded = encodeDroplet(createDroplet(target, nextSequence));
        nextSequence = (nextSequence + 1) >>> 0;
        if (nextSequence === 0) nextSequence = target.meta.blockCount;
        return renderCode(
          canvasRefs.current[lane],
          encoded,
          preset.ecc,
          preset.lanes,
        );
      });
      await Promise.all(renders);
      sequenceRef.current = nextSequence;
      batchRef.current = currentBatch + 1;
      setFrameNumber(nextSequence);
    },
    [preset.ecc, preset.lanes, renderCode],
  );

  useEffect(() => {
    if (!source) return;
    renderPreview(source).catch(() => setError("The QR preview could not be rendered."));
  }, [renderPreview, source]);

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
        await renderBatch(activeSource);
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
  }, [playing, preset.fps, renderBatch, source]);

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void prepareFile(file);
  };

  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void prepareFile(file);
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

  const systematicProgress = source
    ? Math.min(1, frameNumber / source.meta.blockCount)
    : 0;
  const repairFrames = source
    ? Math.max(0, frameNumber - source.meta.blockCount)
    : 0;
  const compressionPercent =
    source && source.meta.fileSize > 0
      ? Math.round((1 - source.meta.transmittedSize / source.meta.fileSize) * 100)
      : 0;
  const nominalRate = preset.blockSize * dataFramesPerSecond(preset);

  return (
    <main>
      <section className="sender-hero">
        <div>
          <p className="eyebrow">AIR-GAPPED FILE TRANSFER</p>
          <h1>Move a file<br />through the camera.</h1>
        </div>
        <div className="hero-copy">
          <p>
            Your file stays on your devices. QRFerry compresses it, then moves
            compact repair frames through one or four parallel QR channels.
          </p>
          <div className="trust-row">
            <span>Local only</span>
            <span>Level-9 compression</span>
            <span>4× spatial lanes</span>
          </div>
        </div>
      </section>

      <section className="sender-grid" aria-label="Create a QR transfer">
        <div className="control-panel">
          <div className="step-heading">
            <span>01</span>
            <div>
              <h2>Choose a file</h2>
              <p>Compression and encoding stay in this browser.</p>
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
            <button
              className="file-button"
              type="button"
              disabled={processing}
              onClick={() => inputRef.current?.click()}
            >
              <span aria-hidden="true">{processing ? "…" : "＋"}</span>
              {processing ? "Compressing at level 9" : "Browse files"}
            </button>
            <p>or drop one here · up to 512 MB</p>
          </div>

          {fileData && source ? (
            <div className="selected-file">
              <span className="file-glyph" aria-hidden="true">↗</span>
              <div>
                <strong>{fileData.file.name}</strong>
                <span>
                  {formatBytes(source.meta.fileSize)}
                  {source.meta.compression === "gzip"
                    ? ` → ${formatBytes(source.meta.transmittedSize)} · ${compressionPercent}% smaller`
                    : " · already compressed"}
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
              <h2>Tune the channel</h2>
              <p>Turbo uses four independently recoverable QR lanes.</p>
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
                  <b>{option.lanes}× · {formatRate(option.blockSize * option.fps * option.lanes)}</b>
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
              <p>{preset.lanes === 4 ? "Keep all four codes inside the phone guide." : "Keep the complete code inside the phone guide."}</p>
            </div>
          </div>

          <div
            ref={qrStageRef}
            className={`qr-stage ${source ? "ready" : ""} lanes-${preset.lanes}`}
          >
            {source ? (
              <div className={`qr-canvas-grid lanes-${preset.lanes}`}>
                {Array.from({ length: preset.lanes }, (_, lane) => (
                  <canvas
                    key={`${presetKey}-${lane}`}
                    ref={(element) => {
                      canvasRefs.current[lane] = element;
                    }}
                    aria-label={`Animated QR transfer lane ${lane + 1}`}
                  />
                ))}
              </div>
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
                ? `${estimateDuration(source, preset)} · ${formatRate(nominalRate)} nominal`
                : "Camera never needs a network connection"}
            </span>
          </div>

          {source ? (
            <div className="broadcast-progress">
              <div>
                <strong>
                  {frameNumber < source.meta.blockCount
                    ? "Systematic source pass"
                    : "Loss-repair pass"}
                </strong>
                <span>
                  {frameNumber < source.meta.blockCount
                    ? `${frameNumber.toLocaleString()} / ${source.meta.blockCount.toLocaleString()} frames`
                    : `source complete · ${repairFrames.toLocaleString()} repair frames`}
                </span>
              </div>
              <div className="broadcast-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(systematicProgress * 100)}>
                <span style={{ width: `${systematicProgress * 100}%` }} />
              </div>
            </div>
          ) : null}

          <button
            className="primary-action"
            type="button"
            disabled={!source || processing}
            onClick={() => setPlaying((current) => !current)}
          >
            <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
            {playing ? "Pause stream" : `Start ${preset.lanes === 4 ? "4-lane " : ""}QR stream`}
          </button>

          <button className="link-action" type="button" onClick={copyScanLink}>
            <span aria-hidden="true">⌁</span>
            {copied ? "Scanner link copied" : "Copy mobile scanner link"}
          </button>
        </div>
      </section>

      <section className="how-it-works">
        <p className="eyebrow">CLOSER TO THE OPTICAL LIMIT</p>
        <div className="how-grid">
          <h2>More useful bits.<br />Every exposure.</h2>
          <div className="feature">
            <span>01</span>
            <h3>Compress first</h3>
            <p>Level-9 DEFLATE removes redundancy before a single optical frame is spent.</p>
          </div>
          <div className="feature">
            <span>02</span>
            <h3>Spatial multiplexing</h3>
            <p>Turbo carries four compact QR symbols per camera exposure instead of over-densifying one.</p>
          </div>
          <div className="feature">
            <span>03</span>
            <h3>Compact fountain frames</h3>
            <p>Metadata beacons are separated from payload frames; repair data continues until every block verifies.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
