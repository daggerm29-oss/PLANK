import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";

/**
 * CCTV / OSINT camera aggregation.
 *
 * Same architecture as the rest of /api/proxy/*: the browser never talks to
 * third-party feeds directly. This router fetches, normalises and caches every
 * source in memory, and exposes:
 *
 *   GET /api/proxy/cctv/sources            -> source catalogue + live counts
 *   GET /api/proxy/cctv/cameras?sources=a,b -> normalised cameras (live feeds)
 *   GET /api/proxy/cctv/osm?s=&w=&n=&e=    -> OpenStreetMap camera *locations* in a bbox
 *   GET /api/proxy/cctv/image?url=         -> allow-listed image proxy (no mixed content / hotlink issues)
 *
 * Every source below is public and key-free, except Windy (optional, WINDY_API_KEY).
 * Only officially published public feeds are used. Private/unsecured IP cameras
 * (Insecam, Shodan, etc.) are intentionally NOT included.
 */

const router = Router();

export type CameraKind = "image" | "hls" | "video" | "location";

export interface Camera {
  id: string;
  source: SourceId;
  name: string;
  lat: number;
  lon: number;
  kind: CameraKind;
  area?: string;
  direction?: string;
  imageUrl?: string;
  hlsUrl?: string;
  videoUrl?: string;
  /** Suggested client refresh interval for still-image feeds, in seconds. */
  refreshSec?: number;
}

export type SourceId = "nyc" | "tfl" | "caltrans" | "maryland" | "florida" | "oregon" | "singapore" | "austin" | "windy" | "osm";

interface SourceMeta {
  id: SourceId;
  label: string;
  region: string;
  color: string;
  kind: CameraKind;
  attribution: string;
  homepage: string;
  requiresKey?: string;
}

export const SOURCES: Record<SourceId, SourceMeta> = {
  nyc: { id: "nyc", label: "NYC DOT", region: "New York City, US", color: "#00e5ff", kind: "image", attribution: "NYC DOT Traffic Management Center", homepage: "https://webcams.nyctmc.org" },
  tfl: { id: "tfl", label: "TfL JamCams", region: "London, UK", color: "#ff3b6b", kind: "video", attribution: "Transport for London (Open Government Licence)", homepage: "https://api.tfl.gov.uk" },
  caltrans: { id: "caltrans", label: "Caltrans CCTV", region: "California, US", color: "#ffd60a", kind: "hls", attribution: "California DOT (CWWP)", homepage: "https://cwwp2.dot.ca.gov" },
  maryland: { id: "maryland", label: "Maryland CHART", region: "Maryland, US", color: "#f97316", kind: "hls", attribution: "Maryland DOT SHA CHART", homepage: "https://chart.maryland.gov" },
  florida: { id: "florida", label: "Florida FL511", region: "Florida, US", color: "#2dd4bf", kind: "image", attribution: "Florida DOT (FL511)", homepage: "https://fl511.com" },
  oregon: { id: "oregon", label: "Oregon TripCheck", region: "Oregon, US", color: "#a3e635", kind: "image", attribution: "Oregon DOT (TripCheck)", homepage: "https://tripcheck.com" },
  singapore: { id: "singapore", label: "LTA Traffic Images", region: "Singapore", color: "#34d399", kind: "image", attribution: "LTA via data.gov.sg (Singapore Open Data Licence)", homepage: "https://data.gov.sg" },
  austin: { id: "austin", label: "Austin Mobility", region: "Austin, US", color: "#c084fc", kind: "image", attribution: "City of Austin Open Data", homepage: "https://data.austintexas.gov" },
  windy: { id: "windy", label: "Windy Webcams", region: "Worldwide", color: "#60a5fa", kind: "image", attribution: "Webcams provided by windy.com", homepage: "https://api.windy.com/webcams", requiresKey: "WINDY_API_KEY" },
  osm: { id: "osm", label: "OSM Surveillance", region: "Worldwide (locations only)", color: "#fb923c", kind: "location", attribution: "© OpenStreetMap contributors (ODbL)", homepage: "https://wiki.openstreetmap.org/wiki/Tag:man_made%3Dsurveillance" },
};

const LIVE_SOURCES: SourceId[] = ["nyc", "tfl", "caltrans", "maryland", "florida", "oregon", "singapore", "austin", "windy"];

const UA = "sky7-worldview/1.0 (open-source OSINT map; contact via GitHub)";
const FETCH_TIMEOUT_MS = 25_000;
const TTL_MS = 10 * 60 * 1000;

