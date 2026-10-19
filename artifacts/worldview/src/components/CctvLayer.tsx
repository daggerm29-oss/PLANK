import { useEffect, useMemo } from "react";
import maplibregl from "maplibre-gl";
import { CCTV_SOURCE_COLORS, type CctvCamera, type CctvSourceId } from "../lib/cctv";

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  cameras: CctvCamera[];
  osmCameras: CctvCamera[];
  enabledSources: CctvSourceId[];
  visible: boolean;
  selectedId: string | null;
  onSelect: (camera: CctvCamera) => void;
}

const LIVE_SRC = "cctv-live";
const OSM_SRC = "cctv-osm";
const SEL_SRC = "cctv-selected";
const LAYERS = [
  "cctv-live-clusters", "cctv-live-halo", "cctv-live-dot",
  "cctv-osm-clusters", "cctv-osm-dot", "cctv-selected-ring",
];
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function toGeoJson(cameras: CctvCamera[], enabled: Set<CctvSourceId>): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const c of cameras) {
    if (!enabled.has(c.source)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: { id: c.id, source: c.source, color: CCTV_SOURCE_COLORS[c.source] ?? "#ffffff" },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Renders CCTV cameras as clustered MapLibre circle layers.
 * Live feeds (NYC, London, California, …) render as bright dots coloured per source;
 * OSM surveillance locations render as small orange dots. Click a dot to open the feed.
 */
export function CctvLayer({
  map, mapLoaded, cameras, osmCameras, enabledSources, visible, selectedId, onSelect,
}: Props) {
  const enabled = useMemo(() => new Set(enabledSources), [enabledSources]);
  const byId = useMemo(() => {
    const m = new Map<string, CctvCamera>();
    for (const c of cameras) m.set(c.id, c);
    for (const c of osmCameras) m.set(c.id, c);
    return m;
  }, [cameras, osmCameras]);

  // ── sources + layers (once per map instance) ────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;

    const clusterPaint = (color: string): maplibregl.CircleLayerSpecification["paint"] => ({
      "circle-color": color,
      "circle-opacity": 0.28,
      "circle-radius": ["step", ["get", "point_count"], 10, 25, 14, 100, 19, 500, 25],
      "circle-stroke-width": 1,
      "circle-stroke-color": color,
    });

    if (!map.getSource(LIVE_SRC)) {
      map.addSource(LIVE_SRC, { type: "geojson", data: EMPTY, cluster: true, clusterRadius: 42, clusterMaxZoom: 11 });
    }
    if (!map.getSource(OSM_SRC)) {
      map.addSource(OSM_SRC, { type: "geojson", data: EMPTY, cluster: true, clusterRadius: 40, clusterMaxZoom: 16 });
    }
    if (!map.getSource(SEL_SRC)) {
      map.addSource(SEL_SRC, { type: "geojson", data: EMPTY });
    }

    if (!map.getLayer("cctv-osm-clusters")) {
      map.addLayer({ id: "cctv-osm-clusters", type: "circle", source: OSM_SRC, filter: ["has", "point_count"], paint: clusterPaint("#fb923c") });
    }
    if (!map.getLayer("cctv-osm-dot")) {
      map.addLayer({
        id: "cctv-osm-dot", type: "circle", source: OSM_SRC, filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.2, 18, 5],
          "circle-color": "#fb923c", "circle-opacity": 0.85,
          "circle-stroke-width": 0.5, "circle-stroke-color": "rgba(0,0,0,0.6)",
        },
      });
    }
    if (!map.getLayer("cctv-live-clusters")) {
      map.addLayer({ id: "cctv-live-clusters", type: "circle", source: LIVE_SRC, filter: ["has", "point_count"], paint: clusterPaint("#00ffff") });
    }
    if (!map.getLayer("cctv-live-halo")) {
      map.addLayer({
        id: "cctv-live-halo", type: "circle", source: LIVE_SRC, filter: ["!", ["has", "point_count"]],
        paint: { "circle-radius": 9, "circle-color": ["get", "color"], "circle-opacity": 0.2, "circle-blur": 0.6 },
      });
    }
    if (!map.getLayer("cctv-live-dot")) {
      map.addLayer({
        id: "cctv-live-dot", type: "circle", source: LIVE_SRC, filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2.5, 12, 4.5, 18, 7],
          "circle-color": ["get", "color"], "circle-opacity": 0.95,
          "circle-stroke-width": 0.8, "circle-stroke-color": "rgba(0,0,0,0.6)",
        },
      });
    }
    if (!map.getLayer("cctv-selected-ring")) {
      map.addLayer({
        id: "cctv-selected-ring", type: "circle", source: SEL_SRC,
        paint: {
          "circle-radius": 12, "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 2, "circle-stroke-color": "#ffffff",
        },
      });
    }

    return () => {
      // A removed map has no style; its layers are already gone.
      if (!map.style) return;
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [LIVE_SRC, OSM_SRC, SEL_SRC]) if (map.getSource(id)) map.removeSource(id);
    };
  }, [map, mapLoaded]);

  // ── data ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(LIVE_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(toGeoJson(cameras, enabled));
  }, [map, mapLoaded, cameras, enabled]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(OSM_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(toGeoJson(osmCameras, enabled));
  }, [map, mapLoaded, osmCameras, enabled]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    const sel = selectedId ? byId.get(selectedId) : undefined;
    (map.getSource(SEL_SRC) as maplibregl.GeoJSONSource | undefined)?.setData(
      sel
        ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [sel.lon, sel.lat] }, properties: {} }] }
        : EMPTY,
    );
  }, [map, mapLoaded, selectedId, byId]);

  // ── visibility ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;
    for (const id of LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }, [map, mapLoaded, visible]);

  // ── interaction ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !mapLoaded) return;

    const pointLayers = ["cctv-live-dot", "cctv-osm-dot"];
    const clusterLayers: [string, string][] = [["cctv-live-clusters", LIVE_SRC], ["cctv-osm-clusters", OSM_SRC]];

    const onPoint = (e: maplibregl.MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const cam = id ? byId.get(id) : undefined;
      if (cam) onSelect(cam);
    };
    const pointer = () => { map.getCanvas().style.cursor = "pointer"; };
    const reset = () => { map.getCanvas().style.cursor = ""; };

    const clusterHandlers = clusterLayers.map(([layer, src]) => {
      const handler = async (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const source = map.getSource(src) as maplibregl.GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(f.properties?.cluster_id);
        map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: zoom + 0.5 });
      };
      map.on("click", layer, handler);
      map.on("mouseenter", layer, pointer);
      map.on("mouseleave", layer, reset);
      return [layer, handler] as const;
    });

    for (const l of pointLayers) {
      map.on("click", l, onPoint);
      map.on("mouseenter", l, pointer);
      map.on("mouseleave", l, reset);
    }

    return () => {
      for (const l of pointLayers) {
        map.off("click", l, onPoint);
        map.off("mouseenter", l, pointer);
        map.off("mouseleave", l, reset);
      }
      for (const [layer, handler] of clusterHandlers) {
        map.off("click", layer, handler);
        map.off("mouseenter", layer, pointer);
        map.off("mouseleave", layer, reset);
      }
    };
  }, [map, mapLoaded, byId, onSelect]);

  return null;
}
