import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import maplibregl from "maplibre-gl";
import "../lib/maplibre-patch";
import { CinematicHost } from "../components/CinematicHost";
import { EntityInfoPanel, type EntityInfo } from "../components/EntityInfoPanel";
import {
  type EntityRef,
  type FollowTarget,
  KTS_TO_MS,
  altMetersFromBaro,
  aircraftModel,
  shipModel,
  satelliteModel,
  bearingDeg,
  preloadModels,
} from "../lib/tracked-entity";
import { SatelliteLayer, satEcefAt, satPeriodSec, type SatPosition } from "../components/SatelliteLayer";
import { ShipsLayer, type Ship, type ShipFilters } from "../components/ShipsLayer";
import { FloatingPanel } from "../components/FloatingPanel";
import { MaritimePanel } from "../components/MaritimePanel";
import { MasterToolbar, AviationIcon, MaritimeIcon, PlaybackIcon, CctvIcon } from "../components/MasterToolbar";
import { CctvLayer } from "../components/CctvLayer";
import { CctvPanel } from "../components/CctvPanel";
import { CctvViewer } from "../components/CctvViewer";
import { useCctv } from "../hooks/use-cctv";
import type { CctvCamera, CctvSourceId } from "../lib/cctv";
import {
  PlaybackLayer,
  type PlaybackMode,
  type PlaybackShipContact,
  type PlaybackPlaneContact,
  type PlaybackRegionBounds,
  type SelectedEntity as PlaybackSelectedEntity,
  type TrailPoint as PlaybackTrailPoint,
} from "../components/PlaybackLayer";
import { PlaybackPanel, type PlaybackIndexFrame } from "../components/PlaybackPanel";
import { VisionFilters } from "../components/VisionFilters";
import { VisionOverlay } from "../components/VisionOverlay";
import { VisionModeSelector } from "../components/VisionModeSelector";
import {
  VISION_BY_ID,
  VISION_STORAGE_KEY,
  applyVisionToMap,
  styleReady,
  visionCssFilter,
  type FlirPalette,
  type VisionMode,
} from "../lib/vision-modes";

function readStoredVision(): { mode: VisionMode; flir: FlirPalette } {
  try {
    const raw = JSON.parse(localStorage.getItem(VISION_STORAGE_KEY) ?? "{}") as { mode?: string; flir?: string };
    const mode = raw.mode && raw.mode in VISION_BY_ID ? (raw.mode as VisionMode) : "tactical";
    const flir = raw.flir === "bhot" || raw.flir === "iron" ? raw.flir : "whot";
    return { mode, flir };
  } catch {
    return { mode: "tactical", flir: "whot" };
  }
}

// Active AO radius (km): satellites within this distance from the theater
// centroid are flagged as "active overwatch" assets.
const OVERWATCH_RADIUS_KM = 2500;

// Haversine great-circle distance in km. Used for auto-acquisition.
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

interface Aircraft {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
  gs?: number;
  track?: number;
  squawk?: string;
  t?: string;
  desc?: string;
  r?: string;
  seen?: number;
}

type FilterMode = "civil" | "military";
type AreaMode = "global" | "local";
type ViewMode = "2d" | "3d";

const THEATER_COLOR = "#FFD700";

interface NominatimHit {
  display_name: string;
  geojson?: GeoJSON.Geometry;
  boundingbox?: [string, string, string, string]; // [minLat, maxLat, minLon, maxLon]
  lat?: string;
  lon?: string;
}

function geometryCentroid(geom: GeoJSON.Geometry): [number, number] | null {
  // Use bbox center; robust against complex multi-polygons.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords: unknown): void => {
    if (typeof (coords as number[])[0] === "number") {
      const [x, y] = coords as [number, number];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      return;
    }
    for (const c of coords as unknown[]) visit(c);
  };
  if ("coordinates" in geom) visit(geom.coordinates as unknown);
  if (!isFinite(minX)) return null;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/**
 * Resolves whichever entity is being tracked (aircraft, ship or satellite)
 * into a normalised FollowTarget for the cinematic 3D view. Keeps the last
 * good sample so brief feed gaps don't snap the camera away.
 */
function CinematicController({
  trackedHex,
  trackedShipId,
  trackedSatId,
  aircraft,
  ships,
  satPosMap,
  base,
  military,
  visionMode,
}: {
  visionMode: VisionMode;
  trackedHex: string | null;
  trackedShipId: string | null;
  trackedSatId: string | null;
  aircraft: Aircraft[];
  ships: Ship[];
  satPosMap: Map<string, SatPosition>;
  base: string;
  military: boolean;
}) {
  const lastAircraftRef = useRef<Aircraft | null>(null);
  const lastShipRef = useRef<Ship | null>(null);
  const satPrevRef = useRef<{ id: string; lat: number; lon: number; heading: number } | null>(null);

  let target: FollowTarget | null = null;

  if (trackedHex) {
    const fresh = aircraft.find((x) => x.hex === trackedHex);
    if (fresh) {
      const prev = lastAircraftRef.current;
      const merged: Aircraft = { ...(prev ?? {}), ...fresh } as Aircraft;
      if (fresh.lat === undefined && prev?.lat !== undefined) merged.lat = prev.lat;
      if (fresh.lon === undefined && prev?.lon !== undefined) merged.lon = prev.lon;
      if (fresh.alt_baro === undefined && prev?.alt_baro !== undefined) merged.alt_baro = prev.alt_baro;
      if (fresh.track === undefined && prev?.track !== undefined) merged.track = prev.track;
      if (fresh.gs === undefined && prev?.gs !== undefined) merged.gs = prev.gs;
      lastAircraftRef.current = merged;
    }
    const a = lastAircraftRef.current;
    if (a && a.lat !== undefined && a.lon !== undefined) {
      target = {
        kind: "aircraft",
        id: a.hex,
        modelUrl: aircraftModel(base, military),
        lat: a.lat,
        lon: a.lon,
        altM: altMetersFromBaro(a.alt_baro),
        headingDeg: a.track ?? 0,
        speedMs: (a.gs ?? 0) * KTS_TO_MS,
        sampleAgeSec: fresh ? a.seen : undefined,
      };
    }
  } else {
    lastAircraftRef.current = null;
  }

  if (trackedShipId) {
    const fresh = ships.find((x) => String(x.mmsi) === trackedShipId);
    if (fresh) lastShipRef.current = fresh;
    const sh = lastShipRef.current;
    if (sh && typeof sh.lat === "number" && typeof sh.lon === "number") {
      target = {
        kind: "ship",
        id: trackedShipId,
        modelUrl: shipModel(base, sh.category),
        lat: sh.lat,
        lon: sh.lon,
        altM: 0,
        headingDeg: sh.cog ?? 0,
        speedMs: (sh.sog ?? 0) * KTS_TO_MS,
      };
    }
  } else {
    lastShipRef.current = null;
  }

  if (trackedSatId) {
    const satId = trackedSatId;
    const sat = satPosMap.get(satId);
    if (sat) {
      const prev = satPrevRef.current;
      let heading = prev && prev.id === trackedSatId ? prev.heading : 0;
      if (prev && prev.id === trackedSatId && (prev.lat !== sat.lat || prev.lon !== sat.lon)) {
        heading = bearingDeg(prev.lat, prev.lon, sat.lat, sat.lon);
      }
      satPrevRef.current = { id: trackedSatId, lat: sat.lat, lon: sat.lon, heading };
      target = {
        kind: "satellite",
        id: trackedSatId,
        modelUrl: satelliteModel(base, sat.name),
        lat: sat.lat,
        lon: sat.lon,
        altM: sat.altKm * 1000,
        headingDeg: heading,
        // Ground-track speed (orbital velocity scaled to the surface).
        speedMs: sat.velocityKms * 1000 * (6378 / (6378 + sat.altKm)),
        ecefAt: (when: Date) => satEcefAt(satId, when),
        orbitPeriodSec: satPeriodSec(trackedSatId) ?? undefined,
      };
    }
  } else {
    satPrevRef.current = null;
  }

  return <CinematicHost target={target} visionMode={visionMode} />;
}

const MIL_COLOR = "#ff6b35";
const CIV_COLOR = "#00ffff";
const RADIUS_OPTIONS = [100, 250, 500, 1000, 2500];

function formatAlt(alt: number | string | undefined): string {
  if (alt === undefined || alt === null) return "N/A";
  if (alt === "ground") return "GND";
  const n = Number(alt);
  if (isNaN(n)) return String(alt);
  return `${n.toLocaleString()} ft`;
}

function formatSpeed(gs: number | undefined): string {
  if (gs === undefined || gs === null) return "N/A";
  return `${Math.round(gs)} kts`;
}

function formatCallsign(a: Aircraft): string {
  return a.flight?.trim() || a.hex?.toUpperCase() || "UNKNOWN";
}

function createAircraftSdfImage(size = 32): { width: number; height: number; data: Uint8Array } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.moveTo(cx, 1);
  ctx.lineTo(cx + size * 0.26, size - 3);
  ctx.lineTo(cx, size * 0.7);
  ctx.lineTo(cx - size * 0.26, size - 3);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.75;
  ctx.fillRect(size * 0.08, size * 0.38, size * 0.84, size * 0.13);
  ctx.globalAlpha = 0.5;
  ctx.fillRect(size * 0.2, size * 0.62, size * 0.6, size * 0.1);
  ctx.globalAlpha = 1;
  const imageData = ctx.getImageData(0, 0, size, size);
  return { width: size, height: size, data: new Uint8Array(imageData.data.buffer) };
}

function AircraftSVG({ isMil, size = 10 }: { isMil: boolean; size?: number }) {
  const color = isMil ? MIL_COLOR : CIV_COLOR;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M12 2 L16 18 L12 15 L8 18 Z" />
      <path d="M6 10 L18 10 L17 13 L12 11 L7 13 Z" fill={color} opacity="0.7" />
    </svg>
  );
}

function StatRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid rgba(0,255,255,0.06)" }}>
      <span style={{ fontSize: "9px", letterSpacing: "0.15em", color: "rgba(0,255,255,0.4)", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.05em", color: accent ? CIV_COLOR : "rgba(0,255,255,0.85)" }}>{value}</span>
    </div>
  );
}

function WebGLFallback() {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#020408" }}>
      <div style={{ textAlign: "center", maxWidth: 380, padding: 32 }}>
        <div style={{ fontSize: "10px", letterSpacing: "0.3em", color: "rgba(0,255,255,0.4)", textTransform: "uppercase", marginBottom: 12 }}>SYSTEM NOTICE</div>
        <div style={{ fontSize: "14px", letterSpacing: "0.15em", color: "#00ffff", textShadow: "0 0 10px rgba(0,255,255,0.5)", marginBottom: 10 }}>WebGL Required</div>
        <div style={{ fontSize: "10px", letterSpacing: "0.08em", color: "rgba(0,255,255,0.5)", lineHeight: 1.9 }}>
          MapLibre needs hardware GPU acceleration.<br />
          This preview sandbox disables it.<br /><br />
          Deploy the app or open in a standard browser<br />
          to experience the full WORLDVIEW interface.
        </div>
        <div style={{ marginTop: 20, padding: "6px 14px", display: "inline-block", border: "1px solid rgba(0,255,255,0.3)", color: "rgba(0,255,255,0.5)", fontSize: "9px", letterSpacing: "0.2em" }}>
          ADS-B LIVE FEED ACTIVE
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.2),transparent)", margin: "0 16px 10px" }} />;
}

