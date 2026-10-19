import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import * as satellite from "satellite.js";

// ──────────────────────────────────────────────────────────────────────────────
// OSINT classification — maps a satellite's catalog NAME to its operating
// origin and intel class. The first matching rule wins, so order matters
// (LEO swarms must be checked first to suppress noise from huge constellations).
// All matched mil/intel assets render in the standard tactical red/orange,
// except LEO swarms which are intentionally dimmed to reduce visual noise.
// ──────────────────────────────────────────────────────────────────────────────

export type IntelOrigin =
  | "USA" | "RUSSIA" | "CHINA" | "INDIA" | "NORTH KOREA"
  | "UK" | "FRANCE" | "GERMANY" | "ITALY" | "SPAIN"
  | "ISRAEL" | "JAPAN"
  | "UNKNOWN/COALITION";

export interface IntelTags {
  origin: IntelOrigin;
  intelClass: string;
  color: string;     // render color
  opacity: number;   // render opacity (0..1)
  isSwarm: boolean;  // dimmed swarm asset
}

// Standard tactical colors
const C_RED  = "#ff5b2e"; // mil / intel
const C_DIM  = "#ff5b2e"; // swarm — same hue, opacity reduced
const C_NEUT = "#7fb6c4"; // unclassified / coalition (muted teal)

interface ClassifierRule {
  patterns: string[];        // case-insensitive substring matches
  origin: IntelOrigin;
  intelClass: string;
  color?: string;
  opacity?: number;
  isSwarm?: boolean;
}

// Rules are evaluated top-to-bottom; FIRST match wins.
const CLASSIFIER: ClassifierRule[] = [
  // ── SWARM / NOISE REDUCTION (must be first) ────────────────────────────────
  {
    patterns: ["SDA", "PRAETORIAN", "STARLINK"],
    origin: "USA", intelClass: "LEO SWARM",
    color: C_DIM, opacity: 0.5, isSwarm: true,
  },

  // ── RUSSIA ─────────────────────────────────────────────────────────────────
  {
    patterns: ["COSMOS", "KOSMOS", "LOUCH", "PION", "GLONASS", "PARUS",
               "STRELA", "MERIDIAN", "RADUGA", "GORIZONT", "EKSRAN", "BLITS"],
    origin: "RUSSIA", intelClass: "MILITARY/INTEL",
  },

  // ── CHINA ──────────────────────────────────────────────────────────────────
  {
    patterns: ["YAOGAN", "JIANBING", "GAOFEN", "SHIYAN", "BEIDOU",
               "COMPASS", "TIANLIAN", "CHUANGXIN", "QIANXING"],
    origin: "CHINA", intelClass: "RECON/MILITARY",
  },

  // ── UNITED STATES (Heavy Assets) ───────────────────────────────────────────
  {
    patterns: ["USA ", "NROL", "FIA-RADAR", "LACROSSE", "KEYHOLE", "KH-",
               "WGS", "AEHF", "MILSTAR", "GPS", "NAVSTAR", "MUOS",
               "SBIRS", "DSP", "GSSAP", "TRUMPET", "MENTOR"],
    origin: "USA", intelClass: "HEAVY INTEL/COMMS",
  },

  // ── INDIA ──────────────────────────────────────────────────────────────────
  {
    patterns: ["RISAT", "EMISAT", "CARTOSAT", "GSAT-7", "MICROSAT-R"],
    origin: "INDIA", intelClass: "MILITARY/RECON",
  },

  // ── NORTH KOREA ────────────────────────────────────────────────────────────
  {
    patterns: ["MALLIGYONG", "KWANGMYONGSONG"],
    origin: "NORTH KOREA", intelClass: "MILITARY",
  },

  // ── EUROPEAN ALLIES ────────────────────────────────────────────────────────
  { patterns: ["SKYNET"],
    origin: "UK", intelClass: "STRATCOM" },

  { patterns: ["SYRACUSE", "HELIOS", "CSO", "CERES", "PLEIADES"],
    origin: "FRANCE", intelClass: "MIL/RECON" },

  { patterns: ["SAR-LUPE", "SARAH"],
    origin: "GERMANY", intelClass: "RADAR INTEL" },

  { patterns: ["COSMO-SKYMED", "SICRAL"],
    origin: "ITALY", intelClass: "DUAL-USE/MIL" },

  { patterns: ["PAZ", "SPAINSAT"],
    origin: "SPAIN", intelClass: "DUAL-USE/MIL" },

  // ── MIDDLE EAST / ASIA ─────────────────────────────────────────────────────
  { patterns: ["OFEQ", "TECSAR"],
    origin: "ISRAEL", intelClass: "RECON" },

  { patterns: ["IGS "],
    origin: "JAPAN", intelClass: "INFO GATHERING" },
];

