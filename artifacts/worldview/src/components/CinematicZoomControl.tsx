import { useEffect, useState } from "react";

const MONO = "'Share Tech Mono','Courier New',monospace";
const ACCENT = "#00ffff";

interface Props {
  getRange: () => number;
  minRange: number;
  maxRange: number;
  onZoom: (logDelta: number) => void;
  onReset: () => void;
}

function formatRange(m: number): string {
  if (m >= 10_000) return `${(m / 1000).toFixed(0)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

const buttonStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,255,255,0.08)",
  border: `1px solid ${ACCENT}66`,
  color: ACCENT,
  fontFamily: MONO,
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
};

/** On-screen zoom for the cinematic 3D view (wheel and +/- keys do the same). */
export function CinematicZoomControl({ getRange, minRange, maxRange, onZoom, onReset }: Props) {
  const [range, setRange] = useState(getRange);

  useEffect(() => {
    const id = window.setInterval(() => setRange(getRange()), 150);
    return () => window.clearInterval(id);
  }, [getRange]);

  const t = (Math.log(range) - Math.log(minRange)) / (Math.log(maxRange) - Math.log(minRange));
  const closeness = Math.max(0, Math.min(1, 1 - t));

  return (
    <div
      role="group"
      aria-label="3D view zoom"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 28,
        transform: "translateX(-50%)",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        background: "rgba(2,4,8,0.88)",
        border: `1px solid ${ACCENT}44`,
        fontFamily: MONO,
        color: ACCENT,
        fontSize: 10,
        letterSpacing: "0.15em",
        userSelect: "none",
      }}
    >
      <span style={{ color: `${ACCENT}99` }}>ZOOM</span>
      <button type="button" aria-label="Zoom out" title="Zoom out (-)" style={buttonStyle} onClick={() => onZoom(0.35)}>
        {"−"}
      </button>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 92 }}>
        <span aria-live="polite" style={{ fontSize: 11 }}>
          {formatRange(range)}
        </span>
        <div style={{ width: 92, height: 3, background: `${ACCENT}22` }} aria-hidden="true">
          <div style={{ width: `${closeness * 100}%`, height: "100%", background: ACCENT, boxShadow: `0 0 6px ${ACCENT}` }} />
        </div>
      </div>
      <button type="button" aria-label="Zoom in" title="Zoom in (+)" style={buttonStyle} onClick={() => onZoom(-0.35)}>
        {"+"}
      </button>
      <button
        type="button"
        aria-label="Reset camera"
        title="Reset camera"
        style={{ ...buttonStyle, width: "auto", padding: "0 8px", fontSize: 10, letterSpacing: "0.15em" }}
        onClick={onReset}
      >
        RESET
      </button>
    </div>
  );
}
