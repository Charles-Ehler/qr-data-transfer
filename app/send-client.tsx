"use client";

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { compressForTransfer } from "@/lib/compression";
import {
  buildOpticalContainer,
  createOpticalTransfer,
  formatBytes,
  formatRate,
  MAX_FILE_BYTES,
  OpticalTransfer,
  PreparedOpticalFile,
} from "@/lib/optical-transfer";
import {
  TRANSFER_PRESETS,
  TransferPresetKey,
} from "@/lib/transfer-presets";

type PreparedFile = {
  file: File;
  optical: PreparedOpticalFile;
};

function evenlyInterleave(source: number[], repair: number[]) {
  if (source.length === 0) return [...repair];
  if (repair.length === 0) return [...source];
  const order: number[] = [];
  let repairIndex = 0;
  let accumulator = 0;
  for (const sourceIndex of source) {
    order.push(sourceIndex);
    accumulator += repair.length;
    while (repairIndex < repair.length && accumulator >= source.length) {
      order.push(repair[repairIndex]);
      repairIndex += 1;
      accumulator -= source.length;
    }
  }
  while (repairIndex < repair.length) {
    order.push(repair[repairIndex]);
    repairIndex += 1;
  }
  return order;
}

function estimateDuration(
  transfer: OpticalTransfer,
  preset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
) {
  const seconds = transfer.sourcePacketCount / (preset.fps * 0.78);
  if (seconds < 60) return `about ${Math.max(1, Math.ceil(seconds))} sec`;
  const minutes = seconds / 60;
  return `about ${minutes >= 10 ? Math.ceil(minutes) : minutes.toFixed(1)} min`;
}