function classify(name: string): IntelTags {
  const upper = name.toUpperCase();
  for (const rule of CLASSIFIER) {
    for (const p of rule.patterns) {
      if (upper.includes(p.toUpperCase())) {
        return {
          origin: rule.origin,
          intelClass: rule.intelClass,
          color: rule.color ?? C_RED,
          opacity: rule.opacity ?? 1,
          isSwarm: rule.isSwarm ?? false,
        };
      }
    }
  }
  return {
    origin: "UNKNOWN/COALITION",
    intelClass: "UNCLASSIFIED",
    color: C_NEUT,
    opacity: 0.7,
    isSwarm: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Visual altitude exaggeration — multiplied by this factor so satellites
// visually float high in the black space background above the globe.
const ALTITUDE_SCALE = 15;

export interface SatRecord {
  noradId: string;
  name: string;
  tags: IntelTags;
  satrec: satellite.SatRec;
}

export interface SatPosition {
  noradId: string;
  name: string;
  origin: IntelOrigin;
  intelClass: string;
  color: string;
  opacity: number;
  isSwarm: boolean;
  lat: number;
  lon: number;
  altKm: number;
  velocityKms: number;
  isGeo: boolean;
}

interface Props {
  base: string;
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  // Set of NORAD IDs that are currently selected (footprints rendered for each).
  selectedNoradIds: Set<string>;
  // Click toggles a sat on/off in the selection set.
  onToggleSelect: (sat: SatPosition) => void;
  // Fired on single click (focus for the info panel) and double click (3D tracking).
  onFocus?: (sat: SatPosition) => void;
  onTrack?: (sat: SatPosition) => void;
  onPositionsUpdated?: (positions: SatPosition[]) => void;
  // Active theater centroid [lon, lat]. When set, drives proximity fading.
  theaterCenter?: [number, number] | null;
  // Radius (km) defining the "Active AO" — sats inside are emphasized,
  // sats outside are dimmed and downsized.
  proximityRadiusKm?: number;
  // Hides the icon overlay (e.g. while a satellite is shown in the 3D view); propagation continues.
  hidden?: boolean;
}

// CelesTrak groups for maximum coverage of disguised assets.
// We pull comprehensive lists; classification happens client-side from NAMES.
const GROUP_FETCH: Array<{ group: string; cap: number }> = [
  { group: "military",   cap: 400 },
  { group: "resource",   cap: 200 },
  { group: "radar",      cap: 200 },
  // CelesTrak doesn't expose a "navigation" group; the combined GNSS feed
  // (GPS / GLONASS / BEIDOU / GALILEO) is published under "gnss".
  { group: "gnss",       cap: 200 },
];

function parseTle(text: string, cap: number): SatRecord[] {
  const out: SatRecord[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i + 2 < lines.length; i += 3) {
    if (out.length >= cap) break;
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) continue;
    try {
      const satrec = satellite.twoline2satrec(l1, l2);
      const noradId = l1.substring(2, 7).trim();
      out.push({ noradId, name, tags: classify(name), satrec });
    } catch { /* skip bad TLE */ }
  }
  return out;
}

// Records by NORAD id, shared with the cinematic tracker so the 3D view uses the same SGP4 state.
const recordRegistry = new Map<string, SatRecord>();

/** Earth-fixed (ECEF) position in metres of a loaded satellite at `when`, or null. */
export function satEcefAt(noradId: string, when: Date): { x: number; y: number; z: number } | null {
  const rec = recordRegistry.get(noradId);
  if (!rec) return null;
  const pv = satellite.propagate(rec.satrec, when);
  if (!pv || !pv.position || typeof pv.position === "boolean") return null;
  const ecf = satellite.eciToEcf(pv.position, satellite.gstime(when));
  if (!Number.isFinite(ecf.x)) return null;
  return { x: ecf.x * 1000, y: ecf.y * 1000, z: ecf.z * 1000 };
}

/** Orbital period of a loaded satellite in seconds. */
export function satPeriodSec(noradId: string): number | null {
  const rec = recordRegistry.get(noradId);
  if (!rec || !rec.satrec.no) return null;
  return ((2 * Math.PI) / rec.satrec.no) * 60;
}

function propagate(rec: SatRecord, when: Date): SatPosition | null {
  const pv = satellite.propagate(rec.satrec, when);
  if (!pv || !pv.position || typeof pv.position === "boolean") return null;
  const gmst = satellite.gstime(when);
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  const lat = satellite.degreesLat(geo.latitude);
  const lon = satellite.degreesLong(geo.longitude);
  const altKm = geo.height;
  let velocityKms = 0;
  if (pv.velocity && typeof pv.velocity !== "boolean") {
    const v = pv.velocity;
    velocityKms = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  }
  // Geostationary heuristic: ~35,786 km altitude, near-equatorial, period ~1436 min
  const meanMotion = rec.satrec.no; // rad/min
  const periodMin = (2 * Math.PI) / meanMotion;
  const isGeo = altKm > 33000 && altKm < 38000 && Math.abs(lat) < 10 && periodMin > 1300;
  return {
    noradId: rec.noradId,
    name: rec.name,
    origin: rec.tags.origin,
    intelClass: rec.tags.intelClass,
    color: rec.tags.color,
    opacity: rec.tags.opacity,
    isSwarm: rec.tags.isSwarm,
    lat,
    lon,
    altKm,
    velocityKms,
    isGeo,
  };
}

function buildGeoJson(positions: SatPosition[], selectedIds: Set<string>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: positions.map((p) => ({
      type: "Feature",
      // 3D coordinate: z is visual altitude in meters (exaggerated for globe view)
      geometry: { type: "Point", coordinates: [p.lon, p.lat, p.altKm * ALTITUDE_SCALE * 1000] },
      properties: {
        noradId: p.noradId,
        name: p.name,
        color: p.color,
        opacity: p.opacity,
        altKm: p.altKm,
        // visual size — slightly bigger for higher orbits so altitude reads,
        // selected satellite gets a boost.
        size: (p.altKm > 30000 ? 1.6 : p.altKm > 5000 ? 1.2 : 0.9) *
              (selectedIds.has(p.noradId) ? 1.7 : 1.0),
      },
    })),
  };
}

