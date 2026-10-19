import type { ReactNode } from "react";

export interface ToolbarItem {
  id: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

/**
 * Permanent vertical icon palette anchored to the extreme left edge.
 * Hosts toggle buttons for the floating data panels (Aviation Intel,
 * Maritime Intel, …). Modeled after Photoshop / MS Paint tool palettes.
 */
export function MasterToolbar({ items }: { items: ToolbarItem[] }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0, top: 0, bottom: 0,
        width: 44,
        zIndex: 100, // above all floating panels' default 1000? No — see note below.
        background: "rgba(2,4,8,0.95)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderRight: "1px solid rgba(0,255,255,0.18)",
        boxShadow: "2px 0 16px rgba(0,0,0,0.6), inset -1px 0 0 rgba(0,255,255,0.06)",
        display: "flex", flexDirection: "column",
        padding: "10px 0", gap: 4,
        fontFamily: "'Share Tech Mono','Courier New',monospace",
      }}
    >
      {/* Top accent line — same scan-line aesthetic used elsewhere */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 2,
        background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.6),transparent)",
        animation: "scan 4s linear infinite",
      }} />

      {items.map((it) => (
        <ToolbarButton key={it.id} item={it} />
      ))}
    </div>
  );
}

function ToolbarButton({ item }: { item: ToolbarItem }) {
  const active = !!item.active;
  const disabled = !!item.disabled;
  const baseColor = active ? "#00ffff" : disabled ? "rgba(0,255,255,0.2)" : "rgba(0,255,255,0.6)";

  return (
    <button
      type="button"
      title={item.label}
      disabled={disabled}
      onClick={item.onClick}
      style={{
        margin: "0 6px",
        height: 32,
        background: active ? "rgba(0,255,255,0.12)" : "transparent",
        border: `1px solid ${active ? "rgba(0,255,255,0.55)" : "transparent"}`,
        borderRadius: 2,
        color: baseColor,
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: active
          ? "0 0 12px rgba(0,255,255,0.4), inset 0 0 8px rgba(0,255,255,0.18)"
          : "none",
        transition: "all 0.12s ease",
        padding: 0,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (!active) {
          e.currentTarget.style.background = "rgba(0,255,255,0.07)";
          e.currentTarget.style.color = "#7df9ff";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = baseColor;
        }
      }}
    >
      {item.icon}
    </button>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────
// Inline SVGs so we don't add an icon-pack dependency. They use currentColor
// so they pick up the toolbar button's color (active / hover states).

export const AviationIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1L15 22v-1.5L13 19v-5.5z" />
  </svg>
);

export const MaritimeIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round">
    {/* Mast + crow's nest */}
    <circle cx="12" cy="4" r="1.4" />
    <path d="M12 5.4V13" />
    {/* Hull */}
    <path d="M4 17h16l-1.5 3a2 2 0 0 1-1.8 1.2H7.3a2 2 0 0 1-1.8-1.2L4 17z" />
    {/* Deck rails */}
    <path d="M6 17l1-4h10l1 4" />
    {/* Waves */}
    <path d="M2 21c1.3 0 1.3-1 2.6-1S5.9 21 7.2 21" opacity="0.6" />
  </svg>
);

export const PlaybackIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round">
    {/* Clock with replay/play arrow */}
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <polygon points="10 9 15 12 10 15 10 9" fill="currentColor" stroke="none" />
  </svg>
);


export const CctvIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round">
    {/* Dome camera on a wall bracket */}
    <path d="M3 4h4v3" />
    <path d="M5 7h10.5a3.5 3.5 0 0 1 3.5 3.5V12H5z" />
    <circle cx="14.5" cy="12" r="3.2" />
    <circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none" />
    <path d="M5 7v5" />
    <path d="M16 20.5h5M18.5 18v2.5" opacity="0.6" />
  </svg>
);