export function SendClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const qrStageRef = useRef<HTMLDivElement>(null);
  const transferRef = useRef<OpticalTransfer | undefined>(undefined);
  const orderRef = useRef<number[]>([]);
  const playedFramesRef = useRef(0);
  const broadcastFrameTimesRef = useRef<number[]>([]);
  const encodeJobRef = useRef(0);
  const [fileData, setFileData] = useState<PreparedFile>();
  const [transfer, setTransfer] = useState<OpticalTransfer>();
  const [presetKey, setPresetKey] = useState<TransferPresetKey>("robust");
  const [playing, setPlaying] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [playedFrames, setPlayedFrames] = useState(0);
  const [actualFps, setActualFps] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const preset = TRANSFER_PRESETS[presetKey];

  const installTransfer = useCallback((next: OpticalTransfer) => {
    const order = evenlyInterleave(
      next.sourcePacketIndices,
      next.repairPacketIndices,
    );
    transferRef.current = next;
    orderRef.current = order;
    playedFramesRef.current = 0;
    setPlayedFrames(0);
    setTransfer(next);
  }, []);

  const encodePrepared = useCallback(
    async (
      prepared: PreparedFile,
      nextPresetKey: TransferPresetKey,
    ) => {
      const job = encodeJobRef.current + 1;
      encodeJobRef.current = job;
      setProcessing(true);
      setError("");
      try {
        const nextPreset = TRANSFER_PRESETS[nextPresetKey];
        const next = await createOpticalTransfer(prepared.optical, {
          symbolSize: nextPreset.symbolSize,
          repairPercent: nextPreset.repairPercent,
        });
        if (encodeJobRef.current === job) installTransfer(next);
      } catch (cause) {
        if (encodeJobRef.current === job) {
          setTransfer(undefined);
          transferRef.current = undefined;
          setError(
            cause instanceof Error
              ? cause.message
              : "The RaptorQ stream could not be prepared.",
          );
        }
      } finally {
        if (encodeJobRef.current === job) setProcessing(false);
      }
    },
    [installTransfer],
  );

  const prepareFile = useCallback(
    async (file: File) => {
      setError("");
      setPlaying(false);
      setActualFps(0);
      if (file.size > MAX_FILE_BYTES) {
        setError("Choose a file smaller than 512 MB for this browser build.");
        return;
      }
      setProcessing(true);
      try {
        const original = new Uint8Array(await file.arrayBuffer());
        const compressed = await compressForTransfer(original);
        const prepared: PreparedFile = {
          file,
          optical: buildOpticalContainer(original, compressed.bytes, {
            filename: file.name,
            mime: file.type || "application/octet-stream",
            compression: compressed.mode,
          }),
        };
        setFileData(prepared);
        await encodePrepared(prepared, presetKey);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The file could not be prepared.",
        );
        setProcessing(false);
      }
    },
    [encodePrepared, presetKey],
  );

  const changePreset = (nextKey: TransferPresetKey) => {
    setPresetKey(nextKey);
    setPlaying(false);
    setActualFps(0);
    if (fileData) void encodePrepared(fileData, nextKey);
  };

  const renderPacket = useCallback(
    async (
      target: OpticalTransfer,
      packetIndex: number,
      activePreset: (typeof TRANSFER_PRESETS)[TransferPresetKey],
      laneIndex = 0,
    ) => {
      const canvas = canvasRefs.current[laneIndex];
      if (!canvas) return;
      const { renderRawQr } = await import("@/lib/qr-renderer");
      const image = await renderRawQr(
        target.packets[packetIndex],
        activePreset.version,
        activePreset.ecc,
        activePreset.renderScale,
      );
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("The QR drawing surface is unavailable.");
      context.putImageData(image, 0, 0);
    },
    [],
  );

  useEffect(() => {
    if (!transfer || orderRef.current.length === 0) return;
    void Promise.all(
      Array.from({ length: preset.lanes }, (_, laneIndex) =>
        renderPacket(
          transfer,
          orderRef.current[laneIndex % orderRef.current.length],
          preset,
          laneIndex,
        ),
      ),
    ).catch(() => setError("The QR preview could not be rendered."));
  }, [preset, renderPacket, transfer]);

  useEffect(() => {
    if (!playing || !transfer) return;
    let cancelled = false;
    let animationFrame = 0;
    const interval = 1000 / preset.fps;
    let nextFrameAt = performance.now();
    broadcastFrameTimesRef.current = [];

    const tick = async (now: number) => {
      if (now + 0.5 < nextFrameAt) {
        animationFrame = window.requestAnimationFrame(tick);
        return;
      }
      const activeTransfer = transferRef.current;
      const order = orderRef.current;
      if (!activeTransfer || order.length === 0 || cancelled) return;
      const packetIndex = order[playedFramesRef.current % order.length];
      const laneIndex = playedFramesRef.current % preset.lanes;
      try {
        await renderPacket(activeTransfer, packetIndex, preset, laneIndex);
      } catch {
        setError("QR rendering paused after an unexpected error.");
        setPlaying(false);
        return;
      }
      if (cancelled) return;
      playedFramesRef.current += 1;
      const completedAt = performance.now();
      const frameTimes = broadcastFrameTimesRef.current;
      frameTimes.push(completedAt);
      while (
        frameTimes.length > 2 &&
        completedAt - frameTimes[0] > 2500
      ) {
        frameTimes.shift();
      }

      const uiInterval = Math.max(1, Math.round(preset.fps / 10));
      if (playedFramesRef.current % uiInterval === 0) {
        setPlayedFrames(playedFramesRef.current);
        if (frameTimes.length > 1) {
          setActualFps(
            ((frameTimes.length - 1) * 1000) /
              (frameTimes[frameTimes.length - 1] - frameTimes[0]),
          );
        }
      }

      nextFrameAt += interval;
      if (nextFrameAt < completedAt - interval) {
        nextFrameAt = completedAt + interval;
      }
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
    };
  }, [playing, preset, renderPacket, transfer]);

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
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        setActualFps(0);
        setPlaying(true);
        await qrStageRef.current.requestFullscreen();
      }
    } catch {
      setPlaying(false);
      setError("Fullscreen is not available in this browser. Maximize the window instead.");
    }
  };

  const orderLength = transfer?.packets.length ?? 0;
  const cycleFrame =
    orderLength > 0
      ? playedFrames === 0
        ? 0
        : ((playedFrames - 1) % orderLength) + 1
      : 0;
  const cycleNumber =
    orderLength > 0 && playedFrames > 0
      ? Math.floor((playedFrames - 1) / orderLength) + 1
      : 1;
  const cycleProgress = orderLength ? cycleFrame / orderLength : 0;
  const compressionPercent =
    transfer && transfer.meta.fileSize > 0
      ? Math.max(
          0,
          Math.round(
            (1 - transfer.meta.transmittedSize / transfer.meta.fileSize) * 100,
          ),
        )
      : 0;
  const nominalRate = preset.usefulBytesPerFrame * preset.fps;

  return (
    <main>
      <section className="sender-hero">
        <div>
          <p className="eyebrow">AIR-GAPPED FILE TRANSFER</p>
          <h1>Move a file<br />through the camera.</h1>
        </div>
        <div className="hero-copy">
          <p>
            Your file stays on your devices. QRFerry compresses it, then sends
            raw binary through a loss-tolerant RaptorQ stream.
          </p>
          <div className="trust-row">
            <span>Local only</span>
            <span>Brotli-11 + gzip-9</span>
            <span>RaptorQ FEC</span>
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
              {processing ? "Compressing + building stream" : "Browse files"}
            </button>
            <p>or drop one here · up to 512 MB</p>
          </div>

          {fileData ? (
            <div className="selected-file">
              <span className="file-glyph" aria-hidden="true">↗</span>
              <div>
                <strong>{fileData.optical.meta.filename}</strong>
                <span>
                  {formatBytes(fileData.optical.meta.fileSize)}
                  {fileData.optical.meta.compression !== "none"
                    ? ` → ${formatBytes(fileData.optical.meta.transmittedSize)} · ${compressionPercent}% smaller · ${fileData.optical.meta.compression}`
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
              <p>Robust modes use one target; dual modes alternate two stable lanes.</p>
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
                  <b>
                    {option.lanes === 1
                      ? `${option.fps} fps`
                      : `${option.fps} symbols/s · ${option.fps / option.lanes} fps/lane`}
                    {" · "}
                    {formatRate(option.usefulBytesPerFrame * option.fps)}
                  </b>
                </button>
              );
            })}
          </div>

          {preset.fps >= 30 ? (
            <p className="channel-warning">
              {preset.lanes === 2
                ? "Dual mode: use fullscreen, rotate the phone landscape, and select Dual lane on the scanner."
                : "Fast mode: watch the receiver’s delivered and scanner rates. Step down if valid unique reads stop increasing."}
            </p>
          ) : null}

          {error ? <p className="error-message" role="alert">{error}</p> : null}
        </div>

        <div className="qr-panel">
          <div className="step-heading inverse">
            <span>03</span>
            <div>
              <h2>Play the QR stream</h2>
              <p>
                {preset.lanes === 2
                  ? "Keep both complete codes inside the landscape phone guide."
                  : "Fill the phone guide with this one complete code."}
              </p>
            </div>
          </div>

          <div
            ref={qrStageRef}
            className={`qr-stage ${transfer ? "ready" : ""} ${playing ? "playing" : ""} lanes-${preset.lanes}`}
          >
            {transfer ? (
              <div className={`qr-canvas-grid lanes-${preset.lanes}`}>
                {Array.from({ length: preset.lanes }, (_, laneIndex) => (
                  <canvas
                    key={laneIndex}
                    ref={(canvas) => {
                      canvasRefs.current[laneIndex] = canvas;
                    }}
                    aria-label={
                      preset.lanes === 1
                        ? "Animated RaptorQ file transfer"
                        : `Animated RaptorQ file transfer lane ${laneIndex + 1}`
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="qr-placeholder" aria-hidden="true">
                <div className="finder top-left" />
                <div className="finder top-right" />
                <div className="finder bottom-left" />
                <span>{processing ? "Encoding stream…" : "QR stream appears here"}</span>
              </div>
            )}
            <button
              className="fullscreen-button"
              type="button"
              onClick={toggleFullscreen}
              disabled={!transfer}
              aria-label="Show QR code fullscreen"
            >
              ⛶
            </button>
          </div>

          <div className="stream-status" aria-live="polite">
            <div>
              <span className={`pulse-dot ${playing ? "live" : ""}`} aria-hidden="true" />
              <strong>
                {playing
                  ? "Broadcasting"
                  : transfer
                    ? "Ready to broadcast"
                    : processing
                      ? "Encoding"
                      : "Waiting for a file"}
              </strong>
            </div>
            <span>
              {transfer
                ? `${estimateDuration(transfer, preset)} · ${formatRate(nominalRate)} nominal${
                    playing && actualFps > 0
                      ? ` · ${actualFps.toFixed(1)} fps rendered`
                      : ""
                  }`
                : "Camera never needs a network connection"}
            </span>
          </div>

          {transfer ? (
            <div className="broadcast-progress">
              <div>
                <strong>RaptorQ cycle {cycleNumber}</strong>
                <span>
                  frame {cycleFrame.toLocaleString()} /{" "}
                  {orderLength.toLocaleString()} ·{" "}
                  {transfer.sourcePacketCount.toLocaleString()} source +{" "}
                  {transfer.repairPacketIndices.length.toLocaleString()} repair
                </span>
              </div>
              <div
                className="broadcast-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(cycleProgress * 100)}
              >
                <span style={{ width: `${cycleProgress * 100}%` }} />
              </div>
            </div>
          ) : null}

          <button
            className="primary-action"
            type="button"
            disabled={!transfer || processing}
            onClick={() => {
              if (!playing) setActualFps(0);
              setPlaying((current) => !current);
            }}
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
        <p className="eyebrow">CLOSER TO THE OPTICAL LIMIT</p>
        <div className="how-grid">
          <h2>More useful bits.<br />Every exposure.</h2>
          <div className="feature">
            <span>01</span>
            <h3>Compress first</h3>
            <p>Brotli quality 11 races gzip level 9; only the smallest result crosses the camera.</p>
          </div>
          <div className="feature">
            <span>02</span>
            <h3>Raw binary QR</h3>
            <p>Byte-mode symbols remove Base45 expansion while stable finder geometry stays easy to track.</p>
          </div>
          <div className="feature">
            <span>03</span>
            <h3>RaptorQ across time</h3>
            <p>Source and repair symbols are interleaved, so blur and dropped exposures become harmless erasures.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