// Haversine great-circle distance in km between two (lon,lat) points.
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = EARTH_R_KM;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ── Sensor footprint geometry ──────────────────────────────────────────────
// Computes the radius (km) of a satellite's nadir-centered horizon circle:
// every sub-point on Earth from which the spacecraft is above the horizon.
// This is the natural maximum sensor footprint for an Earth-imaging asset.
const EARTH_R_KM = 6371;
// ─────────────────────────────────────────────────────────────────────────────
// Globe-aware altitude projection
// ─────────────────────────────────────────────────────────────────────────────
// MapLibre's map.project() maps surface lat/lng to screen pixels, but cannot
// project points above the surface.  We derive the correct screen-space
// displacement for a satellite at altitude by applying the same globe
// rotation stack that MapLibre uses (lng0 → lat0 → bearing → pitch) to the
// unit outward normal at the satellite's position, then read off the x/y
// components — those are exactly the screen-space altitude direction.
//
// Returns the screen-pixel offset {dx, dy} to ADD to the projected ground
// point, plus a `visible` flag (back-hemisphere points return visible=false).
function computeGlobeAltitudeOffset(
  latDeg: number, lngDeg: number,
  altFraction: number,               // visual altitude as fraction of Earth radius
  centerLat: number, centerLng: number,
  bearing: number, pitch: number,
  earthRadiusPx: number,
): { dx: number; dy: number; visible: boolean; depth: number } {
  const lat0  = centerLat * Math.PI / 180;
  const lng0  = centerLng * Math.PI / 180;
  const latR  = latDeg    * Math.PI / 180;
  const lngR  = lngDeg    * Math.PI / 180;
  const bearR = bearing   * Math.PI / 180;
  const pitR  = pitch     * Math.PI / 180;

  // Unit outward normal at (lat, lng)  ≡  the altitude direction in globe space
  let ux = Math.cos(latR) * Math.cos(lngR);
  let uy = Math.cos(latR) * Math.sin(lngR);
  let uz = Math.sin(latR);

  // Step 1 — rotate around Z by −lng0  (bring center longitude to X axis)
  let vx =  ux * Math.cos(lng0) + uy * Math.sin(lng0);
  let vy = -ux * Math.sin(lng0) + uy * Math.cos(lng0);
  let vz = uz;

  // Step 2 — rotate around Y by (lat0 − π/2)  (bring center latitude to +Z)
  const angY = lat0 - Math.PI / 2;
  const cY = Math.cos(angY), sY = Math.sin(angY);
  let wx =  vx * cY + vz * sY;
  let wy = vy;
  let wz = -vx * sY + vz * cY;

  // Step 3 — rotate around Z by −bearing
  const cB = Math.cos(bearR), sB = Math.sin(bearR);
  let ex =  wx * cB + wy * sB;
  let ey = -wx * sB + wy * cB;
  let ez = wz;

  // Step 4 — rotate around X by −pitch  (camera tilt as world rotation)
  const cP = Math.cos(pitR), sP = Math.sin(pitR);
  const fx = ex;
  const fy = ey * cP + ez * sP;
  const fz = -ey * sP + ez * cP;   // depth: > 0 = front hemisphere

  // Sphere occlusion: with the camera looking down −Z (after the rotation
  // stack), Earth is a unit sphere at the origin. The satellite sits at
  // outward-radial distance (1 + altFraction) along the unit normal (fx,fy,fz).
  // Its 3D position in camera space is therefore:
  //     p = (fx, fy, fz) * (1 + altFraction)
  // It is occluded by Earth iff p lies inside the Earth's silhouette
  // (lateral_distance² < 1) AND it is on the far side (pz < 0).
  // Adding a small angular safety margin keeps near-horizon icons from
  // poking through the limb.
  const r = 1 + altFraction;
  const pz = fz * r;
  const lateralSq = (fx * fx + fy * fy) * r * r;
  // safety: shrink "Earth" silhouette by 1.5% to keep marker bodies clear
  const occluded = pz < 0 && lateralSq < 0.97 * 0.97;

  return {
    dx:      fx * altFraction * earthRadiusPx,
    dy:     -fy * altFraction * earthRadiusPx,  // screen Y is inverted
    visible: !occluded,
    depth:   pz,                                 // > 0 = in front of Earth center
  };
}