const logError = (req: any, data: unknown, msg: string) => {
  if (req.log?.error) req.log.error(data, msg);
  else console.error(msg, data);
};

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const validCoord = (lat: number | null, lon: number | null): lat is number =>
  lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

// ──────────────────────────────────────────────────────────────────────────────
// Source fetchers — each returns normalised Camera[]
// ──────────────────────────────────────────────────────────────────────────────

async function fetchNyc(): Promise<Camera[]> {
  const rows = await getJson<any[]>("https://webcams.nyctmc.org/api/cameras");
  const out: Camera[] = [];
  for (const c of rows) {
    const lat = num(c.latitude), lon = num(c.longitude);
    if (!validCoord(lat, lon) || String(c.isOnline) === "false") continue;
    out.push({
      id: `nyc:${c.id}`, source: "nyc", name: c.name, lat, lon: lon as number, kind: "image",
      area: c.area, imageUrl: c.imageUrl ?? `https://webcams.nyctmc.org/api/cameras/${c.id}/image`, refreshSec: 3,
    });
  }
  return out;
}

async function fetchTfl(): Promise<Camera[]> {
  const rows = await getJson<any[]>("https://api.tfl.gov.uk/Place/Type/JamCam");
  const out: Camera[] = [];
  for (const c of rows) {
    const props: Record<string, string> = {};
    for (const p of c.additionalProperties ?? []) props[p.key] = p.value;
    if (props.available === "false") continue;
    const lat = num(c.lat), lon = num(c.lon);
    if (!validCoord(lat, lon)) continue;
    out.push({
      id: `tfl:${c.id}`, source: "tfl", name: c.commonName, lat, lon: lon as number, kind: props.videoUrl ? "video" : "image",
      area: "London", direction: props.view, imageUrl: props.imageUrl, videoUrl: props.videoUrl, refreshSec: 30,
    });
  }
  return out;
}

async function fetchCaltrans(): Promise<Camera[]> {
  const districts = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
  const results = await Promise.allSettled(
    districts.map((d) => getJson<{ data: any[] }>(`https://cwwp2.dot.ca.gov/data/d${Number(d)}/cctv/cctvStatusD${d}.json`)),
  );
  const out: Camera[] = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    for (const row of r.value.data ?? []) {
      const c = row.cctv;
      if (!c || c.inService === "false") continue;
      const lat = num(c.location?.latitude), lon = num(c.location?.longitude);
      if (!validCoord(lat, lon)) continue;
      const img = c.imageData?.static?.currentImageURL || undefined;
      const hls = c.imageData?.streamingVideoURL || undefined;
      if (!img && !hls) continue;
      out.push({
        id: `caltrans:${districts[i]}:${c.index}`, source: "caltrans", name: c.location.locationName,
        lat, lon: lon as number, kind: hls ? "hls" : "image",
        area: c.location.nearbyPlace || c.location.county, direction: c.location.direction || undefined,
        imageUrl: img, hlsUrl: hls, refreshSec: 60,
      });
    }
  });
  return out;
}

async function fetchSingapore(): Promise<Camera[]> {
  const j = await getJson<{ items: { cameras: any[] }[] }>("https://api.data.gov.sg/v1/transport/traffic-images");
  const out: Camera[] = [];
  for (const c of j.items?.[0]?.cameras ?? []) {
    const lat = num(c.location?.latitude), lon = num(c.location?.longitude);
    if (!validCoord(lat, lon)) continue;
    out.push({
      id: `singapore:${c.camera_id}`, source: "singapore", name: `Singapore Camera ${c.camera_id}`,
      lat, lon: lon as number, kind: "image", area: "Singapore", imageUrl: c.image, refreshSec: 20,
    });
  }
  return out;
}

async function fetchAustin(): Promise<Camera[]> {
  const rows = await getJson<any[]>(
    "https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=2000&camera_status=TURNED_ON",
  );
  const out: Camera[] = [];
  for (const c of rows) {
    const [lon, lat] = c.location?.coordinates ?? [];
    if (!validCoord(num(lat), num(lon)) || !c.screenshot_address) continue;
    out.push({
      id: `austin:${c.camera_id}`, source: "austin", name: String(c.location_name ?? `Camera ${c.camera_id}`).trim(),
      lat, lon, kind: "image", area: "Austin, TX", imageUrl: c.screenshot_address, refreshSec: 15,
    });
  }
  return out;
}

