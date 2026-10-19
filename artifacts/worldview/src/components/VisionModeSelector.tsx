import { useEffect } from "react";
import { VISION_MODES, VISION_BY_ID, type FlirPalette, type VisionMode } from "../lib/vision-modes";

const MONO = "'Share Tech Mono','Courier New',monospace";
const FLIR_PALETTES: { id: FlirPalette; label: string }[] = [
  { id: "whot", label: "WHOT" },
  { id: "bhot", label: "BHOT" },
  { id: "iron", label: "IRON" },
];

function isTypingTarget(el: EventTarget | null) {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

export function VisionModeSelector({
  mode,
  onChange,
  flirPalette,
  onFlirPaletteChange,
}: {
  mode: VisionMode;
  onChange: (m: VisionMode) => void;
  flirPalette: FlirPalette;
  onFlirPaletteChange: (p: FlirPalette) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const hit = VISION_MODES.find((m) => m.hotkey === e.key);
      if (hit) onChange(hit.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChange]);

  const accent = VISION_BY_ID[mode].accent;

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 25,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        fontFamily: MONO,
        maxWidth: "calc(100vw - 120px)",
      }}
    >
      <div
        role="radiogroup"
        aria-label="Vision mode"
        style={{
          display: "flex",
          alignItems: "stretch",
          background: "rgba(2,4,8,0.82)",
          border: `1px solid ${accent}55`,
          borderRadius: 3,
          boxShadow: `0 0 18px ${accent}22`,
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          overflowX: "auto",
          transition: "border-color 0.3s, box-shadow 0.3s",
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 10px",
            fontSize: 8,
            letterSpacing: "0.25em",
            color: `${accent}aa`,
            borderRight: `1px solid ${accent}33`,
            whiteSpace: "nowrap",
          }}
        >
          VISION
        </span>
        {VISION_MODES.map((m) => {
          const active = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
              title={`${m.label} (${m.hotkey})`}
              onClick={() => onChange(m.id)}
              style={{
                padding: "7px 10px",
                fontSize: 9,
                letterSpacing: "0.12em",
                fontFamily: MONO,
                border: "none",
                borderLeft: "1px solid rgba(255,255,255,0.05)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                background: active ? `${m.accent}22` : "transparent",
                color: active ? m.accent : "rgba(200,230,240,0.45)",
                textShadow: active ? `0 0 8px ${m.accent}` : "none",
                boxShadow: active ? `inset 0 -2px 0 ${m.accent}` : "none",
                transition: "all 0.2s",
              }}
            >
              <span style={{ opacity: 0.45, marginRight: 4 }}>{m.hotkey}</span>
              {m.short}
            </button>
          );
        })}
      </div>

      {mode === "flir" && (
        <div
          role="radiogroup"
          aria-label="Thermal palette"
          style={{
            display: "flex",
            background: "rgba(2,4,8,0.82)",
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: 3,
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
        >
          {FLIR_PALETTES.map((p) => {
            const active = p.id === flirPalette;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onFlirPaletteChange(p.id)}
                style={{
                  padding: "5px 12px",
                  fontSize: 9,
                  letterSpacing: "0.15em",
                  fontFamily: MONO,
                  border: "none",
                  cursor: "pointer",
                  background: active ? "rgba(255,255,255,0.14)" : "transparent",
                  color: active ? "#fff" : "rgba(255,255,255,0.45)",
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