function horizonRadiusKm(altKm: number): number {
  const r = EARTH_R_KM;
  // Half-angle θ at Earth's center subtending the visible cap:
  // cos(θ) = R / (R + h)
  const cos = r / (r + altKm);
  const theta = Math.acos(Math.max(-1, Math.min(1, cos)));
  return r * theta; // arc-length on the surface
}

// Walks a great-circle from (lat, lon) at bearing θ for distance d (km).
function destinationPoint(lat: number, lon: number, bearingDeg: number, distKm: number): [number, number] {
  const R = EARTH_R_KM;
  const δ = distKm / R;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return [((λ2 * 180) / Math.PI + 540) % 360 - 180, (φ2 * 180) / Math.PI];
}

function buildFootprintFeatures(sel: SatPosition): GeoJSON.Feature[] {
  // Cap visual footprint so geostationary sats don't blanket the planet.
  const radiusKm = Math.min(horizonRadiusKm(sel.altKm) * 0.55, 2500);
  const segments = 64;
  const ring: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    ring.push(destinationPoint(sel.lat, sel.lon, (i * 360) / segments, radiusKm));
  }
  // Ground-level footprint ring polygon (2D, stays on surface)
  const polygon: GeoJSON.Feature = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { color: sel.color },
  };

  // Visual altitude of the satellite in meters (exaggerated for 3D globe)
  const visualAltM = sel.altKm * ALTITUDE_SCALE * 1000;

  // 12 true 3D sensor lines: start at satellite in space, terminate at
  // ground targets on the footprint perimeter. This creates the "God's Eye"
  // web-of-lines effect visible in the reference UI.
  const spokes: GeoJSON.Feature[] = [];
  const spokeCount = 12;
  for (let i = 0; i < spokeCount; i++) {
    const tip = destinationPoint(sel.lat, sel.lon, (i * 360) / spokeCount, radiusKm);
    spokes.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [sel.lon, sel.lat, visualAltM], // satellite position at visual altitude
          [tip[0], tip[1], 0],             // ground target at surface
        ],
      },
      properties: { color: sel.color },
    });
  }

  // Vertical nadir drop-line from satellite straight down to sub-satellite point
  const nadirDrop: GeoJSON.Feature = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [sel.lon, sel.lat, visualAltM],
        [sel.lon, sel.lat, 0],
      ],
    },
    properties: { color: sel.color },
  };

  return [polygon, nadirDrop, ...spokes];
}

