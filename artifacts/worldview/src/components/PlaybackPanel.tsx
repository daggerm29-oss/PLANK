import { useState, useEffect } from "react";
import { FloatingPanel } from "./FloatingPanel";
import type { PlaybackMode, SelectedEntity } from "./PlaybackLayer";

export interface PlaybackIndexFrame {
  id: number;
  ts: string;
  ship_count?: number;
  plane_count?: number;
}

interface Props {
  active: boolean;
  mode: PlaybackMode;
  onModeChange: (nextMode: PlaybackMode) => void;
  frames: PlaybackIndexFrame[];
  currentFrameIndex: number;
  onSeekFrame: (index: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  speed: 1 | 2 | 4;
  onSpeedChange: (speed: 1 | 2 | 4) => void;
  loading: boolean;
  loadingFrame: boolean;
  selectedEntity: SelectedEntity | null;
  trailLoading: boolean;
  onClearTrail: () => void;
  onExitPlayback: () => void;
  onClose: () => void;
}

/** Formats an ISO timestamp string into Indian Standard Time (IST, UTC+5:30). */
export function formatIST(isoOrDate: string | Date | number): string {
  try {
    const d = new Date(isoOrDate);
    if (isNaN(d.getTime())) return "--:--:-- IST";
    return (
      new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d) + " IST"
    );
  } catch {
    return String(isoOrDate);
  }
}

