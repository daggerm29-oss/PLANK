import { useEffect, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { apiBase, type CctvCamera, type CctvSourceInfo } from "../lib/cctv";

const REFRESH_MS = 10 * 60 * 1000;
const OSM_MIN_ZOOM = 12;
const OSM_DEBOUNCE_MS = 700;

interface Options {
  /** Fetch live feeds only once the CCTV panel has been opened at least once. */
  active: boolean;
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  osmEnabled: boolean;
}

export type OsmStatus = "off" | "zoom-in" | "loading" | "ready" | "error";

/**
 * Loads the aggregated live-camera catalogue (all sources, refreshed every 10 min)
 * and, when enabled, OpenStreetMap camera *locations* for the current viewport.
 */
export function useCctv({ active, map, mapLoaded, osmEnabled }: Options) {
  const [cameras, setCameras] = useState<CctvCamera[]>([]);
  const [sources, setSources] = useState<CctvSourceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [osmCameras, setOsmCameras] = useState<CctvCamera[]>([]);
  const [osmStatus, setOsmStatus] = useState<OsmStatus>("off");
  const osmById = useRef<Map<string, CctvCamera>>(new Map());

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const base = apiBase();

    const load = async () => {
      setLoading(true);
      try {
        const [camRes, srcRes] = await Promise.all([
          fetch(`${base}/api/proxy/cctv/cameras`),
          fetch(`${base}/api/proxy/cctv/sources`),
        ]);
        if (!camRes.ok) throw new Error(`cameras HTTP ${camRes.status}`);
        const cam = (await camRes.json()) as { cameras: CctvCamera[] };
        const src = srcRes.ok ? ((await srcRes.json()) as CctvSourceInfo[]) : [];
        if (cancelled) return;
        setCameras(cam.cameras ?? []);
        setSources(src);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "CCTV feed unavailable");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active]);

  useEffect(() => {
    if (!map || !mapLoaded || !osmEnabled) {
      setOsmStatus("off");
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const scan = async () => {
      if (map.getZoom() < OSM_MIN_ZOOM) {
        setOsmStatus("zoom-in");
        return;
      }
      const b = map.getBounds();
      const qs = new URLSearchParams({
        s: String(b.getSouth()),
        w: String(b.getWest()),
        n: String(b.getNorth()),
        e: String(b.getEast()),
      });
      controller?.abort();
      controller = new AbortController();
      setOsmStatus("loading");
      try {
        const res = await fetch(`${apiBase()}/api/proxy/cctv/osm?${qs}`, { signal: controller.signal });
        if (res.status === 413) {
          setOsmStatus("zoom-in");
          return;
        }
        if (!res.ok) throw new Error(`osm HTTP ${res.status}`);
        const j = (await res.json()) as { cameras: CctvCamera[] };
        for (const c of j.cameras) osmById.current.set(c.id, c);
        setOsmCameras(Array.from(osmById.current.values()));
        setOsmStatus("ready");
      } catch (err) {
        if ((err as Error).name !== "AbortError") setOsmStatus("error");
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(scan, OSM_DEBOUNCE_MS);
    };

    schedule();
    map.on("moveend", schedule);
    return () => {
      clearTimeout(timer);
      controller?.abort();
      map.off("moveend", schedule);
    };
  }, [map, mapLoaded, osmEnabled]);

  return { cameras, sources, loading, error, osmCameras, osmStatus };
}