/** Windy v3 returns max 50 per call, so page through the globe by continent-sized bboxes. */
async function fetchWindy(): Promise<Camera[]> {
  const key = process.env.WINDY_API_KEY;
  if (!key) return [];
  const out: Camera[] = [];
  const seen = new Set<number>();
  // [north, east, south, west]
  const tiles = [
    [72, -30, 15, -170], [72, 60, 35, -30], [35, 60, -40, -30], [15, -30, -60, -170],
    [72, 180, 5, 60], [5, 180, -50, 60],
  ];
  for (const [n, e, s, w] of tiles) {
    for (let offset = 0; offset < 200; offset += 50) {
      try {
        const j = await getJson<{ webcams: any[] }>(
          `https://api.windy.com/webcams/api/v3/webcams?bbox=${n},${e},${s},${w}&limit=50&offset=${offset}&include=location,images,player`,
          { headers: { "x-windy-api-key": key } },
        );
        if (!j.webcams?.length) break;
        for (const c of j.webcams) {
          if (seen.has(c.webcamId)) continue;
          seen.add(c.webcamId);
          const lat = num(c.location?.latitude), lon = num(c.location?.longitude);
          if (!validCoord(lat, lon)) continue;
          out.push({
            id: `windy:${c.webcamId}`, source: "windy", name: c.title, lat, lon: lon as number, kind: "image",
            area: [c.location?.city, c.location?.country].filter(Boolean).join(", "),
            imageUrl: c.images?.current?.preview ?? c.images?.current?.thumbnail, refreshSec: 300,
          });
        }
        if (j.webcams.length < 50) break;
      } catch {
        break;
      }
    }
  }
  return out;
}

/** Maryland CHART: genuinely live HLS (open CORS, no token). */
async function fetchMaryland(): Promise<Camera[]> {
  const rows = await getJson<any[]>("https://chart.maryland.gov/DataFeeds/GetCamerasJSON");
  const out: Camera[] = [];
  for (const c of rows) {
    const lat = num(c.lat), lon = num(c.lon);
    if (!validCoord(lat, lon) || c.commMode !== "ONLINE" || !c.cctvIp || !c.id) continue;
    out.push({
      id: `maryland:${c.id}`, source: "maryland", name: String(c.name ?? c.description ?? c.id).trim(), lat, lon: lon as number,
      kind: "hls", area: Array.isArray(c.cameraCategories) ? c.cameraCategories[0] : undefined,
      hlsUrl: `https://${c.cctvIp}/rtplive/${c.id}/playlist.m3u8`,
    });
  }
  return out;
}

/** Florida FL511: the catalogue pages at 100 rows; video needs a login, so we use the snapshot image. */
async function fetchFlorida(): Promise<Camera[]> {
  const PAGE = 100;
  const page = (start: number) =>
    getJson<{ recordsTotal: number; data: any[] }>(
      `https://fl511.com/List/GetData/Cameras?query=${encodeURIComponent(JSON.stringify({ columns: [], start, length: PAGE }))}&lang=en-US`,
    );
  const first = await page(0);
  const rows = [...first.data];
  const starts: number[] = [];
  for (let s = PAGE; s < first.recordsTotal; s += PAGE) starts.push(s);
  for (let i = 0; i < starts.length; i += 6) {
    const batch = await Promise.allSettled(starts.slice(i, i + 6).map(page));
    for (const b of batch) if (b.status === "fulfilled") rows.push(...b.value.data);
  }
  const out: Camera[] = [];
  const seen = new Set<string>();
  for (const c of rows) {
    const img = (c.images ?? []).find((i: any) => !i.disabled && !i.blocked && i.imageUrl);
    const m = /POINT \((-?[\d.]+) (-?[\d.]+)\)/.exec(c.latLng?.geography?.wellKnownText ?? "");
    if (!img || !m || c.visible === false || seen.has(String(c.id))) continue;
    const lat = num(m[2]), lon = num(m[1]);
    if (!validCoord(lat, lon)) continue;
    seen.add(String(c.id));
    out.push({
      id: `florida:${c.id}`, source: "florida", name: String(c.location ?? c.roadway ?? `Camera ${c.id}`).replace(/_/g, " "),
      lat, lon: lon as number, kind: "image", area: c.county ? `${c.county} County` : c.region,
      direction: [c.roadway, c.direction].filter(Boolean).join(" "),
      imageUrl: `https://fl511.com${img.imageUrl}`, refreshSec: 10,
    });
  }
  return out;
}

