import type { TrackKind } from "../lib/tracked-entity";

export interface EntityInfo {
  kind: TrackKind;
  title: string;
  color: string;
  rows: Array<[label: string, value: string]>;
}

interface Props {
  info: EntityInfo;
  tracking: boolean;
  onTrack: () => void;
  onExit: () => void;
  onClose: () => void;
}

const MONO = "'Share Tech Mono','Courier New',monospace";
const KIND_LABEL: Record<TrackKind, string> = {
  aircraft: "AIRCRAFT INTEL",
  ship: "VESSEL INTEL",
  satellite: "SATELLITE INTEL",
};

export function EntityInfoPanel({ info, tracking, onTrack, onExit, onClose }: Props) {
  const { color } = info;
  return (
    <aside
      aria-label={KIND_LABEL[info.kind]}
      style={{
        position: "absolute",
        top: 70,
        right: 16,
        bottom: 16,
        width: 280,
        maxWidth: "calc(100vw - 32px)",
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        background: "rgba(2,4,8,0.88)",
        border: `1px solid ${color}55`,
        boxShadow: `0 0 24px ${color}25`,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        fontFamily: MONO,
        color: "rgba(220,240,255,0.85)",
        maxHeight: 560,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          borderBottom: `1px solid ${color}33`,
        }}
      >
        <span style={{ fontSize: 9, letterSpacing: "0.2em", color: `${color}bb` }}>{KIND_LABEL[info.kind]}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          style={{ background: "none", border: "none", color: `${color}99`, cursor: "pointer", fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em" }}
        >
          [CLR]
        </button>
      </header>

      <div style={{ padding: "12px 14px", overflowY: "auto", flex: 1 }}>
        <h2
          style={{
            margin: "0 0 10px",
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "0.12em",
            color,
            textShadow: `0 0 10px ${color}`,
            textTransform: "uppercase",
            wordBreak: "break-word",
          }}
        >
          {info.title}
        </h2>
        <dl style={{ margin: 0 }}>
          {info.rows.map(([label, value]) => (
            <div
              key={label}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                padding: "4px 0",
                borderBottom: "1px solid rgba(255,255,255,0.05)",
                fontSize: 10,
                letterSpacing: "0.06em",
              }}
            >
              <dt style={{ color: "rgba(180,200,220,0.5)", textTransform: "uppercase" }}>{label}</dt>
              <dd style={{ margin: 0, textAlign: "right", color: "rgba(230,245,255,0.92)", wordBreak: "break-word" }}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <footer style={{ padding: 12, borderTop: `1px solid ${color}33` }}>
        <button
          type="button"
          onClick={tracking ? onExit : onTrack}
          style={{
            width: "100%",
            padding: "10px 12px",
            background: tracking ? "rgba(255,60,60,0.12)" : `${color}18`,
            border: `1px solid ${tracking ? "#ff4d4d" : color}`,
            color: tracking ? "#ff6b6b" : color,
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: "0.25em",
            cursor: "pointer",
          }}
        >
          {tracking ? "EXIT 3D" : "TRACK 3D"}
        </button>
        {!tracking && (
          <p style={{ margin: "8px 0 0", fontSize: 8, letterSpacing: "0.1em", color: "rgba(180,200,220,0.4)", textAlign: "center" }}>
            DOUBLE-CLICK ANY TARGET FOR CINEMATIC VIEW
          </p>
        )}
      </footer>
    </aside>
  );
}
