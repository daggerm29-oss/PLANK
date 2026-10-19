import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";

// ──────────────────────────────────────────────────────────────────────────────
// Maritime radar contact. Mirrors the upstream `/api/radar` schema with only
// the fields we actually consume. Extras (sog, cog, est_barrels, vessel_name)
// are kept around so list-rendering UIs can display them later.
// ──────────────────────────────────────────────────────────────────────────────
export interface Ship {
  mmsi: number | string;
  vessel_name?: string;
  ship_name?: string;
  lat: number;
  lon: number;
  sog?: number;
  cog?: number;
  last_updated?: number;
  /** Upstream classification — TANKER / MILITARY / UNKNOWN or custom. */
  category?: "TANKER" | "MILITARY" | "UNKNOWN" | string;
  /** Upstream feed origin — AISSTREAM (global) / MARINETRAFFIC / FUSED_INTEL / DARK_FLEET or custom. */
  source?: "AISSTREAM" | "MARINETRAFFIC" | "FUSED_INTEL" | "DARK_FLEET" | string;
  dwt?: number;
  est_barrels?: number;
  destination?: string;
  status?: string;
  // AIS Gap Candidates / Dark Fleet telemetry (originating strictly from /api/dark-fleet)
  is_gap?: boolean;
  time_went_dark?: string;
  last_known_lat?: number;
  last_known_lon?: number;
  [key: string]: unknown;
}

export interface ShipFilters {
  /** Show MILITARY-classified contacts (rendered blue). */
  military: boolean;
  /** Show TANKER-classified contacts (rendered red). */
  tankers: boolean;
  /** Show AISSTREAM (global civilian AIS) contacts (rendered white). */
  globalAis: boolean;
  /** Show AIS GAP CANDIDATES (stopped transmitting for 30+ min, rendered orange). */
  aisGap: boolean;
}

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  ships: Ship[];
  filters: ShipFilters;
  /** Master visibility — when the Maritime panel is closed we still keep the
   *  layer mounted (cheap) but flip the layout visibility off so the points
   *  disappear from the globe without tearing down sources/layers. */
  visible: boolean;
  /** Single click on a vessel. */
  onSelect?: (mmsi: string) => void;
  /** Double click on a vessel (cinematic 3D view). */
  onTrack?: (mmsi: string) => void;
}

// Render colours per the spec.
const C_TANKER  = "#ff3b30"; // red
const C_MIL     = "#3a8dff"; // blue
const C_AIS     = "#ffffff"; // white (AISSTREAM, global)
const C_GAP     = "#ff9500"; // amber/orange (AIS gap candidates)
const C_FALLBACK = "rgba(180,200,210,0.65)";

export function isAisGapCandidate(s: Ship): boolean {
  // AIS gap candidates originate strictly from /api/dark-fleet.
  // We do not infer them from the radar list.
  return s.is_gap === true || s.source === "DARK_FLEET";
}

/**
 * Bucket a ship into one of the render categories.
 */
function classifyShip(s: Ship): { color: string; bucket: "ais" | "tanker" | "mil" | "gap" | "other" } {
  if (isAisGapCandidate(s))      return { color: C_GAP,    bucket: "gap"   };
  if (s.source === "AISSTREAM")  return { color: C_AIS,    bucket: "ais"   };
  if (s.category === "TANKER")   return { color: C_TANKER, bucket: "tanker"};
  if (s.category === "MILITARY") return { color: C_MIL,    bucket: "mil"   };
  return { color: C_FALLBACK, bucket: "other" };
}

