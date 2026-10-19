import type maplibregl from "maplibre-gl";

export type VisionMode =
  | "tactical"
  | "normal"
  | "crt"
  | "nvg"
  | "flir"
  | "anime"
  | "noir"
  | "snow"
  | "satellite";

export type FlirPalette = "whot" | "bhot" | "iron";

interface EntityStyle {
  /** Replaces every app-layer colour (icons, dots, tracks). Undefined keeps the original colours. */
  color?: string;
  halo?: string;
  haloWidth?: number;
}

export interface VisionModeConfig {
  id: VisionMode;
  label: string;
  short: string;
  hotkey: string;
  /** Use true-colour satellite imagery as the base instead of the dark vector style. */
  imagery: boolean;
  entity: EntityStyle;
  /** Accent used by the selector and HUD for this mode. */
  accent: string;
}

export const VISION_MODES: VisionModeConfig[] = [
  { id: "tactical", label: "Tactical", short: "TAC", hotkey: "1", imagery: false, entity: {}, accent: "#00e5ff" },
  { id: "normal", label: "Normal (optical)", short: "OPT", hotkey: "2", imagery: true, entity: { halo: "rgba(0,0,0,0.85)", haloWidth: 1.2 }, accent: "#e8f1ff" },
  { id: "crt", label: "CRT / Retro", short: "CRT", hotkey: "3", imagery: true, entity: { halo: "rgba(0,0,0,0.7)", haloWidth: 1 }, accent: "#ffb347" },
  { id: "nvg", label: "Night vision", short: "NVG", hotkey: "4", imagery: true, entity: { color: "#ffffff", halo: "rgba(255,255,255,0.55)", haloWidth: 1.6 }, accent: "#7dff6b" },
  { id: "flir", label: "FLIR thermal", short: "FLIR", hotkey: "5", imagery: true, entity: { color: "#ffff00", halo: "rgba(255,255,0,0.55)", haloWidth: 2 }, accent: "#f5f5f5" },
  { id: "anime", label: "Anime", short: "ANIME", hotkey: "6", imagery: true, entity: { color: "#fff6fb", halo: "#14081a", haloWidth: 2.6 }, accent: "#ff7ac6" },
  { id: "noir", label: "Noir", short: "NOIR", hotkey: "7", imagery: true, entity: { color: "#ffffff", halo: "rgba(0,0,0,0.9)", haloWidth: 1.4 }, accent: "#d9d9d9" },
  { id: "snow", label: "Snow", short: "SNOW", hotkey: "8", imagery: true, entity: { color: "#0a0f1c", halo: "rgba(255,255,255,0.9)", haloWidth: 1.2 }, accent: "#bfe3ff" },
  { id: "satellite", label: "Satellite recon", short: "SAT", hotkey: "9", imagery: true, entity: { halo: "rgba(0,0,0,0.85)", haloWidth: 1.2 }, accent: "#c8ffd9" },
];

export const VISION_BY_ID: Record<VisionMode, VisionModeConfig> = Object.fromEntries(
  VISION_MODES.map((m) => [m.id, m]),
) as Record<VisionMode, VisionModeConfig>;

/** CSS filter applied to the whole "world" stack (map, satellite canvas, Cesium 3D tiles + models). */
export function visionCssFilter(mode: VisionMode, flirPalette: FlirPalette): string {
  switch (mode) {
    case "tactical":
      return "none";
    case "normal":
      return "contrast(1.04) saturate(1.08)";
    case "flir":
      return `url(#vf-flir-${flirPalette})`;
    default:
      return `url(#vf-${mode})`;
  }
}

const IMAGERY_SRC = "vision-imagery";
const IMAGERY_LAYER = "vision-imagery-layer";
export const IMAGERY_ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics";

const PAINT_PROPS: Record<string, { color: string[]; halo?: [string, string] }> = {
  symbol: { color: ["icon-color", "text-color"], halo: ["icon-halo-color", "icon-halo-width"] },
  circle: { color: ["circle-color", "circle-stroke-color"] },
  line: { color: ["line-color"] },
  fill: { color: ["fill-color"] },
};

type OriginalPaint = Map<string, unknown>;
const originals = new WeakMap<maplibregl.Map, OriginalPaint>();