function buildOrbitGeoJson(rec: SatRecord, when: Date): GeoJSON.Feature | null {
  const stepSec = 30;
  const totalSec = 100 * 60;
  const coords: [number, number][] = [];
  let lastLon: number | null = null;
  for (let t = 0; t <= totalSec; t += stepSec) {
    const dt = new Date(when.getTime() + t * 1000);
    const pos = propagate(rec, dt);
    if (!pos) continue;
    let lon = pos.lon;
    if (lastLon !== null && Math.abs(lon - lastLon) > 180) {
      lon += lon < lastLon ? 360 : -360;
    }
    coords.push([lon, pos.lat]);
    lastLon = lon;
  }
  if (coords.length < 2) return null;
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {},
  };
}

// Build a clearly-spacecraft icon: square bus + 4-cell solar wings + antenna.
// SDF mode uses only the alpha channel, so we paint solid white shapes.
function makeSatelliteIcon(): ImageData {
  const size = 36;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";

  const cx = size / 2;
  const cy = size / 2;

  ctx.fillRect(cx - 4, cy - 4, 8, 8);
  ctx.fillRect(cx - 1, cy - 8, 2, 4);
  ctx.beginPath(); ctx.arc(cx, cy - 9, 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy + 7, 2.2, 0, Math.PI * 2); ctx.fill();

  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy); ctx.lineTo(cx - 17, cy);
  ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 17, cy);
  ctx.stroke();

  ctx.fillRect(cx - 16, cy - 4, 5, 8);
  ctx.fillRect(cx - 10, cy - 4, 5, 8);
  ctx.fillRect(cx + 5,  cy - 4, 5, 8);
  ctx.fillRect(cx + 11, cy - 4, 5, 8);

  return ctx.getImageData(0, 0, size, size);
}

