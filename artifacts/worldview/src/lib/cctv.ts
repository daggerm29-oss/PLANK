export type CameraKind = "image" | "hls" | "video" | "location";

export type CctvSourceId = "nyc" | "tfl" | "caltrans" | "maryland" | "florida" | "oregon" | "singapore" | "austin" | "windy" | "osm";

/** Mirrors `Camera` in artifacts/api-server/src/routes/cctv.ts */
export interface CctvCamera {
  id: string;
  source: CctvSourceId;
  name: string;
  lat: number;
  lon: number;
  kind: CameraKind;
  area?: string;
  direction?: string;
  imageUrl?: string;
  hlsUrl?: string;
  videoUrl?: string;
  refreshSec?: number;
}

/** Mirrors the `/api/proxy/cctv/sources` response entries. */
export interface CctvSourceInfo {
  id: CctvSourceId;
  label: string;
  region: string;
  color: string;
  kind: CameraKind;
  attribution: string;
  homepage: string;
  requiresKey?: string;
  count: number | null;
  error: string | null;
  enabled: boolean;
}

export const CCTV_SOURCE_COLORS: Record<CctvSourceId, string> = {
  nyc: "#00e5ff",
  tfl: "#ff3b6b",
  caltrans: "#ffd60a",
  maryland: "#f97316",
  florida: "#2dd4bf",
  oregon: "#a3e635",
  singapore: "#34d399",
  austin: "#c084fc",
  windy: "#60a5fa",
  osm: "#fb923c",
};

export const apiBase = (): string => import.meta.env.BASE_URL.replace(/\/$/, "");

/** Still images go through the allow-listed proxy so they work over HTTPS and never hotlink the DOT. */
export const frameUrl = (cameraId: string, bust: number): string =>
  `${apiBase()}/api/proxy/cctv/frame?id=${encodeURIComponent(cameraId)}&t=${bust}`;

export const proxiedImage = (url: string, bust?: number): string =>
  `${apiBase()}/api/proxy/cctv/image?url=${encodeURIComponent(url)}${bust ? `&t=${bust}` : ""}`;
