import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";

export type PlaybackMode = "INDIA" | "HORMUZ" | "PLANES";

export interface PlaybackShipContact {
  mmsi: number;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  cat: number; // 0 other (white), 1 tanker (red), 2 military (blue)
}

export interface PlaybackPlaneContact {
  hex: string;
  lat: number;
  lon: number;
  alt_ft: number | null;
  gs_kt: number | null;
  track: number | null;
  callsign: string;
  mil: number; // 1 military (orange), 0 civil (cyan)
}

export interface PlaybackRegionBounds {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

export interface SelectedEntity {
  type: "ship" | "plane";
  id: string | number;
  label: string;
  lat: number;
  lon: number;
  speed?: number | null;
  heading?: number | null;
  alt?: number | null;
  category?: string;
}

export interface TrailPoint {
  ts: string;
  lat: number;
  lon: number;
  sog?: number;
  cog?: number;
  alt_ft?: number;
  gs_kt?: number;
  track?: number;
  callsign?: string;
}

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  active: boolean;
  mode: PlaybackMode;
  regionBounds: PlaybackRegionBounds | null;
  ships: PlaybackShipContact[];
  planes: PlaybackPlaneContact[];
  selectedEntity: SelectedEntity | null;
  trailPoints: TrailPoint[];
  onSelectEntity: (entity: SelectedEntity) => void;
}

// Tactical color palette matching live layers
const C_TANKER = "#ff3b30";
const C_MIL = "#3a8dff";
const C_CIVIL_SHIP = "#ffffff";
const C_MIL_PLANE = "#ff8c42";
const C_CIVIL_PLANE = "#00ffff";