export function SatelliteLayer({
  base,
  map,
  mapLoaded,
  selectedNoradIds,
  onToggleSelect,
  onFocus,
  onTrack,
  onPositionsUpdated,
  theaterCenter,
  proximityRadiusKm = 2500,
  hidden = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recordsRef = useRef<SatRecord[]>([]);
  const positionsRef = useRef<SatPosition[]>([]);
  const selectedIdsRef = useRef<Set<string>>(selectedNoradIds);
  selectedIdsRef.current = selectedNoradIds;
  const onToggleSelectRef = useRef(onToggleSelect);
  onToggleSelectRef.current = onToggleSelect;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const onTrackRef = useRef(onTrack);
  onTrackRef.current = onTrack;
  const onPositionsUpdatedRef = useRef(onPositionsUpdated);
  onPositionsUpdatedRef.current = onPositionsUpdated;
  const theaterCenterRef = useRef<[number, number] | null | undefined>(theaterCenter);
  theaterCenterRef.current = theaterCenter;
  const proximityRadiusRef = useRef<number>(proximityRadiusKm);
  proximityRadiusRef.current = proximityRadiusKm;

  // ---- Fetch + parse TLE for all groups once ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all: SatRecord[] = [];
      await Promise.all(
        GROUP_FETCH.map(async ({ group, cap }) => {
          try {
            const r = await fetch(`${base}/api/proxy/satellites/${group}`);
            if (!r.ok) return;
            const txt = await r.text();
            all.push(...parseTle(txt, cap));
          } catch (e) {
            console.warn(`TLE fetch failed: ${group}`, e);
          }
        }),
      );
      if (cancelled) return;
      // Dedupe by NORAD catalog number — a sat may appear in multiple groups.
      const seen = new Set<string>();
      recordsRef.current = all.filter((r) => {
        if (seen.has(r.noradId)) return false;
        seen.add(r.noradId);
        return true;
      });
      for (const r of recordsRef.current) recordRegistry.set(r.noradId, r);
    })();
    return () => { cancelled = true; };
  }, [base]);

  // ---- Set up MapLibre layers (mount/unmount) ----
  useEffect(() => {
    if (!map || !mapLoaded) return;

    const ensureImage = () => {
      if (!map.hasImage("satellite-icon")) {
        map.addImage("satellite-icon", makeSatelliteIcon(), { sdf: true });
      }
    };
    ensureImage();

    if (!map.getSource("satellites")) {
      map.addSource("satellites", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getSource("sat-orbit")) {
      map.addSource("sat-orbit", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getSource("sat-nadir")) {
      map.addSource("sat-nadir", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }

    if (!map.getLayer("sat-orbit-glow")) {
      map.addLayer({
        id: "sat-orbit-glow", type: "line", source: "sat-orbit",
        paint: { "line-color": "#ffb38a", "line-width": 4, "line-opacity": 0.25, "line-blur": 4 },
      });
    }
    if (!map.getLayer("sat-orbit-line")) {
      map.addLayer({
        id: "sat-orbit-line", type: "line", source: "sat-orbit",
        paint: { "line-color": "#ffd5b8", "line-width": 1.3, "line-opacity": 0.85 },
      });
    }
    if (!map.getSource("sat-footprint")) {
      map.addSource("sat-footprint", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getLayer("sat-footprint-fill")) {
      map.addLayer({
        id: "sat-footprint-fill", type: "fill", source: "sat-footprint",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": 0.07,
        },
      });
    }
    if (!map.getLayer("sat-footprint-ring")) {
      map.addLayer({
        id: "sat-footprint-ring", type: "line", source: "sat-footprint",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.4,
          "line-opacity": 0.85,
        },
      });
    }
    if (!map.getLayer("sat-footprint-spokes")) {
      map.addLayer({
        id: "sat-footprint-spokes", type: "line", source: "sat-footprint",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.0,
          "line-opacity": 0.65,
        },
      });
    }
    if (!map.getLayer("sat-nadir-line")) {
      map.addLayer({
        id: "sat-nadir-line", type: "circle", source: "sat-nadir",
        paint: {
          "circle-radius": 10, "circle-color": "transparent",
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2, "circle-stroke-opacity": 0.55,
        },
      });
    }
    if (!map.getLayer("sat-nadir-dot")) {
      map.addLayer({
        id: "sat-nadir-dot", type: "circle", source: "sat-nadir",
        paint: { "circle-radius": 3, "circle-color": "#ffffff", "circle-opacity": 0.9 },
      });
    }
    if (!map.getLayer("satellites-layer")) {
      map.addLayer({
        id: "satellites-layer",
        type: "circle",
        source: "satellites",
        paint: {
          "circle-radius": 0,
          "circle-opacity": 0,
        },
      });
    }
    // Force satellite layers above the aircraft layer.
    ["sat-orbit-glow", "sat-orbit-line", "sat-footprint-fill", "sat-footprint-ring", "sat-footprint-spokes", "sat-nadir-line", "sat-nadir-dot", "satellites-layer"].forEach((id) => {
      if (map.getLayer(id)) { try { map.moveLayer(id); } catch { /* noop */ } }
    });

    return () => {
      try {
        ["satellites-layer", "sat-orbit-line", "sat-orbit-glow", "sat-footprint-fill", "sat-footprint-ring", "sat-footprint-spokes", "sat-nadir-line", "sat-nadir-dot"].forEach((id) => {
          if (map.getLayer(id)) map.removeLayer(id);
        });
        ["satellites", "sat-orbit", "sat-footprint", "sat-nadir"].forEach((s) => {
          if (map.getSource(s)) map.removeSource(s);
        });
      } catch { /* map may be torn down */ }
    };
  }, [map, mapLoaded]);

  // ---- Tick: propagate positions every 2s, recompute orbit on selection ----
  useEffect(() => {
    if (!map || !mapLoaded) return;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const now = new Date();
      const positions: SatPosition[] = [];
      for (const rec of recordsRef.current) {
        const p = propagate(rec, now);
        if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) positions.push(p);
      }
      positionsRef.current = positions;
      onPositionsUpdatedRef.current?.(positions);

      const selIds = selectedIdsRef.current;
      const src = map.getSource("satellites") as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(buildGeoJson(positions, selIds));

      const selectedSats = selIds.size > 0
        ? positions.filter((p) => selIds.has(p.noradId))
        : [];
      const orbitSrc = map.getSource("sat-orbit") as maplibregl.GeoJSONSource | undefined;
      const nadirSrc = map.getSource("sat-nadir") as maplibregl.GeoJSONSource | undefined;
      const footSrc  = map.getSource("sat-footprint") as maplibregl.GeoJSONSource | undefined;
      if (selectedSats.length > 0) {
        // Orbits — only the singly-selected case shows a trail to avoid clutter.
        if (orbitSrc) {
          if (selectedSats.length === 1) {
            const sel = selectedSats[0];
            const rec = recordsRef.current.find((r) => r.noradId === sel.noradId);
            if (!sel.isGeo && rec) {
              const orbit = buildOrbitGeoJson(rec, now);
              orbitSrc.setData(orbit
                ? { type: "FeatureCollection", features: [orbit] }
                : { type: "FeatureCollection", features: [] });
            } else {
              orbitSrc.setData({ type: "FeatureCollection", features: [] });
            }
          } else {
            orbitSrc.setData({ type: "FeatureCollection", features: [] });
          }
        }
        if (nadirSrc) {
          nadirSrc.setData({
            type: "FeatureCollection",
            features: selectedSats.map((s) => ({
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
              properties: {},
            })),
          });
        }
        if (footSrc) {
          const allFeatures: GeoJSON.Feature[] = [];
          for (const s of selectedSats) allFeatures.push(...buildFootprintFeatures(s));
          footSrc.setData({ type: "FeatureCollection", features: allFeatures });
        }
      } else {
        orbitSrc?.setData({ type: "FeatureCollection", features: [] });
        nadirSrc?.setData({ type: "FeatureCollection", features: [] });
        footSrc?.setData({ type: "FeatureCollection", features: [] });
      }
    };

    tick();
    const interval = setInterval(tick, 2000);
    return () => { stopped = true; clearInterval(interval); };
  }, [map, mapLoaded, selectedNoradIds]);

  // ── Canvas overlay: renders satellite icons at their true space altitude ──
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const syncSize = () => {
      const c = map.getContainer();
      canvas.width = c.clientWidth;
      canvas.height = c.clientHeight;
    };
    syncSize();

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const positions = positionsRef.current;
      const selIds = selectedIdsRef.current;
      const theater = theaterCenterRef.current;
      const aoRadiusKm = proximityRadiusRef.current;
      const zoom = map.getZoom();
      const earthRadiusPx = (512 / (2 * Math.PI)) * Math.pow(2, zoom);
      const mapCenter  = map.getCenter();
      const bearing    = map.getBearing();
      const pitch      = map.getPitch();

      for (const sat of positions) {
        // Logarithmic visual altitude fraction (LEO≈0.24, GPS≈1.0, GEO≈1.1)
        const altFraction = Math.log10(1 + sat.altKm / 200) * 0.5;

        // 3-D globe-aware projection: correct altitude direction + back-face cull
        const offset = computeGlobeAltitudeOffset(
          sat.lat, sat.lon, altFraction,
          mapCenter.lat, mapCenter.lng,
          bearing, pitch, earthRadiusPx,
        );
        if (!offset.visible) continue;     // occluded by Earth → skip

        const groundPos = map.project(new maplibregl.LngLat(sat.lon, sat.lat));
        const sx = groundPos.x + offset.dx;
        const sy = groundPos.y + offset.dy;

        // Skip off-screen
        if (sx < -120 || sx > canvas.width + 120 || sy < -2000 || sy > canvas.height + 120) continue;

        const isSelected = selIds.has(sat.noradId);

        // ── Proximity fading (Geospatial Depth of Field) ──
        // When a theater of operations is active, sats within the AO radius
        // are emphasized, sats outside are visually suppressed.
        let proxScale = 1.0;
        let proxAlpha = 1.0;
        if (theater) {
          const dKm = haversineKm(sat.lat, sat.lon, theater[1], theater[0]);
          if (dKm <= aoRadiusKm) {
            proxScale = 1.5;
            proxAlpha = 1.0;
          } else {
            proxScale = 0.5;
            proxAlpha = 0.2;
          }
        }

        const baseSize = sat.altKm > 30000 ? 9 : sat.altKm > 5000 ? 8 : 7;
        const size = baseSize * (isSelected ? 1.7 : 1.0) * proxScale;
        const alpha = sat.opacity * proxAlpha;
        const color = sat.color;
        const bw = size * 0.52;
        const bh = size * 0.52;

        ctx.save();
        ctx.globalAlpha = alpha;

        // Satellite body square
        ctx.strokeStyle = color;
        ctx.fillStyle = color + "40";
        ctx.lineWidth = isSelected ? 1.5 : 0.9;
        ctx.fillRect(sx - bw / 2, sy - bh / 2, bw, bh);
        ctx.strokeRect(sx - bw / 2, sy - bh / 2, bw, bh);

        // Solar panel arms
        ctx.beginPath();
        ctx.moveTo(sx - bw / 2, sy);
        ctx.lineTo(sx - size * 0.85, sy);
        ctx.moveTo(sx + bw / 2, sy);
        ctx.lineTo(sx + size * 0.85, sy);
        ctx.stroke();

        // Solar panel cells
        ctx.fillRect(sx - size * 0.85, sy - bh * 0.42, size * 0.28, bh * 0.84);
        ctx.strokeRect(sx - size * 0.85, sy - bh * 0.42, size * 0.28, bh * 0.84);
        ctx.fillRect(sx + size * 0.57, sy - bh * 0.42, size * 0.28, bh * 0.84);
        ctx.strokeRect(sx + size * 0.57, sy - bh * 0.42, size * 0.28, bh * 0.84);

        if (isSelected) {
          // Outer selection ring
          ctx.globalAlpha = 0.65;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(sx, sy, size * 1.65, 0, Math.PI * 2);
          ctx.stroke();

          // Nadir drop-line from satellite to its ground sub-point
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.8;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(groundPos.x, groundPos.y);
          ctx.stroke();
          ctx.setLineDash([]);

          // Draw true-3D sensor lines from satellite in space to ground targets
          const radiusKm = Math.min(horizonRadiusKm(sat.altKm) * 0.55, 2500);
          const spokeCount = 12;
          ctx.lineWidth = 0.85;
          ctx.globalAlpha = 0.4;
          for (let i = 0; i < spokeCount; i++) {
            const tip = destinationPoint(sat.lat, sat.lon, (i * 360) / spokeCount, radiusKm);
            const tipGround = map.project(new maplibregl.LngLat(tip[0], tip[1]));
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.moveTo(sx, sy); // satellite at space altitude
            ctx.lineTo(tipGround.x, tipGround.y); // ground target at surface
            ctx.stroke();
          }
        }

        ctx.restore();
      }
    };

    draw();
    map.on("render", draw);
    window.addEventListener("resize", syncSize);

    return () => {
      map.off("render", draw);
      window.removeEventListener("resize", syncSize);
    };
  }, [map, mapLoaded]);

  // ── Click detection via MapLibre's native handler ──
  // Canvas has pointer-events:none so map pan/zoom works unobstructed.
  // We intercept map clicks and check proximity to each satellite's elevated screen pos.
  useEffect(() => {
    if (!map || !mapLoaded) return;

    const findSat = (e: maplibregl.MapMouseEvent): SatPosition | null => {
      const cx = e.point.x;
      const cy = e.point.y;
      const zoom = map.getZoom();
      const earthRadiusPx = (512 / (2 * Math.PI)) * Math.pow(2, zoom);
      const mapCenter = map.getCenter();
      const bearing   = map.getBearing();
      const pitch     = map.getPitch();

      let closest: SatPosition | null = null;
      let closestDist = 20; // hit radius in px

      for (const sat of positionsRef.current) {
        const altFraction = Math.log10(1 + sat.altKm / 200) * 0.5;
        const offset = computeGlobeAltitudeOffset(
          sat.lat, sat.lon, altFraction,
          mapCenter.lat, mapCenter.lng,
          bearing, pitch, earthRadiusPx,
        );
        if (!offset.visible) continue;
        const groundPos = map.project(new maplibregl.LngLat(sat.lon, sat.lat));
        const sx = groundPos.x + offset.dx;
        const sy = groundPos.y + offset.dy;
        const dist = Math.sqrt((cx - sx) ** 2 + (cy - sy) ** 2);
        if (dist < closestDist) {
          closestDist = dist;
          closest = sat;
        }
      }
      return closest;
    };

    const handleMapClick = (e: maplibregl.MapMouseEvent) => {
      const closest = findSat(e);
      if (!closest) return;
      onToggleSelectRef.current(closest);
      onFocusRef.current?.(closest);
    };
    const handleMapDblClick = (e: maplibregl.MapMouseEvent) => {
      const closest = findSat(e);
      if (!closest) return;
      e.preventDefault();
      onTrackRef.current?.(closest);
    };

    map.on("click", handleMapClick);
    map.on("dblclick", handleMapDblClick);
    return () => {
      map.off("click", handleMapClick);
      map.off("dblclick", handleMapDblClick);
    };
  }, [map, mapLoaded]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 6,
        pointerEvents: "none",
        visibility: hidden ? "hidden" : "visible",
      }}
    />
  );
}