export function PlaybackPanel({
  active,
  mode,
  onModeChange,
  frames,
  currentFrameIndex,
  onSeekFrame,
  isPlaying,
  onTogglePlay,
  speed,
  onSpeedChange,
  loading,
  loadingFrame,
  selectedEntity,
  trailLoading,
  onClearTrail,
  onExitPlayback,
  onClose,
}: Props) {
  const currentFrame = frames[currentFrameIndex];
  const hasEnoughFrames = frames.length >= 2;
  const count = currentFrame?.ship_count ?? currentFrame?.plane_count ?? 0;

  return (
    <FloatingPanel
      title="PLAYBACK"
      initialX={54}
      initialY={14}
      width={340}
      onClose={onClose}
      accentColor="#00ffff"
      extraHeaderButtons={
        <button
          type="button"
          data-no-drag
          onClick={onExitPlayback}
          title="Exit playback and restore live layers"
          style={{
            background: "rgba(0, 255, 136, 0.15)",
            border: "1px solid rgba(0, 255, 136, 0.5)",
            color: "#00ff88",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.15em",
            padding: "2px 8px",
            borderRadius: 2,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 5,
            transition: "all 0.15s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(0, 255, 136, 0.28)";
            e.currentTarget.style.boxShadow = "0 0 10px rgba(0,255,136,0.5)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(0, 255, 136, 0.15)";
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "#00ff88",
              boxShadow: "0 0 6px #00ff88",
              animation: "pulse-glow 1.5s ease-in-out infinite",
            }}
          />
          LIVE
        </button>
      }
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: "12px 14px 16px",
          fontFamily: "'Share Tech Mono', 'Courier New', monospace",
          color: "#c0e8f0",
          fontSize: 11,
          position: "relative",
        }}
      >
        {/* Top scanline effect */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: "linear-gradient(90deg, transparent, rgba(0,255,255,0.6), transparent)",
            animation: "scan 4s linear infinite",
          }}
        />

        {/* ── MODE SELECTOR ──────────────────────────────────────────────── */}
        <div>
          <div
            style={{
              fontSize: 8,
              letterSpacing: "0.2em",
              color: "rgba(0, 255, 255, 0.5)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            FEED SELECTOR
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 4,
              background: "rgba(0, 255, 255, 0.04)",
              padding: 3,
              borderRadius: 3,
              border: "1px solid rgba(0, 255, 255, 0.12)",
            }}
          >
            {(
              [
                { id: "INDIA", label: "SHIPS INDIA" },
                { id: "HORMUZ", label: "SHIPS HORMUZ" },
                { id: "PLANES", label: "PLANES 24H" },
              ] as const
            ).map((m) => {
              const activeMode = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onModeChange(m.id)}
                  style={{
                    background: activeMode ? "rgba(0, 255, 255, 0.2)" : "transparent",
                    color: activeMode ? "#00ffff" : "rgba(0, 255, 255, 0.55)",
                    border: `1px solid ${activeMode ? "rgba(0, 255, 255, 0.6)" : "transparent"}`,
                    borderRadius: 2,
                    padding: "6px 2px",
                    fontSize: 9,
                    fontWeight: activeMode ? 700 : 500,
                    letterSpacing: "0.08em",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    boxShadow: activeMode ? "0 0 8px rgba(0,255,255,0.3)" : "none",
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── CURRENT TIMESTAMP & STATS ──────────────────────────────────── */}
        <div
          style={{
            background: "rgba(0, 20, 30, 0.55)",
            border: "1px solid rgba(0, 255, 255, 0.16)",
            borderRadius: 3,
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 8, letterSpacing: "0.15em", color: "rgba(0,255,255,0.4)" }}>
              TIMESTAMP (IST)
            </span>
            {loadingFrame && (
              <span style={{ fontSize: 8, color: "#ffd200", letterSpacing: "0.1em" }}>
                BUFFERING...
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#00ffff",
              letterSpacing: "0.06em",
              textShadow: "0 0 8px rgba(0,255,255,0.4)",
            }}
          >
            {currentFrame ? formatIST(currentFrame.ts) : loading ? "Loading index..." : "--"}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 9,
              color: "rgba(0,255,255,0.6)",
              marginTop: 2,
            }}
          >
            <span>
              CONTACTS:{" "}
              <strong style={{ color: "#ffffff" }}>{currentFrame ? count : 0}</strong>
            </span>
            <span>
              FRAME:{" "}
              <strong style={{ color: "#ffffff" }}>
                {frames.length > 0 ? currentFrameIndex + 1 : 0}
              </strong>{" "}
              / {frames.length}
            </span>
          </div>
        </div>

        {/* ── CONTROLS & TIMELINE SLIDER ──────────────────────────────────── */}
        {!hasEnoughFrames ? (
          <div
            style={{
              padding: "16px 12px",
              textAlign: "center",
              background: "rgba(0, 255, 255, 0.03)",
              border: "1px dashed rgba(0, 255, 255, 0.2)",
              borderRadius: 3,
              color: "rgba(0, 255, 255, 0.7)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "#00ffff",
                boxShadow: "0 0 6px #00ffff",
                animation: "pulse-glow 1.5s ease-in-out infinite",
              }}
            />
            <div style={{ fontSize: 10, letterSpacing: "0.1em" }}>
              Recording started, come back later
            </div>
            <div style={{ fontSize: 8, color: "rgba(0,255,255,0.4)" }}>
              {frames.length === 1 ? "1 frame captured" : "Waiting for playback frames to accumulate"}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Range Slider */}
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 8,
                  color: "rgba(0, 255, 255, 0.4)",
                  marginBottom: 3,
                }}
              >
                <span>{frames[0] ? formatIST(frames[0].ts).slice(0, 11) : "24H AGO"}</span>
                <span>{frames[frames.length - 1] ? "RECENT" : "NOW"}</span>
              </div>
              <input
                type="range"
                min={0}
                max={frames.length - 1}
                value={currentFrameIndex}
                onChange={(e) => onSeekFrame(Number(e.target.value))}
                style={{
                  width: "100%",
                  accentColor: "#00ffff",
                  cursor: "pointer",
                }}
              />
            </div>

            {/* Playback Controls: Play/Pause, Step buttons, Speed */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              {/* Play / Pause */}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={onTogglePlay}
                  style={{
                    background: isPlaying
                      ? "rgba(255, 140, 66, 0.18)"
                      : "rgba(0, 255, 255, 0.16)",
                    border: `1px solid ${
                      isPlaying ? "rgba(255, 140, 66, 0.6)" : "rgba(0, 255, 255, 0.6)"
                    }`,
                    color: isPlaying ? "#ff8c42" : "#00ffff",
                    borderRadius: 2,
                    padding: "5px 12px",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.1em",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    boxShadow: isPlaying ? "0 0 10px rgba(255,140,66,0.3)" : "none",
                  }}
                >
                  {isPlaying ? (
                    <>
                      <span>❚❚</span> PAUSE
                    </>
                  ) : (
                    <>
                      <span>▶</span> PLAY
                    </>
                  )}
                </button>

                {/* Step back / forward */}
                <button
                  type="button"
                  disabled={currentFrameIndex <= 0}
                  onClick={() => onSeekFrame(Math.max(0, currentFrameIndex - 1))}
                  style={{
                    background: "rgba(0, 255, 255, 0.05)",
                    border: "1px solid rgba(0, 255, 255, 0.2)",
                    color: "rgba(0, 255, 255, 0.7)",
                    borderRadius: 2,
                    padding: "5px 8px",
                    fontSize: 9,
                    cursor: currentFrameIndex <= 0 ? "not-allowed" : "pointer",
                    opacity: currentFrameIndex <= 0 ? 0.4 : 1,
                  }}
                  title="Step backwards"
                >
                  ◀
                </button>
                <button
                  type="button"
                  disabled={currentFrameIndex >= frames.length - 1}
                  onClick={() => onSeekFrame(Math.min(frames.length - 1, currentFrameIndex + 1))}
                  style={{
                    background: "rgba(0, 255, 255, 0.05)",
                    border: "1px solid rgba(0, 255, 255, 0.2)",
                    color: "rgba(0, 255, 255, 0.7)",
                    borderRadius: 2,
                    padding: "5px 8px",
                    fontSize: 9,
                    cursor: currentFrameIndex >= frames.length - 1 ? "not-allowed" : "pointer",
                    opacity: currentFrameIndex >= frames.length - 1 ? 0.4 : 1,
                  }}
                  title="Step forward"
                >
                  ▶
                </button>
              </div>

              {/* Speed Buttons */}
              <div
                style={{
                  display: "flex",
                  gap: 3,
                  background: "rgba(0, 255, 255, 0.04)",
                  padding: 2,
                  borderRadius: 2,
                  border: "1px solid rgba(0, 255, 255, 0.12)",
                }}
              >
                {([1, 2, 4] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onSpeedChange(s)}
                    style={{
                      background: speed === s ? "rgba(0, 255, 255, 0.25)" : "transparent",
                      color: speed === s ? "#00ffff" : "rgba(0, 255, 255, 0.4)",
                      border: "none",
                      padding: "3px 6px",
                      fontSize: 8,
                      fontWeight: 700,
                      borderRadius: 1,
                      cursor: "pointer",
                    }}
                  >
                    {s}X
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── SELECTED TRAIL CARD ────────────────────────────────────────── */}
        {selectedEntity && (
          <div
            style={{
              background: "rgba(255, 210, 0, 0.05)",
              border: "1px solid rgba(255, 210, 0, 0.35)",
              borderRadius: 3,
              padding: "8px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#ffd200",
                    boxShadow: "0 0 6px #ffd200",
                  }}
                />
                <span style={{ fontWeight: 700, color: "#ffd200", fontSize: 10 }}>
                  {selectedEntity.label}
                </span>
                <span style={{ fontSize: 8, color: "rgba(255, 210, 0, 0.6)" }}>
                  [{selectedEntity.category || selectedEntity.type.toUpperCase()}]
                </span>
              </div>
              <button
                type="button"
                onClick={onClearTrail}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "rgba(255, 210, 0, 0.6)",
                  cursor: "pointer",
                  fontSize: 10,
                  padding: "0 4px",
                }}
                title="Clear trail"
              >
                ✕
              </button>
            </div>

            <div
              style={{
                fontSize: 8,
                color: "rgba(255, 255, 255, 0.7)",
                display: "flex",
                gap: 10,
              }}
            >
              {typeof selectedEntity.speed === "number" && (
                <span>
                  SPD: <strong>{selectedEntity.speed.toFixed(1)} kn</strong>
                </span>
              )}
              {typeof selectedEntity.heading === "number" && (
                <span>
                  HDG: <strong>{Math.round(selectedEntity.heading)}°</strong>
                </span>
              )}
              {typeof selectedEntity.alt === "number" && selectedEntity.alt > 0 && (
                <span>
                  ALT: <strong>{selectedEntity.alt.toLocaleString()} ft</strong>
                </span>
              )}
            </div>

            <div style={{ fontSize: 8, color: "rgba(255, 210, 0, 0.8)", marginTop: 2 }}>
              {trailLoading ? "Loading historical 24h trail..." : "Displaying historical 24h trail"}
            </div>
          </div>
        )}

        {/* ── FOOTER HINT ────────────────────────────────────────────────── */}
        <div
          style={{
            fontSize: 8,
            color: "rgba(0, 255, 255, 0.35)",
            borderTop: "1px solid rgba(0, 255, 255, 0.08)",
            paddingTop: 6,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>CLICK ANY VEHICLE TO INSPECT TRAIL</span>
          <span>PRESS LIVE TO RESUME</span>
        </div>
      </div>
    </FloatingPanel>
  );
}