export function PlaybackLayer({
  map,
  mapLoaded,
  active,
  mode,
  regionBounds,
  ships,
  planes,
  selectedEntity,
  trailPoints,
  onSelectEntity,
}: Props) {
  const onSelectEntityRef = useRef(onSelectEntity);
  onSelectEntityRef.current = onSelectEntity;

  // ── Initialize Sources and Layers ──────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;

    // 1. Region Bounding Box Source & Layer
    if (!map.getSource("playback-region")) {
      map.addSource("playback-region", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!map.getLayer("playback-region-fill")) {
      map.addLayer({
        id: "playback-region-fill",
        type: "fill",
        source: "playback-region",
        paint: {
          "fill-color": "rgba(0, 255, 255, 0.04)",
        },
      });
    }

    if (!map.getLayer("playback-region-outline")) {
      map.addLayer({
        id: "playback-region-outline",
        type: "line",
        source: "playback-region",
        paint: {
          "line-color": "#00ffff",
          "line-width": 1.5,
          "line-dasharray": [3, 2],
          "line-opacity": 0.65,
        },
      });
    }

    // 2. Playback Contacts Source (Ships & Planes points)
    if (!map.getSource("playback-contacts")) {
      map.addSource("playback-contacts", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    // Ship contacts: halo
    if (!map.getLayer("playback-contacts-halo")) {
      map.addLayer({
        id: "playback-contacts-halo",
        type: "circle",
        source: "playback-contacts",
        filter: ["==", ["get", "type"], "ship"],
        paint: {
          "circle-radius": [
            "match",
            ["get", "cat"],
            1, 6.5,
            2, 6.5,
            3.5,
          ],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.18,
          "circle-blur": 0.6,
        },
      });
    }

    // Ship contacts: solid core dot
    if (!map.getLayer("playback-contacts-dot")) {
      map.addLayer({
        id: "playback-contacts-dot",
        type: "circle",
        source: "playback-contacts",
        filter: ["==", ["get", "type"], "ship"],
        paint: {
          "circle-radius": [
            "match",
            ["get", "cat"],
            1, 3.2,
            2, 3.2,
            1.8,
          ],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.95,
          "circle-stroke-width": 0.6,
          "circle-stroke-color": "rgba(0, 0, 0, 0.6)",
        },
      });
    }

    // Aircraft contacts: aircraft symbol icon
    if (!map.getLayer("playback-planes-symbol")) {
      map.addLayer({
        id: "playback-planes-symbol",
        type: "symbol",
        source: "playback-contacts",
        filter: ["==", ["get", "type"], "plane"],
        layout: {
          "icon-image": "aircraft-icon",
          "icon-rotate": ["get", "heading"],
          "icon-rotation-alignment": "map",
          "icon-pitch-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": 0.8,
        },
        paint: {
          "icon-color": ["get", "color"],
          "icon-opacity": 0.95,
        },
      });
    }

    // 3. Playback Trail Source & Layers
    if (!map.getSource("playback-trail")) {
      map.addSource("playback-trail", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!map.getLayer("playback-trail-glow")) {
      map.addLayer({
        id: "playback-trail-glow",
        type: "line",
        source: "playback-trail",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": "#ffd200",
          "line-width": 4.5,
          "line-blur": 3,
          "line-opacity": 0.45,
        },
      });
    }

    if (!map.getLayer("playback-trail-line")) {
      map.addLayer({
        id: "playback-trail-line",
        type: "line",
        source: "playback-trail",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": "#ffea75",
          "line-width": 1.8,
          "line-dasharray": [2, 1],
          "line-opacity": 0.95,
        },
      });
    }

    if (!map.getLayer("playback-trail-points")) {
      map.addLayer({
        id: "playback-trail-points",
        type: "circle",
        source: "playback-trail",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 2.2,
          "circle-color": "#ffd200",
          "circle-opacity": 0.8,
          "circle-stroke-width": 0.5,
          "circle-stroke-color": "#000000",
        },
      });
    }

    // ── Interaction: Click & Hover handlers ─────────────────────────────
    const onShipClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const feat = e.features?.[0];
      if (!feat?.properties) return;
      const mmsi = feat.properties.mmsi;
      const coords = (feat.geometry as GeoJSON.Point).coordinates;
      onSelectEntityRef.current({
        type: "ship",
        id: mmsi,
        label: `MMSI ${mmsi}`,
        lat: coords[1],
        lon: coords[0],
        speed: feat.properties.sog,
        heading: feat.properties.heading,
        category: feat.properties.cat === 1 ? "TANKER" : feat.properties.cat === 2 ? "MILITARY" : "CIVILIAN",
      });
    };

    const onPlaneClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const feat = e.features?.[0];
      if (!feat?.properties) return;
      const hex = feat.properties.hex;
      const callsign = feat.properties.callsign;
      const coords = (feat.geometry as GeoJSON.Point).coordinates;
      onSelectEntityRef.current({
        type: "plane",
        id: hex,
        label: callsign ? callsign.trim() : hex,
        lat: coords[1],
        lon: coords[0],
        speed: feat.properties.gs,
        heading: feat.properties.heading,
        alt: feat.properties.alt,
        category: feat.properties.mil === 1 ? "MILITARY" : "CIVIL",
      });
    };

    const setPointer = () => { map.getCanvas().style.cursor = "pointer"; };
    const resetPointer = () => { map.getCanvas().style.cursor = ""; };

    map.on("click", "playback-contacts-dot", onShipClick);
    map.on("click", "playback-planes-symbol", onPlaneClick);
    map.on("mouseenter", "playback-contacts-dot", setPointer);
    map.on("mouseleave", "playback-contacts-dot", resetPointer);
    map.on("mouseenter", "playback-planes-symbol", setPointer);
    map.on("mouseleave", "playback-planes-symbol", resetPointer);

    return () => {
      map.off("click", "playback-contacts-dot", onShipClick);
      map.off("click", "playback-planes-symbol", onPlaneClick);
      map.off("mouseenter", "playback-contacts-dot", setPointer);
      map.off("mouseleave", "playback-contacts-dot", resetPointer);
      map.off("mouseenter", "playback-planes-symbol", setPointer);
      map.off("mouseleave", "playback-planes-symbol", resetPointer);

      const layerIds = [
        "playback-trail-points",
        "playback-trail-line",
        "playback-trail-glow",
        "playback-planes-symbol",
        "playback-contacts-dot",
        "playback-contacts-halo",
        "playback-region-outline",
        "playback-region-fill",
      ];
      // A removed map has no style; its layers are already gone.
      if (!map.style) return;
      for (const id of layerIds) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of ["playback-trail", "playback-contacts", "playback-region"]) {
        if (map.getSource(id)) map.removeSource(id);
      }
    };
  }, [map, mapLoaded]);

  // ── Visibility Toggle ──────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const v = active ? "visible" : "none";
    const layerIds = [
      "playback-region-fill",
      "playback-region-outline",
      "playback-contacts-halo",
      "playback-contacts-dot",
      "playback-planes-symbol",
      "playback-trail-glow",
      "playback-trail-line",
      "playback-trail-points",
    ];
    for (const id of layerIds) {
      if (map.getLayer(id)) {
        try {
          map.setLayoutProperty(id, "visibility", v);
        } catch {
          // ignore layout state transition
        }
      }
    }
  }, [map, mapLoaded, active]);

  // ── Update Region Polygon ──────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const src = map.getSource("playback-region") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!active || mode === "PLANES" || !regionBounds) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const { lonMin, lonMax, latMin, latMax } = regionBounds;
    const polygonFeature: GeoJSON.Feature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [lonMin, latMin],
            [lonMax, latMin],
            [lonMax, latMax],
            [lonMin, latMax],
            [lonMin, latMin],
          ],
        ],
      },
      properties: { mode },
    };

    src.setData({ type: "FeatureCollection", features: [polygonFeature] });
  }, [map, mapLoaded, active, mode, regionBounds]);

  // ── Update Contacts GeoJSON (Ships or Planes) ──────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const src = map.getSource("playback-contacts") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!active) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const features: GeoJSON.Feature[] = [];

    if (mode === "INDIA" || mode === "HORMUZ") {
      for (const s of ships) {
        if (typeof s.lat !== "number" || typeof s.lon !== "number") continue;
        const color = s.cat === 1 ? C_TANKER : s.cat === 2 ? C_MIL : C_CIVIL_SHIP;
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
          properties: {
            type: "ship",
            mmsi: s.mmsi,
            cat: s.cat,
            color,
            heading: typeof s.cog === "number" ? s.cog : 0,
            sog: typeof s.sog === "number" ? s.sog : 0,
          },
        });
      }
    } else if (mode === "PLANES") {
      for (const p of planes) {
        if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
        const color = p.mil === 1 ? C_MIL_PLANE : C_CIVIL_PLANE;
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.lon, p.lat] },
          properties: {
            type: "plane",
            hex: p.hex,
            callsign: p.callsign || p.hex,
            mil: p.mil,
            color,
            heading: typeof p.track === "number" ? p.track : 0,
            alt: typeof p.alt_ft === "number" ? p.alt_ft : 0,
            gs: typeof p.gs_kt === "number" ? p.gs_kt : 0,
          },
        });
      }
    }

    src.setData({ type: "FeatureCollection", features });
  }, [map, mapLoaded, active, mode, ships, planes]);

  // ── Update Trail GeoJSON ───────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const src = map.getSource("playback-trail") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!active || !selectedEntity || trailPoints.length === 0) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const validPoints = trailPoints.filter(
      (p) => typeof p.lat === "number" && typeof p.lon === "number"
    );

    const coordinates = validPoints.map((p) => [p.lon, p.lat]);
    const features: GeoJSON.Feature[] = [];

    if (coordinates.length >= 2) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: { id: selectedEntity.id, label: selectedEntity.label },
      });
    }

    // Include points along trail
    for (const pt of validPoints) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [pt.lon, pt.lat] },
        properties: { ts: pt.ts },
      });
    }

    src.setData({ type: "FeatureCollection", features });
  }, [map, mapLoaded, active, selectedEntity, trailPoints]);

  return null;
}