function StarField({ visible }: { visible: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = (canvas.width = window.innerWidth);
    const h = (canvas.height = window.innerHeight);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000005";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 800; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = Math.random() * 1.2;
      const a = 0.25 + Math.random() * 0.75;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fill();
    }
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180,220,255,${0.4 + Math.random() * 0.5})`;
      ctx.fill();
    }
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.7s ease",
        pointerEvents: "none",
        zIndex: 0,
        background: "#000005",
      }}
    />
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Resolve a Set<noradId> + position map into a sorted list of live SatPositions.
// Shared by the left-HUD detail view and the right-side overwatch panel.
// ──────────────────────────────────────────────────────────────────────────────
function useResolvedSats(
  selectedSatIds: Set<string>,
  satPosMap: Map<string, SatPosition>,
): SatPosition[] {
  return useMemo(() => {
    const out: SatPosition[] = [];
    for (const id of selectedSatIds) {
      const p = satPosMap.get(id);
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.altKm - b.altKm);
  }, [selectedSatIds, satPosMap]);
}

// ──────────────────────────────────────────────────────────────────────────────
// Single-target detail readout — rendered inside the left HUD when exactly one
// satellite is selected. Multi-target selections use OverwatchListPanel instead
// (rendered as a floating right-side panel so the left HUD doesn't overflow).
// ──────────────────────────────────────────────────────────────────────────────
function SatIntelDetail({
  selectedSatIds,
  satPosMap,
  onClear,
}: {
  selectedSatIds: Set<string>;
  satPosMap: Map<string, SatPosition>;
  onClear: () => void;
}) {
  const sats = useResolvedSats(selectedSatIds, satPosMap);
  if (sats.length !== 1) return null;
  const sel = sats[0];
  const sc = sel.color;
  return (
    <div style={{ padding: "0 16px 10px", flexShrink: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(125,249,255,0.55)", textTransform: "uppercase" }}>SATELLITE INTEL</div>
        <button
          onClick={onClear}
          style={{ fontSize: 8, letterSpacing: "0.1em", color: "rgba(125,249,255,0.45)", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", fontFamily: "'Share Tech Mono','Courier New',monospace" }}
        >[CLR]</button>
      </div>
      <div style={{
        padding: 10, borderRadius: 2,
        background: "rgba(255,91,46,0.04)",
        border: `1px solid ${sc}66`,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", color: sc, textShadow: `0 0 10px ${sc}`, marginBottom: 8, textTransform: "uppercase", wordBreak: "break-word" }}>
          {sel.name}
        </div>
        <StatRow label="ORIGIN" value={sel.origin} accent />
        <StatRow label="CLASS"  value={sel.intelClass} accent />
        <StatRow label="NORAD ID" value={sel.noradId} />
        <StatRow label="ORBIT" value={sel.isGeo ? "GEOSTATIONARY" : sel.altKm > 5000 ? "MEO/HEO" : "LEO"} />
        <StatRow label="ALTITUDE" value={`${sel.altKm.toFixed(0)} km`} accent />
        <StatRow label="VELOCITY" value={`${sel.velocityKms.toFixed(2)} km/s`} />
        <StatRow label="SUB-PT" value={`${sel.lat.toFixed(2)}, ${sel.lon.toFixed(2)}`} />
        {sel.isGeo && (
          <div style={{ marginTop: 8, fontSize: 8, letterSpacing: "0.08em", color: "rgba(255,200,180,0.55)", lineHeight: 1.5 }}>
            GEO TRAJECTORY OMITTED · STATIONARY RELATIVE TO EARTH
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Floating right-side overwatch list — used when 2+ satellites are selected
// (typically via theater auto-acquisition). Mounted as `position: absolute`
// near the top-right of the map so the left HUD stays compact even when the
// theater pulls in dozens of assets. Internally scrollable + height-capped.
// ──────────────────────────────────────────────────────────────────────────────
function OverwatchListPanel({
  selectedSatIds,
  satPosMap,
  theaterActive,
  theaterName,
  onClearAll,
  onRemoveOne,
}: {
  selectedSatIds: Set<string>;
  satPosMap: Map<string, SatPosition>;
  theaterActive: boolean;
  theaterName: string | null;
  onClearAll: () => void;
  onRemoveOne: (id: string) => void;
}) {
  const sats = useResolvedSats(selectedSatIds, satPosMap);
  if (sats.length < 2) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 14,
        right: 14,
        zIndex: 10,
        width: 260,
        maxHeight: "calc(100vh - 28px)",
        display: "flex",
        flexDirection: "column",
        background: "rgba(2,4,8,0.88)",
        backdropFilter: "blur(20px)",
        border: "1px solid rgba(125,249,255,0.28)",
        borderRadius: 2,
        boxShadow: "inset 0 0 14px rgba(125,249,255,0.05), 0 6px 24px rgba(0,0,0,0.5)",
        fontFamily: "'Share Tech Mono','Courier New',monospace",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px 6px" }}>
        <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(125,249,255,0.6)", textTransform: "uppercase" }}>
          ◈ ACTIVE OVERWATCH
        </div>
        <button
          onClick={onClearAll}
          style={{ fontSize: 8, letterSpacing: "0.1em", color: "rgba(125,249,255,0.45)", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", fontFamily: "'Share Tech Mono','Courier New',monospace" }}
        >[CLR ALL]</button>
      </div>

      <div style={{ padding: "0 12px 8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 9, letterSpacing: "0.16em", color: "rgba(125,249,255,0.85)", textTransform: "uppercase" }}>
            ASSETS MONITORING
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#7df9ff", textShadow: "0 0 10px rgba(125,249,255,0.6)", lineHeight: 1 }}>
            {sats.length}
          </div>
        </div>
        {theaterActive && theaterName && (
          <div style={{ fontSize: 8, letterSpacing: "0.14em", color: "rgba(255,215,0,0.7)", textTransform: "uppercase", marginTop: 6 }}>
            ZONE: {theaterName}
          </div>
        )}
      </div>

      <div className="glow-scroll" style={{ padding: "0 8px 10px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 3, minHeight: 0 }}>
        {sats.map((s) => (
          <div
            key={s.noradId}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6,
              padding: "5px 6px", borderRadius: 2,
              background: "rgba(0,255,255,0.025)",
              border: "1px solid rgba(125,249,255,0.12)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 10, fontWeight: 600, color: s.color, letterSpacing: "0.08em",
                textShadow: `0 0 6px ${s.color}88`,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                textTransform: "uppercase",
              }}>
                {s.name}
              </div>
              <div style={{ fontSize: 8, color: "rgba(0,255,255,0.45)", letterSpacing: "0.06em", marginTop: 1 }}>
                {s.origin} · {s.altKm.toFixed(0)} KM
              </div>
            </div>
            <button
              onClick={() => onRemoveOne(s.noradId)}
              title="Remove from overwatch"
              style={{
                background: "none", border: "1px solid rgba(125,249,255,0.2)",
                color: "rgba(125,249,255,0.55)", cursor: "pointer",
                fontSize: 9, padding: "2px 6px", borderRadius: 2,
                fontFamily: "'Share Tech Mono','Courier New',monospace",
                letterSpacing: "0.1em",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#7df9ff";
                e.currentTarget.style.borderColor = "rgba(125,249,255,0.6)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "rgba(125,249,255,0.55)";
                e.currentTarget.style.borderColor = "rgba(125,249,255,0.2)";
              }}
            >✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function WorldviewMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapLoaded = useRef(false);
  const pendingUpdate = useRef<GeoJSON.FeatureCollection | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>("2d");
  const [visionMode, setVisionMode] = useState<VisionMode>(() => readStoredVision().mode);
  const [flirPalette, setFlirPalette] = useState<FlirPalette>(() => readStoredVision().flir);
  const baseLayerIdsRef = useRef<Set<string>>(new Set());
  const [mode, setMode] = useState<FilterMode>("civil");
  const [areaMode, setAreaMode] = useState<AreaMode>("global");
  const [radius, setRadius] = useState(500);
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [selectedAircraft, setSelectedAircraft] = useState<Aircraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [civCount, setCivCount] = useState(0);
  const [milCount, setMilCount] = useState(0);
  const [webglError, setWebglError] = useState(false);
  const [mapLoadedState, setMapLoadedState] = useState(false);
  const [trackedHex, setTrackedHex] = useState<string | null>(null);
  const [satIntelOn, setSatIntelOn] = useState(false);

  // ── MODULAR WINDOW SYSTEM ───────────────────────────────────────────────
  // Each data panel is a draggable, minimizable floating window. The thin
  // left toolbar toggles them open/closed. New panels (Maritime Intel, etc.)
  // get added here as more state slots.
  const [aviationPanelOpen, setAviationPanelOpen] = useState(true);
  // Contacts can be detached from the Aviation Intel panel into its own
  // floating window. Dragging the floating window back near the right edge of
  // the Aviation Intel panel re-docks it (magnetic snap).
  const [contactsDocked, setContactsDocked] = useState(true);
  const aviationPanelDOMRef = useRef<HTMLDivElement | null>(null);

  // ── MARITIME INTEL ──────────────────────────────────────────────────────
  // Floating panel + ShipsLayer (5s polling). Filters control globe rendering
  // only; metric counts always reflect the unfiltered tick.
  const [maritimePanelOpen, setMaritimePanelOpen] = useState(true);
  const [ships, setShips] = useState<Ship[]>([]);
  const [shipsLoading, setShipsLoading] = useState(false);
  const [shipsError, setShipsError] = useState<string | null>(null);
  const [shipsLastUpdate, setShipsLastUpdate] = useState<Date | null>(null);
  const [shipFilters, setShipFilters] = useState<ShipFilters>({
    military: true, tankers: true, globalAis: true, aisGap: true,
  });

  // ── CCTV INTEL ──────────────────────────────────────────────────────────
  // Public DOT / city open-data cameras (NYC, London, California, Singapore,
  // Austin, optional Windy) + OSM surveillance locations. All data is served
  // by the api-server at /api/proxy/cctv/*. See docs/CCTV_INTEGRATION.md.
  const [cctvPanelOpen, setCctvPanelOpen] = useState(false);
  const [cctvEverOpened, setCctvEverOpened] = useState(false);
  const [cctvEnabled, setCctvEnabled] = useState<CctvSourceId[]>(["nyc", "tfl", "caltrans", "maryland", "florida", "oregon", "singapore", "austin", "windy"]);
  const [cctvSelected, setCctvSelected] = useState<CctvCamera | null>(null);
  const cctvOsmOn = cctvEnabled.includes("osm");
  const {
    cameras: cctvCameras,
    sources: cctvSources,
    loading: cctvLoading,
    error: cctvError,
    osmCameras: cctvOsmCameras,
    osmStatus: cctvOsmStatus,
  } = useCctv({
    active: cctvEverOpened,
    map: mapRef.current,
    mapLoaded: mapLoadedState,
    osmEnabled: cctvPanelOpen && cctvOsmOn,
  });
  const toggleCctvSource = useCallback((id: CctvSourceId) => {
    setCctvEnabled((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);
  const selectCctvCamera = useCallback((cam: CctvCamera) => {
    setCctvSelected(cam);
    mapRef.current?.flyTo({
      center: [cam.lon, cam.lat],
      zoom: Math.max(mapRef.current.getZoom(), 15),
      duration: 900,
      essential: true,
    });
  }, []);

  // ── PLAYBACK INTEL ──────────────────────────────────────────────────────
  const [playbackOpen, setPlaybackOpen] = useState(false);
  const [playbackActive, setPlaybackActive] = useState(false);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("INDIA");
  const [playbackConfig, setPlaybackConfig] = useState<any>(null);
  const [playbackFrames, setPlaybackFrames] = useState<PlaybackIndexFrame[]>([]);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 2 | 4>(1);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [playbackFrameLoading, setPlaybackFrameLoading] = useState(false);
  const [playbackShips, setPlaybackShips] = useState<PlaybackShipContact[]>([]);
  const [playbackPlanes, setPlaybackPlanes] = useState<PlaybackPlaneContact[]>([]);
  const [selectedPlaybackEntity, setSelectedPlaybackEntity] = useState<PlaybackSelectedEntity | null>(null);
  const [playbackTrailPoints, setPlaybackTrailPoints] = useState<PlaybackTrailPoint[]>([]);
  const [playbackTrailLoading, setPlaybackTrailLoading] = useState(false);

  const frameCacheRef = useRef<Map<string, any>>(new Map());
  const abortFrameRef = useRef<AbortController | null>(null);
  const reqSeqRef = useRef<number>(0);

  // Fetch config once on mount
  useEffect(() => {
    fetch("/api/proxy/playback/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg) setPlaybackConfig(cfg);
      })
      .catch(() => {});
  }, []);

  const regionBounds = useMemo<PlaybackRegionBounds | null>(() => {
    if (playbackMode === "PLANES") return null;
    if (playbackConfig?.ship_regions?.[playbackMode]) {
      return playbackConfig.ship_regions[playbackMode];
    }
    if (playbackMode === "INDIA") return { latMin: 5, latMax: 26, lonMin: 66, lonMax: 90 };
    if (playbackMode === "HORMUZ") return { latMin: 22, latMax: 31, lonMin: 47, lonMax: 62 };
    return null;
  }, [playbackMode, playbackConfig]);

  // Load index when playback opens or mode changes
  const loadPlaybackIndex = useCallback(async (modeToLoad: PlaybackMode) => {
    setPlaybackLoading(true);
    setSelectedPlaybackEntity(null);
    setPlaybackTrailPoints([]);
    try {
      const url =
        modeToLoad === "PLANES"
          ? "/api/proxy/playback/planes/index?hours=24"
          : `/api/proxy/playback/ships/${modeToLoad}/index?hours=24`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Index fetch failed");
      const data = await res.json();
      const frames: PlaybackIndexFrame[] = Array.isArray(data.frames) ? data.frames : [];
      setPlaybackFrames(frames);

      // Fly map to the region
      const map = mapRef.current;
      if (map) {
        if (modeToLoad === "INDIA") {
          map.fitBounds([[66, 5], [90, 26]], { padding: 60, duration: 1500 });
        } else if (modeToLoad === "HORMUZ") {
          map.fitBounds([[47, 22], [62, 31]], { padding: 60, duration: 1500 });
        } else if (modeToLoad === "PLANES") {
          map.flyTo({ center: [68, 22], zoom: 4.5, duration: 1500 });
        }
      }

      if (frames.length > 0) {
        // Start from newest frame
        const lastIdx = frames.length - 1;
        setCurrentFrameIndex(lastIdx);
      } else {
        setPlaybackShips([]);
        setPlaybackPlanes([]);
      }
    } catch (err) {
      console.warn("Failed to load playback index:", err);
      setPlaybackFrames([]);
    } finally {
      setPlaybackLoading(false);
    }
  }, []);

  // When playback is activated or mode changes, trigger index load
  useEffect(() => {
    if (playbackActive) {
      loadPlaybackIndex(playbackMode);
    }
  }, [playbackActive, playbackMode, loadPlaybackIndex]);

  // Load a single frame (with in-memory cache + stale abort + monotonic sequence)
  const loadPlaybackFrame = useCallback(
    async (frameId: number, modeToLoad: PlaybackMode) => {
      const cacheKey = `${modeToLoad}:${frameId}`;
      if (frameCacheRef.current.has(cacheKey)) {
        const cached = frameCacheRef.current.get(cacheKey);
        if (modeToLoad === "PLANES") {
          const raw = cached.planes || [];
          setPlaybackPlanes(
            raw.map((p: any[]) => ({
              hex: p[0],
              lat: p[1],
              lon: p[2],
              alt_ft: p[3],
              gs_kt: p[4],
              track: p[5],
              callsign: p[6],
              mil: p[7],
            }))
          );
          setPlaybackShips([]);
        } else {
          const raw = cached.ships || [];
          setPlaybackShips(
            raw.map((s: any[]) => ({
              mmsi: s[0],
              lat: s[1],
              lon: s[2],
              sog: s[3],
              cog: s[4],
              cat: s[5],
            }))
          );
          setPlaybackPlanes([]);
        }
        return;
      }

      if (abortFrameRef.current) {
        abortFrameRef.current.abort();
      }
      const abortCtrl = new AbortController();
      abortFrameRef.current = abortCtrl;
      const currentSeq = ++reqSeqRef.current;

      setPlaybackFrameLoading(true);
      try {
        const url =
          modeToLoad === "PLANES"
            ? `/api/proxy/playback/planes/frame/${frameId}`
            : `/api/proxy/playback/ships/${modeToLoad}/frame/${frameId}`;
        const res = await fetch(url, { signal: abortCtrl.signal });
        if (!res.ok) throw new Error("Frame fetch failed");
        const data = await res.json();
        frameCacheRef.current.set(cacheKey, data);

        if (currentSeq === reqSeqRef.current) {
          if (modeToLoad === "PLANES") {
            const raw = data.planes || [];
            setPlaybackPlanes(
              raw.map((p: any[]) => ({
                hex: p[0],
                lat: p[1],
                lon: p[2],
                alt_ft: p[3],
                gs_kt: p[4],
                track: p[5],
                callsign: p[6],
                mil: p[7],
              }))
            );
            setPlaybackShips([]);
          } else {
            const raw = data.ships || [];
            setPlaybackShips(
              raw.map((s: any[]) => ({
                mmsi: s[0],
                lat: s[1],
                lon: s[2],
                sog: s[3],
                cog: s[4],
                cat: s[5],
              }))
            );
            setPlaybackPlanes([]);
          }
        }
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.warn("Failed to load playback frame:", err);
        }
      } finally {
        if (currentSeq === reqSeqRef.current) {
          setPlaybackFrameLoading(false);
        }
      }
    },
    []
  );

  // When currentFrameIndex changes, load the frame
  useEffect(() => {
    if (!playbackActive || playbackFrames.length === 0) return;
    const target = playbackFrames[currentFrameIndex];
    if (target) {
      loadPlaybackFrame(target.id, playbackMode);
    }
  }, [playbackActive, playbackFrames, currentFrameIndex, playbackMode, loadPlaybackFrame]);

  // Playing loop & Prefetching
  useEffect(() => {
    if (!playbackActive || !isPlaying || playbackFrames.length < 2) return;

    // Prefetch next 2 frames lazily
    for (const offset of [1, 2]) {
      const nextIdx = (currentFrameIndex + offset) % playbackFrames.length;
      const nextFrame = playbackFrames[nextIdx];
      if (nextFrame) {
        const nextKey = `${playbackMode}:${nextFrame.id}`;
        if (!frameCacheRef.current.has(nextKey)) {
          const url =
            playbackMode === "PLANES"
              ? `/api/proxy/playback/planes/frame/${nextFrame.id}`
              : `/api/proxy/playback/ships/${playbackMode}/frame/${nextFrame.id}`;
          fetch(url)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (d) frameCacheRef.current.set(nextKey, d);
            })
            .catch(() => {});
        }
      }
    }

    const intervalMs = playbackSpeed === 4 ? 350 : playbackSpeed === 2 ? 700 : 1400;
    const timer = setInterval(() => {
      setCurrentFrameIndex((prev) => (prev + 1 >= playbackFrames.length ? 0 : prev + 1));
    }, intervalMs);

    return () => clearInterval(timer);
  }, [playbackActive, isPlaying, playbackFrames, currentFrameIndex, playbackMode, playbackSpeed]);

  // Trail selection
  const handleSelectPlaybackEntity = useCallback(
    async (entity: PlaybackSelectedEntity) => {
      setSelectedPlaybackEntity(entity);
      setPlaybackTrailLoading(true);
      try {
        const url =
          entity.type === "plane"
            ? `/api/proxy/playback/planes/trail/${entity.id}?hours=24`
            : `/api/proxy/playback/ships/${playbackMode}/trail/${entity.id}?hours=24`;
        const res = await fetch(url);
        if (res.ok) {
          const trail = await res.json();
          setPlaybackTrailPoints(Array.isArray(trail) ? trail : []);
        }
      } catch (err) {
        console.warn("Failed to fetch playback trail:", err);
      } finally {
        setPlaybackTrailLoading(false);
      }
    },
    [playbackMode]
  );

  const exitPlayback = useCallback(() => {
    setPlaybackActive(false);
    setPlaybackOpen(false);
    setIsPlaying(false);
    setSelectedPlaybackEntity(null);
    setPlaybackTrailPoints([]);
  }, []);
  // Multi-select: a Set of NORAD IDs currently flagged for overwatch.
  const [selectedSatIds, setSelectedSatIds] = useState<Set<string>>(new Set());
  // Latest position snapshot keyed by NORAD ID — feeds the overwatch panel
  // with live altitude/velocity for currently-selected sats.
  const [satPosMap, setSatPosMap] = useState<Map<string, SatPosition>>(new Map());
  // User overrides on top of auto-acquisition: explicitly added or removed.
  const userAddedRef = useRef<Set<string>>(new Set());
  const userRemovedRef = useRef<Set<string>>(new Set());
  const [visibility, setVisibility] = useState<"both" | "flights" | "satellites">("both");
  // Theater of Operations — free-text global search
  const [theaterSearch, setTheaterSearch] = useState("");
  const [theaterResults, setTheaterResults] = useState<NominatimHit[]>([]);
  const [theaterDropdownOpen, setTheaterDropdownOpen] = useState(false);
  const [theaterActive, setTheaterActive] = useState(false);
  const [theaterLoading, setTheaterLoading] = useState(false);
  const [theaterError, setTheaterError] = useState<string | null>(null);
  // Centroid [lon, lat] of the active theater — drives proximity fading + auto-acquisition.
  const [theaterCenter, setTheaterCenter] = useState<[number, number] | null>(null);
  const [theaterName, setTheaterName] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedRef = useRef<Aircraft | null>(null);
  selectedRef.current = selectedAircraft;
  const aircraftRef = useRef<Aircraft[]>([]);
  aircraftRef.current = aircraft;
  const modeRef = useRef<FilterMode>("civil");
  modeRef.current = mode;
  const trackedHexRef = useRef<string | null>(null);
  trackedHexRef.current = trackedHex;
  const trackedHeadingRef = useRef<number>(0);
  const trackedBearingRef = useRef<number>(0);
  const trackedPitchRef = useRef<number>(0);
  const preTrackCameraRef = useRef<{ center: [number, number]; zoom: number; pitch: number; bearing: number; projection: "mercator" | "globe" } | null>(null);

  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    preloadModels(base);
  }, [base]);

  const buildGeoJson = useCallback((data: Aircraft[], selectedHex: string | undefined, isMil: boolean): GeoJSON.FeatureCollection => {
    const color = isMil ? MIL_COLOR : CIV_COLOR;
    const selectedColor = isMil ? "#ff8c42" : "#aaffff";
    return {
      type: "FeatureCollection",
      features: data
        .filter((a) => a.lat !== undefined && a.lon !== undefined)
        .map((a) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [a.lon!, a.lat!] },
          properties: {
            hex: a.hex,
            heading: a.track ?? 0,
            color: a.hex === selectedHex ? selectedColor : color,
            size: a.hex === selectedHex ? 1.3 : 0.75,
            flight: a.flight?.trim() || a.hex,
            alt_baro: typeof a.alt_baro === "number" ? a.alt_baro : 0,
            gs: typeof a.gs === "number" ? a.gs : 0,
            t: a.t || "",
            squawk: a.squawk || "",
            r: a.r || "",
            lat: a.lat ?? 0,
            lon: a.lon ?? 0,
          },
        })),
    };
  }, []);

  const pushToMap = useCallback((geojson: GeoJSON.FeatureCollection) => {
    const map = mapRef.current;
    if (!map || !mapLoaded.current) {
      pendingUpdate.current = geojson;
      return;
    }
    const src = map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(geojson);
  }, []);

  const inflightRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const hasAircraftRef = useRef(false);

  const fetchData = useCallback(async (currentMode: FilterMode, currentAreaMode: AreaMode, currentRadius: number) => {
    const key = `${currentMode}:${currentAreaMode}:${currentRadius}`;
    if (inflightRef.current?.key === key) return;
    inflightRef.current?.controller.abort();
    const controller = new AbortController();
    inflightRef.current = { key, controller };

    setLoading(true);
    try {
      let url: string;
      if (currentMode === "military") {
        url = `${base}/api/proxy/adsb/mil`;
      } else if (currentAreaMode === "local" && mapRef.current) {
        const center = mapRef.current.getCenter();
        const lat = center.lat.toFixed(4);
        const lon = center.lng.toFixed(4);
        url = `${base}/api/proxy/adsb/area?lat=${lat}&lon=${lon}&radius=${currentRadius}`;
      } else {
        url = `${base}/api/proxy/adsb/global`;
      }

      const res = await fetch(url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const raw: Aircraft[] = json.ac || json.aircraft || [];
      const data = raw.filter((a) => a.lat !== undefined && a.lon !== undefined);
      hasAircraftRef.current = true;
      setError(null);

      if (currentMode === "military") {
        setMilCount(data.length);
      } else {
        setCivCount(data.length);
      }

      setAircraft(data);
      setLastUpdate(new Date());

      const isMil = currentMode === "military";
      const selectedHex = selectedRef.current?.hex;
      const geojson = buildGeoJson(data, selectedHex, isMil);
      pushToMap(geojson);

      if (selectedRef.current) {
        const updated = data.find((a) => a.hex === selectedRef.current!.hex);
        if (updated) setSelectedAircraft(updated);
      }
    } catch (e: unknown) {
      const superseded = controller.signal.aborted;
      if (!superseded && !hasAircraftRef.current && e instanceof Error) {
        setError("FEED INTERRUPTED");
      }
    } finally {
      if (inflightRef.current?.controller === controller) {
        inflightRef.current = null;
        setLoading(false);
      }
    }
  }, [base, buildGeoJson, pushToMap]);

  useEffect(() => {
    if (!mapContainer.current || webglError) return;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: mapContainer.current,
        style: "https://tiles.openfreemap.org/styles/dark",
        center: [0, 20],
        zoom: 2.5,
        minZoom: 1,
        maxZoom: 19,
        maxPitch: 85,
        attributionControl: false,
      });

      map.on("error", (e) => {
        const msg = String((e.error as Error)?.message || "");
        if (msg.toLowerCase().includes("webgl") || msg.includes("context") || msg.includes("WebGL")) {
          setWebglError(true);
        }
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      map.doubleClickZoom.disable();

      map.on("load", () => {
        baseLayerIdsRef.current = new Set(map.getStyle().layers.map((l) => l.id));
        (window as unknown as { __v0map: maplibregl.Map }).__v0map = map;
        const imgData = createAircraftSdfImage(32);
        map.addImage("aircraft-icon", imgData, { sdf: true });

        map.addSource("aircraft", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        // Theater of operations boundary — glowing tactical yellow polygon.
        map.addSource("theater-region", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "theater-fill",
          type: "fill",
          source: "theater-region",
          paint: {
            "fill-color": THEATER_COLOR,
            "fill-opacity": 0.05,
          },
        });
        map.addLayer({
          id: "theater-glow",
          type: "line",
          source: "theater-region",
          paint: {
            "line-color": THEATER_COLOR,
            "line-width": 6,
            "line-opacity": 0.25,
            "line-blur": 4,
          },
        });
        map.addLayer({
          id: "theater-line",
          type: "line",
          source: "theater-region",
          paint: {
            "line-color": THEATER_COLOR,
            "line-width": 1.6,
            "line-opacity": 0.95,
          },
        });

        map.addLayer({
          id: "aircraft-layer",
          type: "symbol",
          source: "aircraft",
          layout: {
            "icon-image": "aircraft-icon",
            "icon-rotate": ["get", "heading"],
            "icon-rotation-alignment": "map",
            "icon-pitch-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-size": ["get", "size"],
          },
          paint: {
            "icon-color": ["get", "color"],
            "icon-opacity": 0.92,
          },
        });

        map.on("click", "aircraft-layer", (e) => {
          const features = e.features;
          if (!features?.length) return;
          const hex = features[0].properties?.hex as string;
          const found = aircraftRef.current.find((a) => a.hex === hex);
          if (found) setSelectedAircraft(found);
        });

        map.on("dblclick", "aircraft-layer", (e) => {
          e.preventDefault();
          const features = e.features;
          if (!features?.length) return;
          const hex = features[0].properties?.hex as string;
          const found = aircraftRef.current.find((a) => a.hex === hex);
          if (found) {
            setSelectedAircraft(found);
            setTrackedHex(hex);
          }
        });

        map.on("mouseenter", "aircraft-layer", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "aircraft-layer", () => {
          map.getCanvas().style.cursor = "";
        });

        mapLoaded.current = true;
        setMapLoadedState(true);

        if (pendingUpdate.current) {
          const src = map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined;
          if (src) src.setData(pendingUpdate.current);
          pendingUpdate.current = null;
        }
      });

      mapRef.current = map;
    } catch {
      setWebglError(true);
    }

    return () => {
      mapLoaded.current = false;
      setMapLoadedState(false);
      try { map?.remove(); } catch { /* ignore */ }
      mapRef.current = null;
    };
  }, [webglError]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedState) return;

    const apply = () => {
      try {
        if (viewMode === "3d") {
          map.setProjection({ type: "globe" });
          // Dark space atmosphere — suppress the default white/blue haze.
          // setFog controls the horizon and space colors on the globe.
          try {
            (map as maplibregl.Map & { setFog: (fog: Record<string, unknown> | null) => void }).setFog({
              color: "#020408",
              "high-color": "#000000",
              "space-color": "#000000",
              "horizon-blend": 0.015,
              "star-intensity": 0,
              range: [0.5, 10],
            });
          } catch { /* setFog may not be available in all builds */ }
          // Keep atmosphere-blend low so the tile edge blends to black, not white.
          try { map.setSky({ "atmosphere-blend": 0.15 }); } catch { /* ignore */ }
          if (map.getZoom() > 5) {
            map.flyTo({ zoom: 2.5, duration: 900 });
          }
        } else {
          map.setProjection({ type: "mercator" });
          try {
            (map as maplibregl.Map & { setFog: (fog: Record<string, unknown> | null) => void }).setFog(null);
          } catch { /* ignore */ }
          try { map.setSky({ "atmosphere-blend": 0 }); } catch { /* ignore */ }
        }
      } catch { /* style not ready yet — handled by once('idle') below */ }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("idle", apply);
  }, [viewMode, mapLoadedState]);

  useEffect(() => {
    try {
      localStorage.setItem(VISION_STORAGE_KEY, JSON.stringify({ mode: visionMode, flir: flirPalette }));
    } catch { /* storage unavailable */ }
  }, [visionMode, flirPalette]);

  // Vision mode → base imagery + entity colours. Layers added later (ships, sats, CCTV,
  // playback) are picked up by re-applying whenever the layer list changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedState) return;
    let signature = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      timer = null;
      if (!styleReady(map)) return;
      const ids = map.getStyle().layers.map((l) => l.id).join(",");
      if (ids === signature) return;
      applyVisionToMap(map, visionMode, baseLayerIdsRef.current);
      signature = map.getStyle().layers.map((l) => l.id).join(",");
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(apply, 120);
    };
    apply();
    if (!signature) map.once("idle", apply);
    map.on("styledata", schedule);
    return () => {
      map.off("styledata", schedule);
      map.off("idle", apply);
      if (timer) clearTimeout(timer);
    };
  }, [visionMode, mapLoadedState]);

  useEffect(() => {
    fetchData(mode, areaMode, radius);
  }, [mode, areaMode, radius, fetchData]);

  useEffect(() => {
    const interval = setInterval(() => fetchData(mode, areaMode, radius), 5000);
    return () => clearInterval(interval);
  }, [mode, areaMode, radius, fetchData]);

  // ── MARITIME radar & dark-fleet polling — 5s ticks against the api-server proxy.
  //    Radar ships come from /api/proxy/ships (/api/radar).
  //    AIS gap candidates come strictly from /api/proxy/dark-fleet (/api/dark-fleet)
  //    using their last_known_lat and last_known_lon.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        setShipsLoading(true);
        const [shipsRes, darkRes] = await Promise.allSettled([
          fetch(`${base}/api/proxy/ships`),
          fetch(`${base}/api/proxy/dark-fleet`),
        ]);

        let radarShips: Ship[] = [];
        if (shipsRes.status === "fulfilled" && shipsRes.value.ok) {
          const data = (await shipsRes.value.json()) as Ship[];
          if (Array.isArray(data)) radarShips = data;
        }

        let darkShips: Ship[] = [];
        if (darkRes.status === "fulfilled" && darkRes.value.ok) {
          const darkData = await darkRes.value.json();
          if (Array.isArray(darkData)) {
            darkShips = darkData
              .filter((d: { last_known_lat?: unknown; last_known_lon?: unknown }) =>
                typeof d.last_known_lat === "number" && typeof d.last_known_lon === "number"
              )
              .map((d: {
                mmsi: string | number;
                ship_name?: string;
                last_known_lat: number;
                last_known_lon: number;
                time_went_dark?: string;
                last_sog?: number;
                last_cog?: number;
              }) => ({
                mmsi: Number(d.mmsi) || d.mmsi,
                ship_name: d.ship_name || "UNKNOWN",
                vessel_name: d.ship_name || "UNKNOWN",
                lat: d.last_known_lat,
                lon: d.last_known_lon,
                last_known_lat: d.last_known_lat,
                last_known_lon: d.last_known_lon,
                sog: typeof d.last_sog === "number" ? d.last_sog : undefined,
                cog: typeof d.last_cog === "number" ? d.last_cog : undefined,
                source: "DARK_FLEET",
                category: "UNKNOWN",
                is_gap: true,
                time_went_dark: d.time_went_dark,
              }));
          }
        }

        if (cancelled) return;

        if (radarShips.length > 0 || darkShips.length > 0) {
          setShips([...radarShips, ...darkShips]);
          setShipsError(null);
          setShipsLastUpdate(new Date());
        } else if (shipsRes.status === "rejected" || (shipsRes.status === "fulfilled" && !shipsRes.value.ok)) {
          const reason = shipsRes.status === "rejected" ? shipsRes.reason : `HTTP ${shipsRes.value.status}`;
          setShipsError(reason instanceof Error ? reason.message : String(reason));
        }
      } catch (err) {
        if (cancelled) return;
        setShipsError(err instanceof Error ? err.message : "ships fetch failed");
      } finally {
        if (!cancelled) setShipsLoading(false);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [base]);

  useEffect(() => {
    if (!mapLoadedState) return;
    const isMil = mode === "military";
    const geojson = buildGeoJson(aircraft, selectedAircraft?.hex, isMil);
    pushToMap(geojson);
  }, [selectedAircraft, mapLoadedState, aircraft, mode, buildGeoJson, pushToMap]);

  // Hide the SVG marker for the tracked aircraft (3D model takes over)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedState) return;
    if (!map.getLayer("aircraft-layer")) return;
    if (trackedHex) {
      map.setFilter("aircraft-layer", ["!=", ["get", "hex"], trackedHex]);
    } else {
      map.setFilter("aircraft-layer", null);
    }
  }, [trackedHex, mapLoadedState]);

  // VISIBILITY toggle — flights / satellites / both
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedState) return;
    const showFlights = aviationPanelOpen && visibility !== "satellites" && !playbackActive;
    const showSats = visibility !== "flights";
    const setVis = (id: string, on: boolean) => {
      if (map.getLayer(id)) {
        try { map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); } catch { /* noop */ }
      }
    };
    setVis("aircraft-layer", showFlights);
    ["satellites-layer", "sat-orbit-line", "sat-orbit-glow", "sat-footprint-fill", "sat-footprint-ring", "sat-footprint-spokes", "sat-nadir-line", "sat-nadir-dot"].forEach((id) => setVis(id, showSats && satIntelOn));
    if (!showFlights && trackedHex) setTrackedHex(null);
    if (!showFlights) setSelectedAircraft(null);
    if (!showSats) {
      setSelectedSatIds(new Set());
      userAddedRef.current = new Set();
      userRemovedRef.current = new Set();
    }
  }, [visibility, mapLoadedState, satIntelOn, trackedHex, aviationPanelOpen, playbackActive]);

  // THEATER OF OPERATIONS — debounced Nominatim autocomplete search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const q = theaterSearch.trim();
    if (q.length < 2) {
      setTheaterResults([]);
      setTheaterDropdownOpen(false);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&polygon_geojson=1&limit=5`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (!r.ok) return;
        const hits = (await r.json()) as NominatimHit[];
        setTheaterResults(hits);
        setTheaterDropdownOpen(hits.length > 0);
      } catch { /* ignore network errors */ }
    }, 500);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [theaterSearch]);

  // Handle selecting a search result: draw boundary + cinematic fly-in
  const handleTheaterSelect = useCallback((hit: NominatimHit) => {
    setTheaterDropdownOpen(false);
    setTheaterResults([]);
    // Show the short place name in the input
    const shortName = hit.display_name.split(",")[0].trim();
    setTheaterSearch(shortName);
    setTheaterActive(true);
    setTheaterName(shortName);
    setTheaterError(null);
    // Reset user overrides on each new theater so auto-acquisition starts clean.
    userAddedRef.current = new Set();
    userRemovedRef.current = new Set();
    setSelectedSatIds(new Set());

    const map = mapRef.current;
    if (!map || !mapLoadedState) return;
    const src = map.getSource("theater-region") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!hit.geojson) {
      setTheaterError("NO BOUNDARY DATA");
      return;
    }

    setTheaterLoading(true);
    const feature: GeoJSON.Feature = {
      type: "Feature",
      geometry: hit.geojson,
      properties: { name: shortName },
    };
    src.setData({ type: "FeatureCollection", features: [feature] });

    // Centroid: prefer Nominatim's bbox, fall back to geometry sweep.
    let center: [number, number] | null = null;
    if (hit.boundingbox) {
      const [minLatS, maxLatS, minLonS, maxLonS] = hit.boundingbox;
      const lat = (parseFloat(minLatS) + parseFloat(maxLatS)) / 2;
      const lon = (parseFloat(minLonS) + parseFloat(maxLonS)) / 2;
      if (isFinite(lat) && isFinite(lon)) center = [lon, lat];
    }
    if (!center && hit.lat && hit.lon) center = [parseFloat(hit.lon), parseFloat(hit.lat)];
    if (!center) center = geometryCentroid(hit.geojson);

    if (center) {
      const flyCenter = center;
      setTheaterCenter([flyCenter[0], flyCenter[1]]);
      if (viewMode !== "3d") setViewMode("3d");
      const flyCinematic = () => {
        map.flyTo({ center: flyCenter, pitch: 75, zoom: 4, bearing: 0, duration: 2400, essential: true });
      };
      if (viewMode === "3d") flyCinematic();
      else setTimeout(flyCinematic, 250);
    }
    setTheaterLoading(false);
  }, [mapLoadedState, viewMode]);

  // Clear the theater — remove boundary, reset camera to global view
  const handleTheaterClear = useCallback(() => {
    setTheaterSearch("");
    setTheaterResults([]);
    setTheaterDropdownOpen(false);
    setTheaterActive(false);
    setTheaterError(null);
    setTheaterCenter(null);
    setTheaterName(null);
    userAddedRef.current = new Set();
    userRemovedRef.current = new Set();
    setSelectedSatIds(new Set());
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    const map = mapRef.current;
    if (!map || !mapLoadedState) return;
    const src = map.getSource("theater-region") as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData({ type: "FeatureCollection", features: [] });
    map.flyTo({ center: [0, 20], zoom: 2.5, pitch: 0, bearing: 0, duration: 1200 });
  }, [mapLoadedState]);

  // ── SATELLITE OVERWATCH ──────────────────────────────────────────────────
  // Receive the latest position snapshot from SatelliteLayer on each tick.
  // Updates the lookup map for the panel and drives auto-acquisition when a
  // theater is active.
  const handleSatPositions = useCallback((positions: SatPosition[]) => {
    // Build position-by-id map (cheap: positions are typically <1500 sats).
    const next = new Map<string, SatPosition>();
    for (const p of positions) next.set(p.noradId, p);
    setSatPosMap(next);

    if (!theaterActive || !theaterCenter) return;

    // Auto-acquire all sats whose Nadir falls within OVERWATCH_RADIUS_KM of
    // the theater centroid. User overrides (added / removed) are respected.
    const [tLon, tLat] = theaterCenter;
    const auto = new Set<string>();
    for (const p of positions) {
      // Skip noisy LEO swarms — they'd flood the overwatch panel otherwise.
      if (p.isSwarm) continue;
      const d = haversineKm(p.lat, p.lon, tLat, tLon);
      if (d <= OVERWATCH_RADIUS_KM) auto.add(p.noradId);
    }
    // Apply user overrides.
    for (const id of userAddedRef.current) auto.add(id);
    for (const id of userRemovedRef.current) auto.delete(id);

    // Only update state when the membership actually changed (avoid render churn).
    setSelectedSatIds((prev) => {
      if (prev.size === auto.size) {
        let same = true;
        for (const id of auto) if (!prev.has(id)) { same = false; break; }
        if (same) return prev;
      }
      return auto;
    });
  }, [theaterActive, theaterCenter]);

  // User clicked a sat → toggle it on/off in the selection set, recording an
  // override so auto-acquisition doesn't immediately re-flip it.
  const toggleSatSelection = useCallback((sat: SatPosition) => {
    setSelectedSatIds((prev) => {
      const next = new Set(prev);
      if (next.has(sat.noradId)) {
        next.delete(sat.noradId);
        userRemovedRef.current.add(sat.noradId);
        userAddedRef.current.delete(sat.noradId);
      } else {
        next.add(sat.noradId);
        userAddedRef.current.add(sat.noradId);
        userRemovedRef.current.delete(sat.noradId);
      }
      return next;
    });
  }, []);

  // Smoothly follow the tracked aircraft: pan the map to its latest position on each data refresh
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedState || !trackedHex) return;
    const a = aircraft.find((x) => x.hex === trackedHex);
    if (!a || a.lat === undefined || a.lon === undefined) return;
    trackedHeadingRef.current = a.track ?? trackedHeadingRef.current;
    map.easeTo({
      center: [a.lon, a.lat],
      duration: 2500,
      easing: (t) => t,
    });
  }, [aircraft, trackedHex, mapLoadedState]);

  // Activate / deactivate cinematic tracking
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedState) return;

    if (!trackedHex) {
      const prev = preTrackCameraRef.current;
      if (prev) {
        const restore = () => {
          try { map.setProjection({ type: prev.projection }); } catch { /* ignore */ }
          if (prev.projection === "globe") {
            try { map.setSky({ "atmosphere-blend": 1 }); } catch { /* ignore */ }
          }
          map.easeTo({
            center: prev.center,
            zoom: prev.zoom,
            pitch: prev.pitch,
            bearing: prev.bearing,
            duration: 1000,
          });
        };
        if (map.isStyleLoaded()) restore();
        else map.once("idle", restore);
        preTrackCameraRef.current = null;
      }
      return;
    }

    const a = aircraftRef.current.find((x) => x.hex === trackedHex);
    if (!a || a.lat === undefined || a.lon === undefined) {
      setTrackedHex(null);
      return;
    }

    const c = map.getCenter();
    preTrackCameraRef.current = {
      center: [c.lng, c.lat],
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      projection: viewMode === "3d" ? "globe" : "mercator",
    };

    trackedHeadingRef.current = a.track ?? 0;
    trackedBearingRef.current = 0;
    trackedPitchRef.current = 70;

    map.flyTo({
      center: [a.lon!, a.lat!],
      zoom: 14,
      pitch: 70,
      bearing: 0,
      duration: 1800,
      essential: true,
    });
    const switchProj = () => {
      try {
        map.setProjection({ type: "mercator" });
        map.setSky({ "atmosphere-blend": 0 });
      } catch { /* ignore */ }
    };
    map.once("moveend", switchProj);

    map.dragPan.disable();
    map.dragRotate.disable();
    map.doubleClickZoom.disable();
    map.scrollZoom.disable();
    try { map.boxZoom.disable(); } catch { /* ignore */ }
    try { map.touchZoomRotate.disable(); } catch { /* ignore */ }
    try { map.keyboard.disable(); } catch { /* ignore */ }

    // Custom drag → orbit the map around the plane (and the overlay model rotates with it)
    const canvas = map.getCanvas();
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = "grabbing";
      e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const newBearing = map.getBearing() - dx * 0.45;
      const newPitch = Math.max(0, Math.min(85, map.getPitch() - dy * 0.35));
      map.setBearing(newBearing);
      map.setPitch(newPitch);
      trackedBearingRef.current = newBearing;
      trackedPitchRef.current = newPitch;
    };
    const onUp = () => {
      dragging = false;
      canvas.style.cursor = "";
    };
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    // Keep refs in sync if anything else moves the map (e.g. flyTo arrival)
    const syncCam = () => {
      trackedBearingRef.current = map.getBearing();
      trackedPitchRef.current = map.getPitch();
    };
    map.on("rotate", syncCam);
    map.on("pitch", syncCam);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedAircraft(null);
        setTrackedHex(null);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      map.off("rotate", syncCam);
      map.off("pitch", syncCam);
      canvas.style.cursor = "";
      try { map.dragPan.enable(); } catch { /* ignore */ }
      try { map.dragRotate.enable(); } catch { /* ignore */ }
      try { map.doubleClickZoom.enable(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedHex, mapLoadedState]);

  // Clearing the selection (CLR button) also exits cinematic tracking
  useEffect(() => {
    if (!selectedAircraft && trackedHex) {
      setTrackedHex(null);
    }
  }, [selectedAircraft, trackedHex]);

  const handleSelectAircraft = useCallback((a: Aircraft) => {
    setSelectedAircraft(a);
    if (mapRef.current && a.lat !== undefined && a.lon !== undefined) {
      const currentZoom = mapRef.current.getZoom();
      const targetZoom = viewMode === "3d"
        ? Math.max(currentZoom, 3.5)
        : Math.max(currentZoom, 5);
      mapRef.current.flyTo({ center: [a.lon, a.lat], zoom: targetZoom, duration: 700 });
    }
  }, [viewMode]);

  const displayedAircraft = aircraft.slice(0, 100);
  const isMil = mode === "military";
  const accentColor = isMil ? MIL_COLOR : CIV_COLOR;

  // ── Unified selection + cinematic tracking (aircraft / ship / satellite) ──
  const [focus, setFocus] = useState<EntityRef | null>(null);
  const [trackedShipId, setTrackedShipId] = useState<string | null>(null);
  const [trackedSatId, setTrackedSatId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedAircraft) setFocus({ kind: "aircraft", id: selectedAircraft.hex });
    else setFocus((f) => (f?.kind === "aircraft" ? null : f));
  }, [selectedAircraft?.hex]);

  useEffect(() => {
    if (trackedHex) {
      setTrackedShipId(null);
      setTrackedSatId(null);
    }
  }, [trackedHex]);

  const clearTracking = useCallback(() => {
    setTrackedHex(null);
    setTrackedShipId(null);
    setTrackedSatId(null);
  }, []);

  const selectShip = useCallback((id: string) => {
    setSelectedAircraft(null);
    setFocus({ kind: "ship", id });
  }, []);
  const trackShip = useCallback((id: string) => {
    setSelectedAircraft(null);
    setTrackedHex(null);
    setTrackedSatId(null);
    setFocus({ kind: "ship", id });
    setTrackedShipId(id);
  }, []);
  const focusSat = useCallback((sat: SatPosition) => {
    setSelectedAircraft(null);
    setFocus({ kind: "satellite", id: sat.noradId });
  }, []);
  const trackSat = useCallback((sat: SatPosition) => {
    setSelectedAircraft(null);
    setTrackedHex(null);
    setTrackedShipId(null);
    userAddedRef.current.add(sat.noradId);
    userRemovedRef.current.delete(sat.noradId);
    setSelectedSatIds((prev) => new Set(prev).add(sat.noradId));
    setFocus({ kind: "satellite", id: sat.noradId });
    setTrackedSatId(sat.noradId);
  }, []);
  // V0_DEBUG_HOOK (temporary)
  (window as unknown as Record<string, unknown>).__wv = { trackShip, trackSat, setFocus, setTrackedHex, setSelectedAircraft, setViewMode, setSatIntelOn, satPosMap, ships, aircraft };

  const trackFocused = useCallback(() => {
    if (!focus) return;
    if (focus.kind === "aircraft") {
      setTrackedShipId(null);
      setTrackedSatId(null);
      // Exiting 3D clears the selection; without re-selecting, the "selection cleared"
      // effect would cancel this track immediately.
      const a = aircraftRef.current.find((x) => x.hex === focus.id);
      if (a) setSelectedAircraft(a);
      setTrackedHex(focus.id);
    } else if (focus.kind === "ship") {
      trackShip(focus.id);
    } else {
      const sat = satPosMap.get(focus.id);
      if (sat) trackSat(sat);
    }
  }, [focus, satPosMap, trackShip, trackSat]);

  const closePanel = useCallback(() => {
    clearTracking();
    setFocus(null);
    setSelectedAircraft(null);
  }, [clearTracking]);

  const isTracking = !!(trackedHex || trackedShipId || trackedSatId);
  useEffect(() => {
    if (!isTracking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearTracking();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isTracking, clearTracking]);

  const panelInfo: EntityInfo | null = (() => {
    if (!focus) return null;
    if (focus.kind === "aircraft") {
      const a = aircraft.find((x) => x.hex === focus.id) ?? selectedAircraft;
      if (!a) return null;
      return {
        kind: "aircraft",
        title: formatCallsign(a),
        color: accentColor,
        rows: [
          ["ICAO HEX", a.hex.toUpperCase()],
          ["TYPE", a.t || a.desc || "UNKNOWN"],
          ["ALTITUDE", formatAlt(a.alt_baro)],
          ["GROUND SPD", formatSpeed(a.gs)],
          ["HEADING", a.track !== undefined ? `${Math.round(a.track)}°` : "N/A"],
          ["SQUAWK", a.squawk || "—"],
          ["REG", a.r || "—"],
          ["POSITION", a.lat !== undefined && a.lon !== undefined ? `${a.lat.toFixed(3)}, ${a.lon.toFixed(3)}` : "N/A"],
        ],
      };
    }
    if (focus.kind === "ship") {
      const sh = ships.find((x) => String(x.mmsi) === focus.id);
      if (!sh) return null;
      const color = sh.category === "TANKER" ? "#ff3b30" : sh.category === "MILITARY" ? "#3a8dff" : sh.is_gap ? "#ff9500" : "#7df9ff";
      const rows: EntityInfo["rows"] = [
        ["MMSI", String(sh.mmsi)],
        ["CATEGORY", sh.category || "UNKNOWN"],
        ["SOURCE", sh.source || "—"],
        ["SPEED", sh.sog !== undefined ? `${Number(sh.sog).toFixed(1)} kn` : "N/A"],
        ["COURSE", sh.cog !== undefined ? `${Math.round(Number(sh.cog))}°` : "N/A"],
        ["POSITION", `${sh.lat.toFixed(3)}, ${sh.lon.toFixed(3)}`],
      ];
      if (sh.destination) rows.push(["DESTINATION", String(sh.destination)]);
      if (sh.status) rows.push(["STATUS", String(sh.status)]);
      if (sh.dwt) rows.push(["DWT", `${Number(sh.dwt).toLocaleString()} t`]);
      if (sh.est_barrels) rows.push(["EST. CARGO", `${Number(sh.est_barrels).toLocaleString()} bbl`]);
      if (sh.time_went_dark) rows.push(["WENT DARK", String(sh.time_went_dark)]);
      if (sh.last_updated) {
        const raw = sh.last_updated as number | string;
        const n = Number(raw);
        const date = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(raw));
        if (!Number.isNaN(date.getTime())) rows.push(["LAST UPDATE", date.toLocaleTimeString()]);
      }
      return { kind: "ship", title: sh.vessel_name || sh.ship_name || `MMSI ${sh.mmsi}`, color, rows };
    }
    const sat = satPosMap.get(focus.id);
    if (!sat) return null;
    return {
      kind: "satellite",
      title: sat.name,
      color: sat.color,
      rows: [
        ["ORIGIN", sat.origin],
        ["CLASS", sat.intelClass],
        ["NORAD ID", sat.noradId],
        ["ORBIT", sat.isGeo ? "GEOSTATIONARY" : sat.altKm > 5000 ? "MEO/HEO" : "LEO"],
        ["ALTITUDE", `${sat.altKm.toFixed(0)} km`],
        ["VELOCITY", `${sat.velocityKms.toFixed(2)} km/s`],
        ["SUB-POINT", `${sat.lat.toFixed(2)}, ${sat.lon.toFixed(2)}`],
      ],
    };
  })();
  const panelTracking = !!focus && (
    focus.kind === "aircraft" ? trackedHex === focus.id
    : focus.kind === "ship" ? trackedShipId === focus.id
    : trackedSatId === focus.id
  );

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden", background: "#020408", fontFamily: "'Share Tech Mono','Courier New',monospace", userSelect: "none" }}>

      <VisionFilters />

      {/* WORLD STACK — map, orbital canvas and Cesium 3D tiles share one vision filter */}
      <div style={{ position: "absolute", inset: 0, filter: visionCssFilter(visionMode, flirPalette) }}>

      {/* STARFIELD — shown in 3D mode behind the MapLibre canvas */}
      <StarField visible={viewMode === "3d"} />

      {/* GLOBE ATMOSPHERIC GLOW — subtle colored halo in 3D mode */}
      {viewMode === "3d" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 1,
            background: isMil
              ? "radial-gradient(ellipse 55% 55% at 50% 50%, transparent 38%, rgba(255,80,20,0.08) 60%, transparent 78%)"
              : "radial-gradient(ellipse 55% 55% at 50% 50%, transparent 38%, rgba(0,180,255,0.09) 60%, transparent 78%)",
            transition: "background 0.5s",
          }}
        />
      )}

      {/* MAP CANVAS — always mounted; projection switches between mercator and globe */}
      <div
        ref={mapContainer}
        style={{ position: "absolute", inset: 0, zIndex: 2 }}
      />

      {webglError && <WebGLFallback />}

      {/* MARITIME RADAR — sea-level circle overlays. Polled continuously and
          only made visible when the maritime panel is open, so the cyan dots
          on the globe match the toolbar's open/closed state. */}
      <ShipsLayer
        map={mapRef.current}
        mapLoaded={mapLoadedState}
        ships={ships}
        filters={shipFilters}
        visible={maritimePanelOpen && !playbackActive}
        onSelect={selectShip}
        onTrack={trackShip}
      />

      {/* CCTV — clustered public camera network (live feeds + OSM locations) */}
      <CctvLayer
        map={mapRef.current}
        mapLoaded={mapLoadedState}
        cameras={cctvCameras}
        osmCameras={cctvOsmCameras}
        enabledSources={cctvEnabled}
        visible={cctvPanelOpen && !playbackActive}
        selectedId={cctvSelected?.id ?? null}
        onSelect={selectCctvCamera}
      />

      {/* PLAYBACK RADAR & AIRCRAFT — dedicated MapLibre layer */}
      <PlaybackLayer
        map={mapRef.current}
        mapLoaded={mapLoadedState}
        active={playbackActive}
        mode={playbackMode}
        regionBounds={regionBounds}
        ships={playbackShips}
        planes={playbackPlanes}
        selectedEntity={selectedPlaybackEntity}
        trailPoints={playbackTrailPoints}
        onSelectEntity={handleSelectPlaybackEntity}
      />

      {/* SATELLITE INTEL — propagates TLEs and overlays satellites on the globe */}
      {viewMode === "3d" && satIntelOn && (
        <SatelliteLayer
          base={base}
          map={mapRef.current}
          mapLoaded={mapLoadedState}
          selectedNoradIds={selectedSatIds}
          onToggleSelect={(s) => toggleSatSelection(s)}
          onFocus={focusSat}
          onTrack={trackSat}
          onPositionsUpdated={handleSatPositions}
          theaterCenter={theaterActive ? theaterCenter : null}
          proximityRadiusKm={OVERWATCH_RADIUS_KM}
          hidden={!!trackedSatId}
        />
      )}

      {/* CINEMATIC CESIUM FOLLOW-CAM — photorealistic 3D over MapLibre */}
      <CinematicController
        trackedHex={trackedHex}
        trackedShipId={trackedShipId}
        trackedSatId={trackedSatId}
        aircraft={aircraft}
        ships={ships}
        satPosMap={satPosMap}
        base={base}
        military={mode === "military"}
        visionMode={visionMode}
      />

      </div>

      <VisionOverlay mode={visionMode} flirPalette={flirPalette} map={mapLoadedState ? mapRef.current : null} tracking={isTracking} />

      <VisionModeSelector
        mode={visionMode}
        onChange={setVisionMode}
        flirPalette={flirPalette}
        onFlirPaletteChange={setFlirPalette}
      />

      {panelInfo && (
        <EntityInfoPanel
          info={panelInfo}
          tracking={panelTracking}
          onTrack={trackFocused}
          onExit={clearTracking}
          onClose={closePanel}
        />
      )}


      {/* EXIT CINEMATIC BUTTON */}
      {trackedHex && (
        <button
          onClick={() => { setSelectedAircraft(null); setTrackedHex(null); }}
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            zIndex: 20,
            padding: "10px 18px",
            background: "rgba(2,4,8,0.85)",
            border: `1px solid ${accentColor}`,
            color: accentColor,
            fontFamily: "'Share Tech Mono','Courier New',monospace",
            fontSize: 12,
            letterSpacing: "0.3em",
            textTransform: "uppercase",
            cursor: "pointer",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            boxShadow: `0 0 20px ${accentColor}40, inset 0 0 12px ${accentColor}20`,
            transition: "all 0.15s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = `${accentColor}20`;
            e.currentTarget.style.boxShadow = `0 0 28px ${accentColor}80, inset 0 0 16px ${accentColor}40`;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(2,4,8,0.85)";
            e.currentTarget.style.boxShadow = `0 0 20px ${accentColor}40, inset 0 0 12px ${accentColor}20`;
          }}
        >
          ✕ EXIT
        </button>
      )}

      {/* SCAN-LINE GRID — only in 2D mode */}
      {viewMode === "2d" && !webglError && visionMode === "tactical" && (
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: "linear-gradient(rgba(0,255,255,0.012) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,255,0.012) 1px,transparent 1px)", backgroundSize: "60px 60px", zIndex: 3 }} />
      )}

      {/* VIGNETTE — only in 3D mode */}
      {viewMode === "3d" && (
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,5,0.65) 100%)", zIndex: 3 }} />
      )}

      {/* MASTER TOOLBAR — thin permanent left palette controlling every floating panel */}
      <MasterToolbar
        items={[
          {
            id: "aviation",
            label: "Aviation Intel",
            icon: AviationIcon,
            active: aviationPanelOpen,
            onClick: () => setAviationPanelOpen((o) => !o),
          },
          {
            id: "maritime",
            label: "Maritime Intel",
            icon: MaritimeIcon,
            active: maritimePanelOpen,
            onClick: () => setMaritimePanelOpen((o) => !o),
          },
          {
            id: "cctv",
            label: "CCTV Network",
            icon: CctvIcon,
            active: cctvPanelOpen,
            onClick: () => {
              setCctvEverOpened(true);
              setCctvPanelOpen((o) => !o);
            },
          },
          {
            id: "playback",
            label: "Tactical Playback (24h)",
            icon: PlaybackIcon,
            active: playbackOpen,
            onClick: () => {
              setPlaybackOpen((prev) => {
                const next = !prev;
                setPlaybackActive(next);
                return next;
              });
            },
          },
        ]}
      />

      {/* AVIATION INTEL — the original left HUD, now wrapped in a draggable window.
          Inner content is preserved verbatim so all existing data + logic still wire
          through. The outer chrome (background, border, shadow) is provided by the
          FloatingPanel; the inner styled wrapper drops its old chrome to avoid
          double-framing while keeping the flex layout the children depend on. */}
      {aviationPanelOpen && (
        <FloatingPanel
          title="AVIATION INTEL"
          initialX={54}
          initialY={14}
          width={300}
          panelRef={aviationPanelDOMRef}
          onClose={() => setAviationPanelOpen(false)}
        >
        <div style={{
          height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
        }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.6),transparent)", animation: "scan 4s linear infinite", zIndex: 2 }} />

          {/* HEADER */}
          <div style={{ padding: "14px 16px 10px", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#00ffff", boxShadow: "0 0 6px rgba(0,255,255,0.8)", animation: "pulse-glow 2s ease-in-out infinite" }} />
              <span style={{ fontSize: 13, letterSpacing: "0.35em", color: "#00ffff", textShadow: "0 0 8px rgba(0,255,255,0.5)", textTransform: "uppercase", fontWeight: 700 }}>WORLDVIEW</span>
              <span style={{ marginLeft: "auto", color: "rgba(0,255,255,0.5)", fontSize: 10, animation: "blink-anim 1.2s step-end infinite" }}>_</span>
            </div>
            <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase" }}>TACTICAL GEOSPATIAL INTEL SYS</div>
          </div>

          <Divider />

          {/* SCROLLABLE BODY — wraps every control section so the panel never
              clips when SELECTED TARGET (or other dynamic sections) push the
              total height past the viewport cap. The HEADER above and the
              status FOOTER below stay pinned. */}
          <div className="glow-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>

          {/* COUNTERS */}
          <div style={{ padding: "0 16px 10px", flexShrink: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div style={{ padding: 8, background: "rgba(0,255,255,0.03)", border: "1px solid rgba(0,255,255,0.1)", borderRadius: 2 }}>
                <div style={{ fontSize: 8, letterSpacing: "0.15em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase", marginBottom: 3 }}>CIVIL</div>
                <div style={{ color: CIV_COLOR, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>
                  {civCount > 0 ? civCount.toLocaleString() : (mode === "civil" && loading ? "…" : "—")}
                </div>
              </div>
              <div style={{ padding: 8, background: "rgba(255,107,53,0.03)", border: "1px solid rgba(255,107,53,0.1)", borderRadius: 2 }}>
                <div style={{ fontSize: 8, letterSpacing: "0.15em", color: "rgba(255,107,53,0.35)", textTransform: "uppercase", marginBottom: 3 }}>MILITARY</div>
                <div style={{ color: MIL_COLOR, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>
                  {milCount > 0 ? milCount.toLocaleString() : (mode === "military" && loading ? "…" : "—")}
                </div>
              </div>
            </div>
          </div>

          <Divider />

          {/* PROJECTION SYSTEM */}
          <div style={{ padding: "0 16px 10px", flexShrink: 0 }}>
            <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase", marginBottom: 6 }}>PROJECTION SYSTEM</div>
            <div style={{
              display: "flex", gap: 0, border: "1px solid rgba(0,255,255,0.2)", borderRadius: 3, overflow: "hidden",
              boxShadow: viewMode === "3d" ? "0 0 18px rgba(0,200,255,0.12)" : "none",
              transition: "box-shadow 0.4s",
            }}>
              {([
                { id: "2d" as ViewMode, label: "2D TACTICAL", icon: "⊞" },
                { id: "3d" as ViewMode, label: "3D ORBITAL", icon: "◉" },
              ] as { id: ViewMode; label: string; icon: string }[]).map((v, i) => (
                <button
                  key={v.id}
                  onClick={() => setViewMode(v.id)}
                  style={{
                    flex: 1, padding: "9px 4px", fontSize: 9, letterSpacing: "0.08em",
                    textTransform: "uppercase", border: "none", cursor: "pointer", transition: "all 0.25s",
                    borderLeft: i > 0 ? "1px solid rgba(0,255,255,0.2)" : "none",
                    background: viewMode === v.id
                      ? "linear-gradient(135deg, rgba(0,220,255,0.18), rgba(0,100,180,0.14))"
                      : "rgba(0,255,255,0.02)",
                    color: viewMode === v.id ? "#00e5ff" : "rgba(0,255,255,0.28)",
                    fontFamily: "'Share Tech Mono','Courier New',monospace",
                    textShadow: viewMode === v.id ? "0 0 8px rgba(0,220,255,0.7)" : "none",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                  }}
                >
                  <span style={{ fontSize: 11 }}>{v.icon}</span>
                  {v.label}
                </button>
              ))}
            </div>
            {viewMode === "3d" && (
              <div style={{
                marginTop: 6, padding: "5px 8px", fontSize: 8, letterSpacing: "0.1em",
                color: "rgba(0,200,255,0.45)", background: "rgba(0,200,255,0.04)",
                border: "1px solid rgba(0,200,255,0.12)", borderRadius: 2,
                lineHeight: 1.6,
              }}>
                ORBITAL VIEW ACTIVE · LIVE DATA MAINTAINED
              </div>
            )}

            {/* SATELLITE INTEL — only meaningful in 3D orbital view */}
            {viewMode === "3d" && (
              <button
                onClick={() => {
                  setSatIntelOn((v) => !v);
                  if (satIntelOn) {
                    setSelectedSatIds(new Set());
                    userAddedRef.current = new Set();
                    userRemovedRef.current = new Set();
                  }
                }}
                style={{
                  marginTop: 8, width: "100%", padding: "8px 6px", fontSize: 9,
                  letterSpacing: "0.12em", textTransform: "uppercase",
                  border: "1px solid",
                  borderColor: satIntelOn ? "rgba(125,249,255,0.55)" : "rgba(0,255,255,0.18)",
                  borderRadius: 2, cursor: "pointer", transition: "all 0.2s",
                  background: satIntelOn
                    ? "linear-gradient(135deg, rgba(125,249,255,0.16), rgba(120,180,255,0.08))"
                    : "rgba(0,255,255,0.02)",
                  color: satIntelOn ? "#7df9ff" : "rgba(0,255,255,0.4)",
                  fontFamily: "'Share Tech Mono','Courier New',monospace",
                  boxShadow: satIntelOn ? "0 0 14px rgba(125,249,255,0.18)" : "none",
                }}
              >
                ◈ SATELLITE INTEL {satIntelOn ? "· LIVE" : "· OFF"}
              </button>
            )}
            {viewMode === "3d" && satIntelOn && (
              <div style={{
                marginTop: 6, fontSize: 8, letterSpacing: "0.06em", lineHeight: 1.6,
                color: "rgba(0,255,255,0.45)",
              }}>
                <span style={{ color: "#ff5b2e" }}>■ MIL/INTEL</span>{" "}
                <span style={{ color: "#ff5b2e", opacity: 0.5, marginLeft: 6 }}>■ LEO SWARM</span>{" "}
                <span style={{ color: "#7fb6c4", marginLeft: 6 }}>■ UNCLASSIFIED</span>
              </div>
            )}

            {/* VISIBILITY — what to render on the globe */}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase", marginBottom: 6 }}>VISIBILITY</div>
              <div style={{ display: "flex", border: "1px solid rgba(0,255,255,0.2)", borderRadius: 3, overflow: "hidden" }}>
                {([
                  { id: "flights" as const,    label: "FLIGHTS" },
                  { id: "satellites" as const, label: "SATS" },
                  { id: "both" as const,       label: "BOTH" },
                ]).map((v, i) => (
                  <button
                    key={v.id}
                    onClick={() => setVisibility(v.id)}
                    style={{
                      flex: 1, padding: "7px 4px", fontSize: 9, letterSpacing: "0.08em",
                      textTransform: "uppercase", border: "none", cursor: "pointer", transition: "all 0.2s",
                      borderLeft: i > 0 ? "1px solid rgba(0,255,255,0.2)" : "none",
                      background: visibility === v.id
                        ? "linear-gradient(135deg, rgba(0,220,255,0.18), rgba(0,100,180,0.14))"
                        : "rgba(0,255,255,0.02)",
                      color: visibility === v.id ? "#00e5ff" : "rgba(0,255,255,0.32)",
                      fontFamily: "'Share Tech Mono','Courier New',monospace",
                      textShadow: visibility === v.id ? "0 0 8px rgba(0,220,255,0.6)" : "none",
                    }}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Divider />

          {/* THEATER OF OPERATIONS */}
          <div style={{ padding: "0 16px 10px", flexShrink: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(255,215,0,0.55)", textTransform: "uppercase" }}>
                ◆ THEATER OF OPERATIONS
              </div>
              {theaterLoading && (
                <div style={{ width: 5, height: 5, borderRadius: "50%", background: THEATER_COLOR, boxShadow: `0 0 6px ${THEATER_COLOR}`, animation: "pulse-glow 1.2s ease-in-out infinite" }} />
              )}
            </div>
            {/* Free-text global search replaces the hardcoded dropdown */}
            <div style={{ position: "relative" }}>
              <div style={{
                display: "flex",
                alignItems: "center",
                border: `1px solid ${theaterActive ? "rgba(255,215,0,0.6)" : "rgba(255,215,0,0.25)"}`,
                borderRadius: theaterDropdownOpen ? "2px 2px 0 0" : 2,
                background: theaterActive ? "rgba(255,215,0,0.07)" : "rgba(255,215,0,0.02)",
                boxShadow: theaterActive ? `0 0 14px rgba(255,215,0,0.18), inset 0 0 10px rgba(255,215,0,0.06)` : "none",
                transition: "all 0.25s",
              }}>
                <input
                  type="text"
                  value={theaterSearch}
                  onChange={(e) => {
                    setTheaterSearch(e.target.value);
                    if (theaterActive) {
                      setTheaterActive(false);
                      const src = mapRef.current?.getSource("theater-region") as maplibregl.GeoJSONSource | undefined;
                      if (src) src.setData({ type: "FeatureCollection", features: [] });
                    }
                  }}
                  onFocus={() => { if (theaterResults.length > 0) setTheaterDropdownOpen(true); }}
                  onBlur={() => setTimeout(() => setTheaterDropdownOpen(false), 150)}
                  placeholder="GLOBAL SEARCH..."
                  style={{
                    flex: 1,
                    padding: "8px 6px 8px 10px",
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: theaterActive ? THEATER_COLOR : "rgba(255,215,0,0.6)",
                    fontFamily: "'Share Tech Mono','Courier New',monospace",
                    fontSize: 10,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    textShadow: theaterActive ? `0 0 6px ${THEATER_COLOR}80` : "none",
                  }}
                />
                {(theaterSearch.length > 0 || theaterActive) && (
                  <button
                    onMouseDown={(e) => { e.preventDefault(); handleTheaterClear(); }}
                    style={{
                      padding: "0 10px",
                      background: "none",
                      border: "none",
                      borderLeft: "1px solid rgba(255,215,0,0.2)",
                      cursor: "pointer",
                      color: "rgba(255,215,0,0.5)",
                      fontFamily: "'Share Tech Mono','Courier New',monospace",
                      fontSize: 9,
                      letterSpacing: "0.12em",
                      height: "100%",
                      alignSelf: "stretch",
                      display: "flex",
                      alignItems: "center",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = THEATER_COLOR; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(255,215,0,0.5)"; }}
                  >CLR</button>
                )}
              </div>
              {/* Autocomplete dropdown */}
              {theaterDropdownOpen && theaterResults.length > 0 && (
                <div style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  zIndex: 50,
                  background: "rgba(2,4,8,0.97)",
                  border: `1px solid rgba(255,215,0,0.4)`,
                  borderTop: "none",
                  borderRadius: "0 0 2px 2px",
                  backdropFilter: "blur(12px)",
                  maxHeight: 220,
                  overflowY: "auto",
                }}>
                  {theaterResults.map((hit, i) => (
                    <button
                      key={i}
                      onMouseDown={(e) => { e.preventDefault(); handleTheaterSelect(hit); }}
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "8px 10px",
                        background: "transparent",
                        border: "none",
                        borderBottom: i < theaterResults.length - 1 ? "1px solid rgba(255,215,0,0.1)" : "none",
                        cursor: "pointer",
                        color: "rgba(255,215,0,0.75)",
                        fontFamily: "'Share Tech Mono','Courier New',monospace",
                        fontSize: 9,
                        letterSpacing: "0.07em",
                        textAlign: "left",
                        textTransform: "uppercase",
                        lineHeight: 1.4,
                        transition: "background 0.12s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,215,0,0.08)"; e.currentTarget.style.color = THEATER_COLOR; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,215,0,0.75)"; }}
                    >
                      {hit.display_name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {theaterError && (
              <div style={{ marginTop: 6, fontSize: 8, letterSpacing: "0.1em", color: "rgba(255,100,100,0.7)" }}>
                ⚠ {theaterError}
              </div>
            )}
            {theaterActive && !theaterError && (
              <div style={{ marginTop: 6, fontSize: 8, letterSpacing: "0.1em", color: "rgba(255,215,0,0.5)", lineHeight: 1.5 }}>
                CINEMATIC TILT · PITCH 75° · CLICK A SAT FOR SENSOR FOOTPRINT
              </div>
            )}
          </div>

          <Divider />

          {/* DATA FEED */}
          <div style={{ padding: "0 16px 10px", flexShrink: 0 }}>
            <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase", marginBottom: 6 }}>DATA FEED</div>
            <div style={{ display: "flex", gap: 6 }}>
              {(["civil", "military"] as FilterMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    flex: 1, padding: "7px 4px", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", border: "1px solid", borderRadius: 2, cursor: "pointer", transition: "all 0.2s",
                    background: mode === m ? (m === "military" ? "rgba(255,107,53,0.12)" : "rgba(0,255,255,0.1)") : "transparent",
                    borderColor: mode === m ? (m === "military" ? "rgba(255,107,53,0.6)" : "rgba(0,255,255,0.5)") : "rgba(0,255,255,0.15)",
                    color: mode === m ? (m === "military" ? MIL_COLOR : CIV_COLOR) : "rgba(0,255,255,0.3)",
                    boxShadow: mode === m ? `0 0 10px ${m === "military" ? "rgba(255,107,53,0.12)" : "rgba(0,255,255,0.12)"}` : "none",
                    fontFamily: "'Share Tech Mono','Courier New',monospace",
                  }}
                >
                  {m === "civil" ? "PUBLIC" : "MILITARY"}
                </button>
              ))}
            </div>
          </div>

          <Divider />

          {/* AREA FILTER */}
          <div style={{ padding: "0 16px 10px", flexShrink: 0 }}>
            <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase", marginBottom: 6 }}>AREA FILTER</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              {(["global", "local"] as AreaMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setAreaMode(m)}
                  style={{
                    flex: 1, padding: "6px 4px", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", border: "1px solid", borderRadius: 2, cursor: "pointer", transition: "all 0.2s",
                    background: areaMode === m ? "rgba(0,255,255,0.08)" : "transparent",
                    borderColor: areaMode === m ? "rgba(0,255,255,0.45)" : "rgba(0,255,255,0.12)",
                    color: areaMode === m ? CIV_COLOR : "rgba(0,255,255,0.3)",
                    fontFamily: "'Share Tech Mono','Courier New',monospace",
                  }}
                >
                  {m === "global" ? "GLOBAL" : "LOCAL AREA"}
                </button>
              ))}
            </div>

            {areaMode === "local" && (
              <div>
                <div style={{ fontSize: 8, letterSpacing: "0.12em", color: "rgba(0,255,255,0.3)", marginBottom: 5 }}>
                  {viewMode === "2d" ? "RADIUS FROM MAP CENTER" : "RADIUS FROM GLOBE CENTER"}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {RADIUS_OPTIONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setRadius(r)}
                      style={{
                        padding: "4px 6px", fontSize: 9, letterSpacing: "0.05em", border: "1px solid", borderRadius: 2, cursor: "pointer",
                        background: radius === r ? "rgba(0,255,255,0.1)" : "transparent",
                        borderColor: radius === r ? "rgba(0,255,255,0.5)" : "rgba(0,255,255,0.1)",
                        color: radius === r ? CIV_COLOR : "rgba(0,255,255,0.3)",
                        fontFamily: "'Share Tech Mono','Courier New',monospace",
                      }}
                    >
                      {r >= 1000 ? `${r / 1000}K` : r} NM
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Divider />

          {/* SATELLITE INTEL — single-target detail only. Multi-target overwatch
              renders as a separate floating panel on the right (see below) so
              the left HUD doesn't overflow when many assets are auto-acquired. */}
          {satIntelOn && viewMode === "3d" && selectedSatIds.size === 1 && (
            <>
              <SatIntelDetail
                selectedSatIds={selectedSatIds}
                satPosMap={satPosMap}
                onClear={() => {
                  for (const id of selectedSatIds) userRemovedRef.current.add(id);
                  userAddedRef.current = new Set();
                  setSelectedSatIds(new Set());
                }}
              />
              <Divider />
            </>
          )}

          {/* SELECTED TARGET */}
          {selectedAircraft && (
            <>
              <div style={{ padding: "0 16px 10px", flexShrink: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase" }}>SELECTED TARGET</div>
                  <button onClick={() => setSelectedAircraft(null)} style={{ fontSize: 8, letterSpacing: "0.1em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase", background: "none", border: "none", cursor: "pointer", fontFamily: "'Share Tech Mono','Courier New',monospace" }}>[CLR]</button>
                </div>
                <div style={{
                  padding: 10, borderRadius: 2,
                  background: isMil ? "rgba(255,107,53,0.05)" : "rgba(0,255,255,0.04)",
                  border: `1px solid ${isMil ? "rgba(255,107,53,0.25)" : "rgba(0,255,255,0.2)"}`,
                }}>
                  <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.15em", color: accentColor, textShadow: `0 0 10px ${accentColor}`, marginBottom: 8, textTransform: "uppercase" }}>
                    {formatCallsign(selectedAircraft)}
                  </div>
                  <StatRow label="ICAO HEX" value={selectedAircraft.hex.toUpperCase()} accent />
                  <StatRow label="TYPE" value={selectedAircraft.t || selectedAircraft.desc || "UNKNOWN"} />
                  <StatRow label="ALTITUDE" value={formatAlt(selectedAircraft.alt_baro)} accent />
                  <StatRow label="GROUND SPD" value={formatSpeed(selectedAircraft.gs)} />
                  <StatRow label="HEADING" value={selectedAircraft.track !== undefined ? `${Math.round(selectedAircraft.track)}°` : "N/A"} />
                  <StatRow label="SQUAWK" value={selectedAircraft.squawk || "—"} />
                  {selectedAircraft.r && <StatRow label="REG" value={selectedAircraft.r} />}
                  <StatRow label="POSITION" value={selectedAircraft.lat !== undefined ? `${selectedAircraft.lat.toFixed(3)}, ${selectedAircraft.lon!.toFixed(3)}` : "N/A"} accent />
                </div>
              </div>
              <Divider />
            </>
          )}

          {/* CONTACTS LIST — when docked, renders inline. When detached, this
              block is hidden and the same content renders in a separate
              FloatingPanel (see below). */}
          {contactsDocked && (
            <>
              <div style={{ padding: "0 16px 6px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <div style={{ fontSize: 8, letterSpacing: "0.18em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase" }}>CONTACTS</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ fontSize: 8, color: "rgba(0,255,255,0.25)" }}>{displayedAircraft.length} / {aircraft.length}</div>
                  <button
                    type="button"
                    title="Detach into floating window"
                    onClick={() => setContactsDocked(false)}
                    style={{
                      background: "transparent", border: "1px solid rgba(0,255,255,0.25)",
                      color: "rgba(0,255,255,0.7)", cursor: "pointer",
                      width: 18, height: 16, padding: 0, borderRadius: 2,
                      fontSize: 9, lineHeight: 1, display: "inline-flex",
                      alignItems: "center", justifyContent: "center",
                      fontFamily: "'Share Tech Mono','Courier New',monospace",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,255,255,0.12)"; e.currentTarget.style.color = "#7df9ff"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(0,255,255,0.7)"; }}
                  >⤢</button>
                </div>
              </div>

              {error && (
                <div style={{ margin: "0 16px 8px", padding: "5px 8px", background: "rgba(255,50,50,0.07)", border: "1px solid rgba(255,50,50,0.2)", borderRadius: 2, fontSize: 9, color: "rgba(255,100,100,0.7)", letterSpacing: "0.1em" }}>
                  ⚠ {error}
                </div>
              )}

              {/* No internal overflow:auto here — the surrounding scroll
                  wrapper handles overflow for the whole panel body, and we
                  don't want nested scrollbars. */}
              <div style={{ padding: "0 16px 8px", display: "flex", flexDirection: "column", gap: 3 }}>
                {displayedAircraft.map((a) => {
                  const isSelected = selectedAircraft?.hex === a.hex;
                  return (
                    <div
                      key={a.hex}
                      onClick={() => handleSelectAircraft(a)}
                      style={{
                        padding: "7px 9px", borderRadius: 2, cursor: "pointer", transition: "all 0.15s",
                        background: isSelected ? (isMil ? "rgba(255,107,53,0.08)" : "rgba(0,255,255,0.07)") : "rgba(0,255,255,0.015)",
                        border: `1px solid ${isSelected ? (isMil ? "rgba(255,107,53,0.4)" : "rgba(0,255,255,0.4)") : "rgba(0,255,255,0.07)"}`,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <AircraftSVG isMil={isMil} size={9} />
                          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", color: accentColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {formatCallsign(a)}
                          </span>
                        </div>
                        {a.alt_baro !== undefined && (
                          <span style={{ fontSize: 8, color: "rgba(0,255,255,0.35)", flexShrink: 0 }}>{formatAlt(a.alt_baro)}</span>
                        )}
                      </div>
                      {a.t && <div style={{ fontSize: 8, color: "rgba(0,255,255,0.25)", marginTop: 2 }}>{a.t}</div>}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* When detached, leave a small breadcrumb so the user can find it */}
          {!contactsDocked && (
            <div style={{ padding: "0 16px 8px", flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setContactsDocked(true)}
                style={{
                  width: "100%", padding: "8px 10px", fontSize: 9, letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  background: "rgba(0,255,255,0.04)",
                  border: "1px dashed rgba(0,255,255,0.35)",
                  color: "rgba(0,255,255,0.7)",
                  borderRadius: 2, cursor: "pointer",
                  fontFamily: "'Share Tech Mono','Courier New',monospace",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,255,255,0.1)"; e.currentTarget.style.color = "#7df9ff"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(0,255,255,0.04)"; e.currentTarget.style.color = "rgba(0,255,255,0.7)"; }}
              >⇲ DOCK CONTACTS</button>
            </div>
          )}

          </div>
          {/* /SCROLLABLE BODY */}

          <div style={{ height: 1, background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.2),transparent)", margin: "0 16px" }} />
          <div style={{ padding: "6px 16px", flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 8, color: "rgba(0,255,255,0.3)", letterSpacing: "0.08em" }}>
              {lastUpdate ? `UPD ${lastUpdate.toLocaleTimeString()}` : "INIT"}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {loading && <div style={{ width: 5, height: 5, borderRadius: "50%", background: "rgba(0,255,255,0.8)", boxShadow: "0 0 4px rgba(0,255,255,0.8)", animation: "pulse-glow 2s ease-in-out infinite" }} />}
              <div style={{ fontSize: 8, color: "rgba(0,255,255,0.3)", letterSpacing: "0.1em" }}>ADS-B LIVE</div>
            </div>
          </div>
        </div>
        </FloatingPanel>
      )}

      {/* MARITIME INTEL — floating panel: filters, live metrics, regional analytics */}
      {maritimePanelOpen && (
        <MaritimePanel
          ships={ships}
          filters={shipFilters}
          onFiltersChange={setShipFilters}
          loading={shipsLoading}
          error={shipsError}
          lastUpdate={shipsLastUpdate}
          onClose={() => setMaritimePanelOpen(false)}
        />
      )}

      {/* TACTICAL PLAYBACK — floating controls panel */}
      {playbackOpen && (
        <PlaybackPanel
          active={playbackActive}
          mode={playbackMode}
          onModeChange={(nextMode) => {
            setPlaybackMode(nextMode);
            setIsPlaying(false);
          }}
          frames={playbackFrames}
          currentFrameIndex={currentFrameIndex}
          onSeekFrame={(idx) => setCurrentFrameIndex(idx)}
          isPlaying={isPlaying}
          onTogglePlay={() => setIsPlaying((p) => !p)}
          speed={playbackSpeed}
          onSpeedChange={setPlaybackSpeed}
          loading={playbackLoading}
          loadingFrame={playbackFrameLoading}
          selectedEntity={selectedPlaybackEntity}
          trailLoading={playbackTrailLoading}
          onClearTrail={() => {
            setSelectedPlaybackEntity(null);
            setPlaybackTrailPoints([]);
          }}
          onExitPlayback={exitPlayback}
          onClose={exitPlayback}
        />
      )}

      {/* DETACHED CONTACTS PANEL — appears when the user pops contacts out of
          Aviation Intel. Has its own header (drag/minimize/close) plus a custom
          DOCK button. Releasing a drag near the right edge of the Aviation
          Intel panel auto-snaps it back to its docked position. */}
      {aviationPanelOpen && !contactsDocked && (
        <FloatingPanel
          title="CONTACTS"
          initialX={368}
          initialY={14}
          width={260}
          maxHeight="calc(100vh - 28px)"
          onClose={() => setContactsDocked(true)}
          extraHeaderButtons={
            <button
              type="button"
              title="Dock back into Aviation Intel"
              onClick={() => setContactsDocked(true)}
              style={{
                background: "transparent", border: "1px solid rgba(0,255,255,0.3)",
                color: "rgba(0,255,255,0.75)", cursor: "pointer",
                width: 38, height: 18, padding: 0, borderRadius: 2,
                fontSize: 8, lineHeight: 1, letterSpacing: "0.12em",
                fontFamily: "'Share Tech Mono','Courier New',monospace",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,255,255,0.12)"; e.currentTarget.style.color = "#7df9ff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(0,255,255,0.75)"; }}
            >⇲ DOCK</button>
          }
          onDragEnd={(p) => {
            // Magnetic snap: if released near the right edge of Aviation Intel,
            // pop back into the docked position. The snap zone is a vertical
            // band ~120px wide just outside the parent panel's right edge.
            const rect = aviationPanelDOMRef.current?.getBoundingClientRect();
            if (!rect) return;
            const dx = p.x - (rect.right + 8);   // 8px target gap
            const verticallyOverlaps = p.y < rect.bottom + 60 && p.y > rect.top - 60;
            if (Math.abs(dx) < 120 && verticallyOverlaps) {
              setContactsDocked(true);
            }
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <div style={{ padding: "8px 14px 6px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 8, letterSpacing: "0.18em", color: "rgba(0,255,255,0.4)", textTransform: "uppercase" }}>AVIATION FEED</div>
              <div style={{ fontSize: 8, color: "rgba(0,255,255,0.3)" }}>{displayedAircraft.length} / {aircraft.length}</div>
            </div>
            {error && (
              <div style={{ margin: "0 14px 8px", padding: "5px 8px", background: "rgba(255,50,50,0.07)", border: "1px solid rgba(255,50,50,0.2)", borderRadius: 2, fontSize: 9, color: "rgba(255,100,100,0.7)", letterSpacing: "0.1em" }}>
                ⚠ {error}
              </div>
            )}
            <div className="glow-scroll" style={{ flex: 1, overflowY: "auto", padding: "0 14px 10px", display: "flex", flexDirection: "column", gap: 3, minHeight: 0 }}>
              {displayedAircraft.map((a) => {
                const isSelected = selectedAircraft?.hex === a.hex;
                return (
                  <div
                    key={a.hex}
                    onClick={() => handleSelectAircraft(a)}
                    style={{
                      padding: "7px 9px", borderRadius: 2, cursor: "pointer", transition: "all 0.15s",
                      background: isSelected ? (isMil ? "rgba(255,107,53,0.08)" : "rgba(0,255,255,0.07)") : "rgba(0,255,255,0.015)",
                      border: `1px solid ${isSelected ? (isMil ? "rgba(255,107,53,0.4)" : "rgba(0,255,255,0.4)") : "rgba(0,255,255,0.07)"}`,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <AircraftSVG isMil={isMil} size={9} />
                        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", color: accentColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {formatCallsign(a)}
                        </span>
                      </div>
                      {a.alt_baro !== undefined && (
                        <span style={{ fontSize: 8, color: "rgba(0,255,255,0.35)", flexShrink: 0 }}>{formatAlt(a.alt_baro)}</span>
                      )}
                    </div>
                    {a.t && <div style={{ fontSize: 8, color: "rgba(0,255,255,0.25)", marginTop: 2 }}>{a.t}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </FloatingPanel>
      )}

      {/* CCTV INTEL — source toggles, search, and the live feed window */}
      {cctvPanelOpen && (
        <FloatingPanel
          title="CCTV NETWORK"
          initialX={54}
          initialY={14}
          width={300}
          onClose={() => setCctvPanelOpen(false)}
        >
          <CctvPanel
            sources={cctvSources}
            cameras={cctvCameras}
            loading={cctvLoading}
            error={cctvError}
            enabledSources={cctvEnabled}
            onToggleSource={toggleCctvSource}
            osmStatus={cctvOsmStatus}
            osmCount={cctvOsmCameras.length}
            onSelect={selectCctvCamera}
          />
        </FloatingPanel>
      )}
      {cctvPanelOpen && cctvSelected && (
        <FloatingPanel
          key={cctvSelected.id}
          title={`CCTV FEED · ${cctvSelected.source.toUpperCase()}`}
          initialX={Math.max(60, (typeof window !== "undefined" ? window.innerWidth : 1200) - 420)}
          initialY={14}
          width={400}
          onClose={() => setCctvSelected(null)}
        >
          <div style={{ padding: 10 }}>
            <CctvViewer camera={cctvSelected} />
          </div>
        </FloatingPanel>
      )}

      {/* FLOATING OVERWATCH LIST — multi-target sat selection (3D + SAT INTEL) */}
      {satIntelOn && viewMode === "3d" && (
        <OverwatchListPanel
          selectedSatIds={selectedSatIds}
          satPosMap={satPosMap}
          theaterActive={theaterActive}
          theaterName={theaterName}
          onClearAll={() => {
            for (const id of selectedSatIds) userRemovedRef.current.add(id);
            userAddedRef.current = new Set();
            setSelectedSatIds(new Set());
          }}
          onRemoveOne={(id) => {
            setSelectedSatIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
            userRemovedRef.current.add(id);
            userAddedRef.current.delete(id);
          }}
        />
      )}

      {/* TOP-RIGHT LEGEND / FEED INFO — only in 2D */}
      {viewMode === "2d" && aviationPanelOpen && (
        <div style={{ position: "absolute", top: 14, right: 14, zIndex: 10, display: "flex", flexDirection: "column", gap: 8, width: 165 }}>
          <div style={{ padding: 10, background: "rgba(2,4,8,0.88)", backdropFilter: "blur(20px)", border: "1px solid rgba(0,255,255,0.14)", borderRadius: 2 }}>
            <div style={{ fontSize: 8, letterSpacing: "0.2em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase", marginBottom: 7 }}>MAP LEGEND</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <AircraftSVG isMil={false} size={9} />
              <span style={{ fontSize: 8, letterSpacing: "0.1em", color: CIV_COLOR }}>PUBLIC AVIATION</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AircraftSVG isMil={true} size={9} />
              <span style={{ fontSize: 8, letterSpacing: "0.1em", color: MIL_COLOR }}>MILITARY ASSET</span>
            </div>
          </div>

          <div style={{ padding: 10, background: "rgba(2,4,8,0.88)", backdropFilter: "blur(20px)", border: "1px solid rgba(0,255,255,0.14)", borderRadius: 2 }}>
            <div style={{ fontSize: 8, letterSpacing: "0.18em", color: "rgba(0,255,255,0.35)", textTransform: "uppercase", marginBottom: 3 }}>FEED SOURCE</div>
            <div style={{ fontSize: 9, color: "rgba(0,255,255,0.65)", letterSpacing: "0.08em" }}>ADSB.LOL</div>
            <div style={{ height: 2, background: "rgba(0,255,255,0.1)", borderRadius: 1, margin: "7px 0 4px", overflow: "hidden" }}>
              <div style={{ height: "100%", background: "linear-gradient(90deg,rgba(0,255,255,0.6),rgba(0,255,255,1))", borderRadius: 1, width: loading ? "30%" : "100%", transition: "width 0.8s ease" }} />
            </div>
            <div style={{ fontSize: 8, color: "rgba(0,255,255,0.25)", letterSpacing: "0.05em" }}>REFRESH 3s</div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes scan { 0% { top:0; opacity:1; } 100% { top:100%; opacity:0.15; } }
        @keyframes pulse-glow { 0%,100% { opacity:1; } 50% { opacity:0.35; } }
        @keyframes blink-anim { 0%,100% { opacity:1; } 50% { opacity:0; } }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: rgba(0,255,255,0.03); }
        ::-webkit-scrollbar-thumb { background: rgba(0,255,255,0.2); border-radius: 2px; }

        /* Glowing cyan scrollbar — applied to .glow-scroll containers
           (contacts list, overwatch list). Webkit + Firefox variants. */
        .glow-scroll::-webkit-scrollbar { width: 6px; }
        .glow-scroll::-webkit-scrollbar-track {
          background: rgba(0,255,255,0.05);
          border-left: 1px solid rgba(0,255,255,0.08);
        }
        .glow-scroll::-webkit-scrollbar-thumb {
          background: linear-gradient(180deg, rgba(0,255,255,0.65), rgba(0,255,255,0.35));
          border-radius: 3px;
          box-shadow: 0 0 6px rgba(0,255,255,0.55), inset 0 0 4px rgba(255,255,255,0.18);
        }
        .glow-scroll::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(180deg, rgba(125,249,255,0.95), rgba(0,255,255,0.55));
          box-shadow: 0 0 10px rgba(0,255,255,0.95), inset 0 0 4px rgba(255,255,255,0.3);
        }
        .glow-scroll { scrollbar-width: thin; scrollbar-color: rgba(0,255,255,0.55) rgba(0,255,255,0.05); }
        .maplibregl-ctrl-attrib { background: rgba(0,0,0,0.7) !important; color: rgba(0,255,255,0.4) !important; font-size: 9px !important; }
        .maplibregl-ctrl-attrib a { color: rgba(0,255,255,0.4) !important; }
        .maplibregl-ctrl-group { background: rgba(2,4,8,0.9) !important; border: 1px solid rgba(0,255,255,0.18) !important; border-radius: 2px !important; }
        .maplibregl-ctrl-group button { color: rgba(0,255,255,0.6) !important; }
        .maplibregl-ctrl-group button:hover { background: rgba(0,255,255,0.08) !important; }
      `}</style>
    </div>
  );
}