/** Build a GeoJSON FeatureCollection from the filtered ship list. */
function buildGeoJson(ships: Ship[], filters: ShipFilters): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const s of ships) {
    if (typeof s.lat !== "number" || typeof s.lon !== "number") continue;
    const { color, bucket } = classifyShip(s);
    if (bucket === "gap"    && !filters.aisGap)    continue;
    if (bucket === "ais"    && !filters.globalAis) continue;
    if (bucket === "tanker" && !filters.tankers)   continue;
    if (bucket === "mil"    && !filters.military)  continue;
    if (bucket === "other"  && !(filters.globalAis || filters.tankers || filters.military || filters.aisGap)) continue;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: {
        mmsi: s.mmsi,
        name: s.vessel_name ?? s.ship_name ?? "",
        color,
        bucket,
        category: s.category ?? "",
        source: s.source ?? "",
        status: s.status ?? "",
        time_went_dark: s.time_went_dark ?? "",
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Renders maritime radar contacts as MapLibre circle layers.
 */
export function ShipsLayer({ map, mapLoaded, ships, filters, visible, onSelect, onTrack }: Props) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onTrackRef = useRef(onTrack);
  onTrackRef.current = onTrack;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // ── click / double-click picking (dots are tiny, so use a padded bbox) ──
  useEffect(() => {
    if (!map || !mapLoaded) return;

    const pick = (e: maplibregl.MapMouseEvent): string | null => {
      if (!visibleRef.current) return null;
      const layers = ["ships-dot", "ships-halo"].filter((id) => map.getLayer(id));
      if (!layers.length) return null;
      const pad = 7;
      const feats = map.queryRenderedFeatures(
        [
          [e.point.x - pad, e.point.y - pad],
          [e.point.x + pad, e.point.y + pad],
        ],
        { layers },
      );
      const mmsi = feats[0]?.properties?.mmsi;
      return mmsi === undefined || mmsi === null ? null : String(mmsi);
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const id = pick(e);
      if (id) onSelectRef.current?.(id);
    };
    const onDbl = (e: maplibregl.MapMouseEvent) => {
      const id = pick(e);
      if (!id) return;
      e.preventDefault();
      onTrackRef.current?.(id);
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      const canvas = map.getCanvas();
      if (pick(e)) canvas.style.cursor = "pointer";
      else if (canvas.style.cursor === "pointer") canvas.style.cursor = "";
    };

    map.on("click", onClick);
    map.on("dblclick", onDbl);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onClick);
      map.off("dblclick", onDbl);
      map.off("mousemove", onMove);
    };
  }, [map, mapLoaded]);

  // ── source / layer setup (once per map instance) ────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;

    if (!map.getSource("ships")) {
      map.addSource("ships", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!map.getLayer("ships-halo")) {
      map.addLayer({
        id: "ships-halo",
        type: "circle",
        source: "ships",
        paint: {
          "circle-radius": [
            "match", ["get", "bucket"],
            "tanker", 6.5,
            "mil",    6.5,
            "gap",    5.5,
            "ais",    3.5,
            3.5,
          ],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.18,
          "circle-blur": 0.6,
        },
      });
    }

    if (!map.getLayer("ships-dot")) {
      map.addLayer({
        id: "ships-dot",
        type: "circle",
        source: "ships",
        paint: {
          "circle-radius": [
            "match", ["get", "bucket"],
            "tanker", 3.2,
            "mil",    3.2,
            "gap",    2.8,
            "ais",    1.6,
            1.6,
          ],
          "circle-color": ["get", "color"],
          "circle-opacity": [
            "match", ["get", "bucket"],
            "ais", 0.75,
            0.95,
          ],
          "circle-stroke-width": [
            "match", ["get", "bucket"],
            "tanker", 0.6,
            "mil",    0.6,
            "gap",    0.6,
            0,
          ],
          "circle-stroke-color": "rgba(0,0,0,0.55)",
        },
      });
    }

    return () => {
      // Cleanup on unmount — strict-mode double-invoke safe because each
      // operation is guarded by an existence check.
      // A removed map has no style; its layers are already gone.
      if (!map.style) return;
      for (const id of ["ships-dot", "ships-halo"]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource("ships")) map.removeSource("ships");
    };
  }, [map, mapLoaded]);

  // ── data updates (whenever ships, filters, or visibility change) ────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const src = map.getSource("ships") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(buildGeoJson(ships, filters));
  }, [map, mapLoaded, ships, filters]);

  // ── visibility toggle (panel closed ⇒ layer hidden, sources retained) ──
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const v = visible ? "visible" : "none";
    for (const id of ["ships-dot", "ships-halo"]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
    }
  }, [map, mapLoaded, visible]);

  return null;
}