/** Oregon TripCheck: ArcGIS-style inventory of still cameras. */
async function fetchOregon(): Promise<Camera[]> {
  const j = await getJson<{ features: { attributes: any }[] }>("https://tripcheck.com/Scripts/map/data/cctvinventory.js", { headers: { Accept: "*/*" } });
  const out: Camera[] = [];
  for (const f of j.features ?? []) {
    const a = f.attributes;
    const lat = num(a.latitude), lon = num(a.longitude);
    if (!validCoord(lat, lon) || !a.filename) continue;
    out.push({
      id: `oregon:${a.cameraId}`, source: "oregon", name: String(a.title ?? `Camera ${a.cameraId}`).trim(), lat, lon: lon as number,
      kind: "image", area: "Oregon", direction: String(a.route ?? "").trim() || undefined,
      imageUrl: `https://tripcheck.com/RoadCams/cams/${a.filename}`, refreshSec: 120,
    });
  }
  return out;
}

const FETCHERS: Record<Exclude<SourceId, "osm">, () => Promise<Camera[]>> = {
  nyc: fetchNyc, tfl: fetchTfl, caltrans: fetchCaltrans, maryland: fetchMaryland, florida: fetchFlorida, oregon: fetchOregon,
  singapore: fetchSingapore, austin: fetchAustin, windy: fetchWindy,
};

// ──────────────────────────────────────────────────────────────────────────────
// In-memory cache with in-flight de-duplication and stale-on-error
// ──────────────────────────────────────────────────────────────────────────────

interface CacheEntry { at: number; data: Camera[]; error?: string; inflight?: Promise<Camera[]> }
const cache = new Map<SourceId, CacheEntry>();

async function loadSource(id: Exclude<SourceId, "osm">): Promise<{ cameras: Camera[]; error?: string }> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS && !hit.inflight) return { cameras: hit.data, error: hit.error };
  if (hit?.inflight) {
    const cameras = await hit.inflight.catch(() => hit.data);
    return { cameras, error: cache.get(id)?.error };
  }
  const entry: CacheEntry = hit ?? { at: 0, data: [] };
  entry.inflight = FETCHERS[id]()
    .then((data) => { entry.data = data; entry.error = undefined; return data; })
    .catch((err) => { entry.error = String(err?.message ?? err); return entry.data; })
    .finally(() => { entry.at = Date.now(); entry.inflight = undefined; });
  cache.set(id, entry);
  const cameras = await entry.inflight;
  return { cameras, error: entry.error };
}

const parseSources = (raw: unknown): Exclude<SourceId, "osm">[] => {
  const asked = typeof raw === "string" && raw.trim() ? raw.split(",").map((s) => s.trim()) : LIVE_SOURCES;
  return LIVE_SOURCES.filter((s) => asked.includes(s)) as Exclude<SourceId, "osm">[];
};

router.get("/proxy/cctv/sources", async (_req: Request, res: Response) => {
  const counts = await Promise.all(
    LIVE_SOURCES.map(async (id) => {
      const { cameras, error } = await loadSource(id as Exclude<SourceId, "osm">);
      return { ...SOURCES[id], count: cameras.length, error: error ?? null, enabled: !SOURCES[id].requiresKey || !!process.env[SOURCES[id].requiresKey!] };
    }),
  );
  res.set("Cache-Control", "public, max-age=60");
  res.json([...counts, { ...SOURCES.osm, count: null, error: null, enabled: true }]);
});