function remember(map: maplibregl.Map, layerId: string, prop: string) {
  let store = originals.get(map);
  if (!store) {
    store = new Map();
    originals.set(map, store);
  }
  const key = `${layerId}|${prop}`;
  if (!store.has(key)) store.set(key, map.getPaintProperty(layerId, prop));
  return store.get(key);
}

function setPaint(map: maplibregl.Map, layerId: string, prop: string, value: unknown) {
  try {
    map.setPaintProperty(layerId, prop, value as never);
  } catch {
    /* property not valid for this layer */
  }
}

function ensureImagery(map: maplibregl.Map, baseLayerIds: Set<string>) {
  if (!map.getSource(IMAGERY_SRC)) {
    map.addSource(IMAGERY_SRC, {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: IMAGERY_ATTRIBUTION,
    });
  }
  if (!map.getLayer(IMAGERY_LAYER)) {
    // Directly above the background; base fills/lines are hidden while imagery is on.
    const firstLabel = map
      .getStyle()
      .layers.find((l) => baseLayerIds.has(l.id) && l.type !== "background")?.id;
    map.addLayer(
      {
        id: IMAGERY_LAYER,
        type: "raster",
        source: IMAGERY_SRC,
        layout: { visibility: "none" },
        paint: { "raster-fade-duration": 200 },
      },
      firstLabel,
    );
  }
}

/** Applies a vision mode to the MapLibre map: base imagery + app-layer colour overrides. */
/** `isStyleLoaded()` stays false while tiles stream in; layers can be edited as soon as the style JSON exists. */
export function styleReady(map: maplibregl.Map): boolean {
  try {
    return Array.isArray(map.getStyle()?.layers);
  } catch {
    return false;
  }
}

export function applyVisionToMap(map: maplibregl.Map, mode: VisionMode, baseLayerIds: Set<string>) {
  if (!styleReady(map) || baseLayerIds.size === 0) return;
  const cfg = VISION_BY_ID[mode];
  ensureImagery(map, baseLayerIds);
  map.setLayoutProperty(IMAGERY_LAYER, "visibility", cfg.imagery ? "visible" : "none");

  for (const layer of map.getStyle().layers) {
    if (baseLayerIds.has(layer.id) || layer.id === IMAGERY_LAYER) {
      if (baseLayerIds.has(layer.id) && layer.type !== "symbol" && layer.type !== "background") {
        const keep = layer.type === "line" && /boundary|admin/.test(layer.id);
        const store = originals.get(map) ?? new Map<string, unknown>();
        originals.set(map, store);
        const key = `${layer.id}|visibility`;
        if (!store.has(key)) store.set(key, map.getLayoutProperty(layer.id, "visibility") ?? "visible");
        map.setLayoutProperty(layer.id, "visibility", cfg.imagery && !keep ? "none" : (store.get(key) as "visible" | "none"));
      }
      if (layer.type === "symbol" && baseLayerIds.has(layer.id)) {
        // Base labels need a dark halo to stay readable over imagery.
        const textColor = remember(map, layer.id, "text-color");
        const haloColor = remember(map, layer.id, "text-halo-color");
        const haloWidth = remember(map, layer.id, "text-halo-width");
        const haloBlur = remember(map, layer.id, "text-halo-blur");
        setPaint(map, layer.id, "text-color", cfg.imagery ? "rgba(255,255,255,0.88)" : textColor);
        setPaint(map, layer.id, "text-halo-color", cfg.imagery ? "rgba(0,0,0,0.55)" : haloColor);
        setPaint(map, layer.id, "text-halo-width", cfg.imagery ? 1 : haloWidth);
        setPaint(map, layer.id, "text-halo-blur", cfg.imagery ? 0.5 : haloBlur);
      }
      continue;
    }
    const props = PAINT_PROPS[layer.type];
    if (!props) continue;
    for (const prop of props.color) {
      const original = remember(map, layer.id, prop);
      setPaint(map, layer.id, prop, cfg.entity.color ?? original);
    }
    if (props.halo) {
      const [colorProp, widthProp] = props.halo;
      const oColor = remember(map, layer.id, colorProp);
      const oWidth = remember(map, layer.id, widthProp);
      setPaint(map, layer.id, colorProp, cfg.entity.halo ?? oColor);
      setPaint(map, layer.id, widthProp, cfg.entity.haloWidth ?? oWidth);
    }
  }
}

export const VISION_STORAGE_KEY = "worldview.vision";
