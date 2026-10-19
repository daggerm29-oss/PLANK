import { useRef, useState, type ReactNode } from "react";

// Module-level z-index counter so every panel that gets focused floats above
// the rest. Starts well above static HUD elements (which use zIndex 10–50).
let zCounter = 1000;
const nextZ = () => ++zCounter;

export interface FloatingPanelProps {
  /** Title shown in the header bar (also used as the drag handle aria-label). */
  title: string;
  /** Initial top-left position in pixels, measured from the map container. */
  initialX?: number;
  initialY?: number;
  /** Panel width in pixels. Height grows to fit children up to maxHeight. */
  width?: number;
  /** Cap so the panel never exceeds the viewport. */
  maxHeight?: number | string;
  /** Theme color for header accents / glow. Defaults to the cyan HUD palette. */
  accentColor?: string;
  /** Called when the user clicks the X button. Parent owns open/closed state. */
  onClose: () => void;
  /** Optional initial minimized state. */
  defaultMinimized?: boolean;
  /** Forwarded ref to the panel's outer DOM node. Useful for sibling panels
   *  that need to compute snap-to-dock geometry (e.g. magnetic re-docking). */
  panelRef?: React.RefObject<HTMLDivElement | null>;
  /** Extra buttons rendered in the header, immediately before minimize / close.
   *  Children that should not initiate a drag must include `data-no-drag`. */
  extraHeaderButtons?: ReactNode;
  /** Fired after the user finishes a drag with the panel's final position.
   *  Parents use this to implement snap-to-dock or persistence. */
  onDragEnd?: (pos: { x: number; y: number }) => void;
  children: ReactNode;
}

/**
 * A draggable, minimizable, closable HUD window.
 *
 * Drag is implemented with raw pointer events (no library) on the header bar.
 * Buttons inside the header opt out of drag via a `data-no-drag` check.
 * Clicking anywhere on the panel raises it to the top of the z-stack.
 */
export function FloatingPanel({
  title,
  initialX = 60,
  initialY = 14,
  width = 320,
  maxHeight = "calc(100vh - 28px)",
  accentColor = "#00ffff",
  onClose,
  defaultMinimized = false,
  panelRef,
  extraHeaderButtons,
  onDragEnd,
  children,
}: FloatingPanelProps) {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  // Shadow ref so the drag handler can read the live position without waiting
  // for React state to flush, and so onDragEnd reports the correct final pos.
  const posRef = useRef(pos);
  const [minimized, setMinimized] = useState(defaultMinimized);
  const [zIndex, setZIndex] = useState<number>(() => nextZ());
  const dragRef = useRef<{
    startX: number; startY: number; origX: number; origY: number;
  } | null>(null);

  const bringToFront = () => setZIndex(nextZ());

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Don't initiate drag from button clicks (minimize / close / extras).
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    e.preventDefault();
    bringToFront();
    dragRef.current = {
      startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y,
    };

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      // Clamp so the header is always reachable (don't lose the panel offscreen).
      const margin = 30;
      const newX = Math.max(-(width - 80), Math.min(window.innerWidth - margin, d.origX + ev.clientX - d.startX));
      const newY = Math.max(0, Math.min(window.innerHeight - margin, d.origY + ev.clientY - d.startY));
      const next = { x: newX, y: newY };
      posRef.current = next;
      setPos(next);
    };
    const onUp = () => {
      const wasDragging = dragRef.current !== null;
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (wasDragging && onDragEnd) onDragEnd(posRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={panelRef}
      onMouseDownCapture={bringToFront}
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        width,
        maxHeight: minimized ? undefined : maxHeight,
        zIndex,
        background: "rgba(2,4,8,0.92)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: `1px solid ${accentColor}33`,
        borderRadius: 2,
        boxShadow: `0 0 22px ${accentColor}26, 0 8px 30px rgba(0,0,0,0.6), inset 0 0 12px ${accentColor}10`,
        display: "flex", flexDirection: "column", overflow: "hidden",
        fontFamily: "'Share Tech Mono','Courier New',monospace",
      }}
    >
      {/* HEADER — drag handle + window controls */}
      <div
        onPointerDown={onHeaderPointerDown}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "6px 6px 6px 10px",
          background: `linear-gradient(180deg, ${accentColor}22, ${accentColor}08)`,
          borderBottom: minimized ? "none" : `1px solid ${accentColor}26`,
          cursor: "grab", flexShrink: 0,
          userSelect: "none", touchAction: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <div style={{
            width: 6, height: 6, borderRadius: "50%",
            background: accentColor,
            boxShadow: `0 0 6px ${accentColor}`,
            flexShrink: 0,
          }} />
          <span style={{
            fontSize: 10, letterSpacing: "0.22em", color: accentColor,
            textTransform: "uppercase", fontWeight: 700,
            textShadow: `0 0 6px ${accentColor}88`,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {title}
          </span>
        </div>
        <div style={{ display: "flex", gap: 3, alignItems: "center" }} data-no-drag>
          {extraHeaderButtons}
          <PanelButton
            accent={accentColor}
            title={minimized ? "Restore" : "Minimize"}
            onClick={() => setMinimized((m) => !m)}
          >
            {minimized ? "▢" : "—"}
          </PanelButton>
          <PanelButton accent={accentColor} title="Close" onClick={onClose}>
            ✕
          </PanelButton>
        </div>
      </div>

      {/* BODY — only rendered when not minimized so the layout collapses to a strip */}
      {!minimized && (
        <div style={{
          display: "flex", flexDirection: "column", overflow: "hidden",
          position: "relative", flex: 1, minHeight: 0,
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

function PanelButton({
  accent, onClick, title, children,
}: {
  accent: string;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      data-no-drag
      onClick={onClick}
      style={{
        background: "transparent",
        border: `1px solid ${accent}40`,
        color: `${accent}cc`,
        cursor: "pointer",
        width: 20, height: 20,
        fontSize: 10, lineHeight: 1,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Share Tech Mono','Courier New',monospace",
        borderRadius: 2,
        padding: 0,
        transition: "all 0.12s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = `${accent}26`;
        e.currentTarget.style.color = accent;
        e.currentTarget.style.borderColor = `${accent}88`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = `${accent}cc`;
        e.currentTarget.style.borderColor = `${accent}40`;
      }}
    >
      {children}
    </button>
  );
}