router.get("/proxy/cctv/cameras", async (req: Request, res: Response) => {
  try {
    const ids = parseSources(req.query.sources);
    const loaded = await Promise.all(ids.map((id) => loadSource(id)));
    const errors: Record<string, string> = {};
    loaded.forEach((l, i) => { if (l.error) errors[ids[i]] = l.error; });
    res.set("Cache-Control", "public, max-age=120");
    res.json({ cameras: loaded.flatMap((l) => l.cameras), errors, updatedAt: Date.now() });
  } catch (err) {
    logError(req, err, "cctv cameras failed");
    res.status(502).json({ cameras: [], errors: { all: "upstream failure" } });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// OpenStreetMap surveillance cameras (locations only) via Overpass
// ──────────────────────────────────────────────────────────────────────────────

const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const osmCache = new Map<string, { at: number; data: Camera[] }>();
const OSM_TTL_MS = 30 * 60 * 1000;
const OSM_MAX_SPAN_DEG = 0.6;

router.get("/proxy/cctv/osm", async (req: Request, res: Response) => {
  const s = num(req.query.s), w = num(req.query.w), n = num(req.query.n), e = num(req.query.e);
  if (s === null || w === null || n === null || e === null || n <= s || e <= w) {
    res.status(400).json({ error: "s,w,n,e bbox required" });
    return;
  }
  if (n - s > OSM_MAX_SPAN_DEG || e - w > OSM_MAX_SPAN_DEG) {
    res.status(413).json({ error: "bbox too large — zoom in", maxSpanDeg: OSM_MAX_SPAN_DEG });
    return;
  }
  // Snap to a 0.05° grid so nearby viewports share a cache entry.
  const g = (v: number, f: (x: number) => number) => f(v / 0.05) * 0.05;
  const bs = g(s, Math.floor), bw = g(w, Math.floor), bn = g(n, Math.ceil), be = g(e, Math.ceil);
  const key = [bs, bw, bn, be].map((v) => v.toFixed(2)).join(",");
  const hit = osmCache.get(key);
  if (hit && Date.now() - hit.at < OSM_TTL_MS) {
    res.json({ cameras: hit.data });
    return;
  }
  const query = `[out:json][timeout:25];node["man_made"="surveillance"]["surveillance:type"="camera"](${bs},${bw},${bn},${be});out 2000;`;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const j = await getJson<{ elements: any[] }>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*" },
        body: new URLSearchParams({ data: query }).toString(),
      });
      const cameras: Camera[] = (j.elements ?? []).map((el) => ({
        id: `osm:${el.id}`, source: "osm" as const, kind: "location" as const,
        name: el.tags?.name || el.tags?.description || `${el.tags?.surveillance ? String(el.tags.surveillance)[0].toUpperCase() + String(el.tags.surveillance).slice(1) : "Surveillance"} camera`,
        lat: el.lat, lon: el.lon,
        area: [el.tags?.["camera:type"], el.tags?.["camera:mount"], el.tags?.operator].filter(Boolean).join(" · ") || undefined,
        direction: el.tags?.["camera:direction"],
      }));
      osmCache.set(key, { at: Date.now(), data: cameras });
      if (osmCache.size > 400) osmCache.delete(osmCache.keys().next().value as string);
      res.json({ cameras });
      return;
    } catch (err) {
      logError(req, err, `overpass ${endpoint} failed`);
    }
  }
  res.status(502).json({ error: "Overpass unavailable", cameras: [] });
});

// ──────────────────────────────────────────────────────────────────────────────
// Image proxy (allow-listed hosts only — prevents SSRF / open proxy abuse)
// ──────────────────────────────────────────────────────────────────────────────

const IMAGE_HOSTS = [
  "webcams.nyctmc.org",
  "cwwp2.dot.ca.gov",
  "images.data.gov.sg",
  "cctv.austinmobility.io",
  "fl511.com",
  "tripcheck.com",
  "s3-eu-west-1.amazonaws.com",
  "images-webcams.windy.com",
  "webcams.windy.com",
];

/** Some hosts (e.g. images.data.gov.sg) serve JPEGs as application/octet-stream, so trust the bytes. */
function sniffImageType(buf: Buffer, declared: string): string | undefined {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 4 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length > 3 && buf.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return declared.startsWith("image/") ? declared : undefined;
}

router.get("/proxy/cctv/image", async (req: Request, res: Response) => {
  let target: URL;
  try {
    target = new URL(String(req.query.url ?? ""));
  } catch {
    res.status(400).json({ error: "invalid url" });
    return;
  }
  const hostOk = IMAGE_HOSTS.some((h) => target.hostname === h || target.hostname.endsWith(`.${h}`));
  if (target.protocol !== "https:" || !hostOk) {
    res.status(403).json({ error: "host not allowed" });
    return;
  }
  try {
    const upstream = await fetch(target, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    const body = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.ok ? sniffImageType(body, upstream.headers.get("content-type") ?? "") : undefined;
    if (!type) {
      res.status(502).json({ error: `upstream ${upstream.status}` });
      return;
    }
    res.set("Content-Type", type);
    res.set("Cache-Control", "public, max-age=2");
    res.send(body);
  } catch (err) {
    logError(req, err, "cctv image proxy failed");
    res.status(502).json({ error: "image fetch failed" });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Per-camera "latest frame" endpoint (1 Hz friendly)
//
// The catalogue is cached for 10 min, but some upstream image URLs are signed and
// expire within minutes (Singapore). Resolving the URL here, per request, keeps
// feeds from going stale. A ~1 s micro-cache + in-flight de-duplication means many
// viewers of the same camera still cost the upstream at most one request/second.
// ──────────────────────────────────────────────────────────────────────────────

const FRAME_TTL_MS = 900;
const SG_URL_TTL_MS = 5_000;

interface FrameEntry { at: number; buf?: Buffer; type?: string; hash?: string; inflight?: Promise<void> }
const frames = new Map<string, FrameEntry>();

const sgUrls = { at: 0, map: new Map<string, string>(), inflight: undefined as Promise<void> | undefined };

async function freshSingaporeUrl(cameraId: string): Promise<string | undefined> {
  if (Date.now() - sgUrls.at > SG_URL_TTL_MS) {
    sgUrls.inflight ??= getJson<{ items: { cameras: any[] }[] }>("https://api.data.gov.sg/v1/transport/traffic-images")
      .then((j) => {
        sgUrls.map = new Map((j.items?.[0]?.cameras ?? []).map((c) => [String(c.camera_id), String(c.image)]));
        sgUrls.at = Date.now();
      })
      .catch(() => { sgUrls.at = Date.now() - SG_URL_TTL_MS + 1_000; })
      .finally(() => { sgUrls.inflight = undefined; });
    await sgUrls.inflight;
  } else if (sgUrls.inflight) {
    await sgUrls.inflight;
  }
  return sgUrls.map.get(cameraId);
}

async function resolveFrameUrl(id: string): Promise<string | undefined> {
  const [source, ...rest] = id.split(":");
  const cameraId = rest.join(":");
  if (!source || !cameraId || !(LIVE_SOURCES as string[]).includes(source)) return undefined;
  if (source === "singapore") {
    const fresh = await freshSingaporeUrl(cameraId);
    if (fresh) return fresh;
  }
  const { cameras } = await loadSource(source as Exclude<SourceId, "osm">);
  return cameras.find((c) => c.id === id)?.imageUrl;
}

router.get("/proxy/cctv/frame", async (req: Request, res: Response) => {
  const id = String(req.query.id ?? "");
  try {
    let entry = frames.get(id);
    if (!entry || (Date.now() - entry.at >= FRAME_TTL_MS && !entry.inflight)) {
      const target = await resolveFrameUrl(id);
      if (!target) {
        res.status(404).json({ error: "unknown camera" });
        return;
      }
      const url = new URL(target);
      const hostOk = IMAGE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
      if (url.protocol !== "https:" || !hostOk) {
        res.status(403).json({ error: "host not allowed" });
        return;
      }
      entry = entry ?? { at: 0 };
      const current = entry;
      current.inflight = (async () => {
        const upstream = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8_000) });
        if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
        const buf = Buffer.from(await upstream.arrayBuffer());
        const type = sniffImageType(buf, upstream.headers.get("content-type") ?? "");
        if (!type) throw new Error("upstream returned a non-image");
        current.buf = buf;
        current.type = type;
        current.hash = createHash("sha1").update(buf).digest("hex").slice(0, 12);
        current.at = Date.now();
      })().finally(() => { current.inflight = undefined; });
      frames.set(id, current);
      if (frames.size > 600) frames.delete(frames.keys().next().value as string);
    }
    if (entry.inflight) await entry.inflight;
    if (!entry.buf) {
      res.status(502).json({ error: "no frame" });
      return;
    }
    res.set({
      "Content-Type": entry.type ?? "image/jpeg",
      "Cache-Control": "no-store",
      "X-Frame-Hash": entry.hash ?? "",
      "X-Frame-At": String(entry.at),
      "Access-Control-Expose-Headers": "X-Frame-Hash, X-Frame-At",
    });
    res.send(entry.buf);
  } catch (err) {
    logError(req, err, "cctv frame failed");
    // Serve the last good frame rather than flashing "offline" on a transient upstream error.
    const stale = frames.get(id);
    if (stale?.buf) {
      res.set({ "Content-Type": stale.type ?? "image/jpeg", "Cache-Control": "no-store", "X-Frame-Hash": stale.hash ?? "", "X-Frame-At": String(stale.at), "Access-Control-Expose-Headers": "X-Frame-Hash, X-Frame-At" });
      res.send(stale.buf);
      return;
    }
    res.status(502).json({ error: "frame fetch failed" });
  }
});

export default router;
