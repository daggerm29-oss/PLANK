import { Router, Request, Response } from "express";

const router = Router();

const logError = (req: any, data: unknown, msg: string) => {
  if (req.log?.error) {
    req.log.error(data, msg);
  } else {
    console.error(msg, data);
  }
};

const ADSB_BASE = "https://api.adsb.lol/v2";

const FALLBACK_MIL_AIRCRAFT = [
  { hex: "ae0582", flight: "RCH822  ", r: "87-0037", t: "C5M", dbFlags: 1, lat: 34.82, lon: 32.55, alt_baro: 36000, gs: 460, track: 312, category: "A5", seen: 0.8 },
  { hex: "ae1458", flight: "RCH458  ", r: "06-6154", t: "C17", dbFlags: 1, lat: 26.21, lon: 127.65, alt_baro: 28000, gs: 440, track: 85, category: "A5", seen: 1.2 },
  { hex: "ae04cb", flight: "PEACH41 ", r: "61-0318", t: "K35R", dbFlags: 1, lat: 44.98, lon: 24.74, alt_baro: 24000, gs: 395, track: 140, category: "A5", seen: 0.5 },
  { hex: "ae12a2", flight: "HOMER61 ", r: "64-14842", t: "RC135", dbFlags: 1, lat: 54.85, lon: 19.45, alt_baro: 33000, gs: 410, track: 72, category: "A5", seen: 0.9 },
  { hex: "ae01d5", flight: "SNTRY21 ", r: "77-0351", t: "E3TF", dbFlags: 1, lat: 36.12, lon: 29.80, alt_baro: 31000, gs: 380, track: 255, category: "A5", seen: 0.4 },
  { hex: "ae5e12", flight: "FLYER63 ", r: "17-46037", t: "B762", dbFlags: 1, lat: 26.42, lon: 52.61, alt_baro: 26000, gs: 425, track: 110, category: "A5", seen: 1.1 },
  { hex: "3b7764", flight: "CTM1435 ", r: "F-RBAO", t: "A400", dbFlags: 1, lat: 42.42, lon: 11.30, alt_baro: 29000, gs: 415, track: 180, category: "A5", seen: 0.6 },
  { hex: "43c6f2", flight: "RRR7221 ", r: "ZZ330", t: "A332", dbFlags: 1, lat: 50.15, lon: -1.25, alt_baro: 22000, gs: 370, track: 220, category: "A5", seen: 1.0 },
  { hex: "3eb9ae", flight: "GAF662  ", r: "54+21", t: "A400", dbFlags: 1, lat: 49.31, lon: 8.82, alt_baro: 21000, gs: 360, track: 345, category: "A5", seen: 0.7 },
  { hex: "ae036a", flight: "QUID72  ", r: "63-7985", t: "K35R", dbFlags: 1, lat: 24.71, lon: 54.92, alt_baro: 27000, gs: 430, track: 96, category: "A5", seen: 0.3 },
  { hex: "48d826", flight: "PLF206  ", r: "0206", t: "M28", dbFlags: 1, lat: 52.88, lon: 17.48, alt_baro: 10000, gs: 180, track: 45, category: "A2", seen: 1.4 },
  { hex: "342693", flight: "JASON41 ", r: "T.21-12", t: "C295", dbFlags: 1, lat: 38.40, lon: 0.72, alt_baro: 13800, gs: 240, track: 260, category: "A3", seen: 1.5 }
];

const FALLBACK_GLOBAL_AIRCRAFT = [
  ...FALLBACK_MIL_AIRCRAFT,
  { hex: "a12bc3", flight: "AAL102  ", r: "N123AA", t: "B772", dbFlags: 0, lat: 40.64, lon: -73.78, alt_baro: 33000, gs: 490, track: 82, category: "A3", seen: 0.4 },
  { hex: "400ab1", flight: "BAW178  ", r: "G-ZBKB", t: "B789", dbFlags: 0, lat: 51.47, lon: -0.45, alt_baro: 37000, gs: 510, track: 265, category: "A3", seen: 0.5 },
  { hex: "3c65a4", flight: "DLH400  ", r: "D-ABYM", t: "B748", dbFlags: 0, lat: 50.03, lon: 8.57, alt_baro: 35000, gs: 485, track: 280, category: "A3", seen: 0.6 },
  { hex: "76ce81", flight: "SIA321  ", r: "9V-SMC", t: "A359", dbFlags: 0, lat: 1.36, lon: 103.99, alt_baro: 39000, gs: 505, track: 315, category: "A3", seen: 0.3 },
  { hex: "7c1b2c", flight: "QFA1    ", r: "VH-OQI", t: "A388", dbFlags: 0, lat: 25.25, lon: 55.36, alt_baro: 38000, gs: 515, track: 300, category: "A3", seen: 0.8 },
  { hex: "896123", flight: "UAE201  ", r: "A6-EEO", t: "A388", dbFlags: 0, lat: 24.85, lon: 56.12, alt_baro: 36000, gs: 480, track: 125, category: "A3", seen: 0.9 },
  { hex: "a98712", flight: "UAL857  ", r: "N27901", t: "B77W", dbFlags: 0, lat: 37.62, lon: -122.38, alt_baro: 34000, gs: 475, track: 295, category: "A3", seen: 1.1 }
];

interface AdsbCacheEntry {
  body: unknown;
  fetchedAt: number;
}
const adsbCache = new Map<string, AdsbCacheEntry>();
const adsbInflight = new Map<string, Promise<unknown>>();
const ADSB_CACHE_TTL_MS = 6000;
const ADSB_FETCH_TIMEOUT_MS = 20000;

interface RawAdsbAircraft {
  lat?: number;
  lon?: number;
  [key: string]: unknown;
}

// The upstream feed returns ~7MB of per-aircraft telemetry; the UI only reads
// these fields, so trimming keeps responses small enough for slow connections.
function slimAdsbPayload(data: unknown): unknown {
  const payload = data as { ac?: RawAdsbAircraft[]; aircraft?: RawAdsbAircraft[]; now?: number } | null;
  const raw = payload?.ac ?? payload?.aircraft;
  if (!Array.isArray(raw)) return data;
  const ac = [];
  for (const a of raw) {
    if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
    ac.push({
      hex: a.hex,
      flight: a.flight,
      r: a.r,
      t: a.t,
      desc: a.desc,
      dbFlags: a.dbFlags,
      category: a.category,
      lat: a.lat,
      lon: a.lon,
      alt_baro: a.alt_baro,
      gs: a.gs,
      track: a.track,
      squawk: a.squawk,
      seen: a.seen,
    });
  }
  return { ac, total: ac.length, now: payload?.now ?? Date.now() };
}

async function refreshAdsb(path: string, fallback: unknown): Promise<unknown> {
  const cached = adsbCache.get(path);
  const now = Date.now();
  try {
    const res = await fetch(`${ADSB_BASE}${path}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "WORLDVIEW/1.0",
      },
      signal: AbortSignal.timeout(ADSB_FETCH_TIMEOUT_MS),
    });

    if (res.ok) {
      const data = slimAdsbPayload(await res.json());
      adsbCache.set(path, { body: data, fetchedAt: Date.now() });
      return data;
    }
  } catch {
    // Network or timeout error: serve cache or fallback
  }

  if (cached) {
    cached.fetchedAt = now;
    return cached.body;
  }
  adsbCache.set(path, { body: fallback, fetchedAt: now });
  return fallback;
}

async function getAdsbData(path: string, fallback: unknown): Promise<unknown> {
  const cached = adsbCache.get(path);
  if (cached && Date.now() - cached.fetchedAt < ADSB_CACHE_TTL_MS) {
    return cached.body;
  }

  let pending = adsbInflight.get(path);
  if (!pending) {
    pending = refreshAdsb(path, fallback).finally(() => adsbInflight.delete(path));
    adsbInflight.set(path, pending);
  }

  // Serve stale data immediately while the refresh completes in the background.
  if (cached) return cached.body;
  return pending;
}

router.get("/proxy/adsb/mil", async (_req, res) => {
  const fallback = { ac: FALLBACK_MIL_AIRCRAFT, total: FALLBACK_MIL_AIRCRAFT.length, now: Date.now() };
  const data = await getAdsbData("/mil", fallback);
  res.json(data);
});

router.get("/proxy/adsb/global", async (_req, res) => {
  const fallback = { ac: FALLBACK_GLOBAL_AIRCRAFT, total: FALLBACK_GLOBAL_AIRCRAFT.length, now: Date.now() };
  const data = await getAdsbData("/point/0/0/20000", fallback);
  res.json(data);
});

router.get("/proxy/adsb/area", async (req, res) => {
  const lat = parseFloat(req.query["lat"] as string);
  const lon = parseFloat(req.query["lon"] as string);
  const radius = parseInt(req.query["radius"] as string, 10);

  if (isNaN(lat) || isNaN(lon) || isNaN(radius) || radius < 10 || radius > 20000) {
    res.status(400).json({ error: "invalid params: lat, lon, radius (10-20000) required" });
    return;
  }

  const clampedLat = Math.max(-90, Math.min(90, lat));
  const clampedLon = Math.max(-180, Math.min(180, lon));
  const fallback = { ac: FALLBACK_GLOBAL_AIRCRAFT, total: FALLBACK_GLOBAL_AIRCRAFT.length, now: Date.now() };
  const data = await getAdsbData(`/point/${clampedLat}/${clampedLon}/${radius}`, fallback);
  res.json(data);
});

// ---------- Satellite TLE proxy (CelesTrak) ----------
//
// We expose a small whitelist of CelesTrak GROUP names so the frontend can
// fetch raw TLE text without running into CORS. Responses are cached in
// memory for an hour because TLE updates are slow-moving.

const CELESTRAK_TLE = "https://celestrak.org/NORAD/elements/gp.php";
const TLE_GROUPS = new Set([
  "active",        // catch-all civilian
  "military",      // military / spy
  "stations",      // ISS + crewed
  "starlink",      // comms
  "geo",           // geostationary comms
  "weather",       // earth-observation weather
  "resource",      // earth-observation imaging (often disguises mil/dual-use)
  "spire",         // earth-observation
  "planet",        // earth-observation
  "radar",         // SAR / radar imaging (RISAT, SAR-LUPE, COSMO-SKYMED…)
  "gnss",          // navigation: GPS, GLONASS, BEIDOU, GALILEO (CelesTrak's combined name)
]);

interface TleCacheEntry { text: string; fetchedAt: number; }
const tleCache: Map<string, TleCacheEntry> = new Map();
const TLE_TTL_MS = 60 * 60 * 1000;

router.get("/proxy/satellites/:group", async (req, res) => {
  const group = String(req.params["group"] || "").toLowerCase();
  if (!TLE_GROUPS.has(group)) {
    res.status(400).json({ error: "unknown group" });
    return;
  }
  const cached = tleCache.get(group);
  if (cached && Date.now() - cached.fetchedAt < TLE_TTL_MS) {
    res.type("text/plain").send(cached.text);
    return;
  }
  try {
    const url = `${CELESTRAK_TLE}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
    const upstream = await fetch(url, {
      headers: { "User-Agent": "WORLDVIEW/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok) throw new Error(`celestrak ${upstream.status}`);
    const text = await upstream.text();
    tleCache.set(group, { text, fetchedAt: Date.now() });
    res.type("text/plain").send(text);
  } catch (err: unknown) {
    logError(req, { err, group }, "satellite tle proxy error");
    if (cached) {
      // serve stale on error
      res.type("text/plain").send(cached.text);
      return;
    }
    const fallbackTle = [
      "ISS (ZARYA)",
      "1 25544U 98067A   24080.53472222  .00016717  00000-0  10270-3 0  9001",
      "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815043444453",
      "TIANGONG",
      "1 48274U 21035A   24080.51234567  .00015000  00000-0  12000-3 0  9002",
      "2 48274  41.4740 180.2310 0004500 110.2300 250.1200 15.58912345167890",
      "USA 245 (NROL-65)",
      "1 39232U 13043A   24080.48912345  .00001200  00000-0  25000-4 0  9003",
      "2 39232  97.9000 120.4500 0520000  80.1200 285.3400 14.82100000567890",
      "COSMOS 2558",
      "1 53322U 22089A   24080.41234567  .00002100  00000-0  42000-4 0  9004",
      "2 53322  97.4500 145.2300 0012000  95.4000 264.8000 15.12300000987654",
      "YAOGAN 35",
      "1 49495U 21099A   24080.39876543  .00000850  00000-0  18000-4 0  9005",
      "2 49495  35.0000 210.1200 0008000 120.5000 240.2000 15.25000000876543",
    ].join("\n");
    res.type("text/plain").send(fallbackTle);
  }
});

// ---------- Nominatim region boundary proxy ----------
//
// Fetches a polygon GeoJSON for a named region (country, strait, city) so the
// frontend can render a tactical boundary without CORS or rate-limit headaches.
// Cached aggressively because boundaries don't change.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
interface RegionCacheEntry { body: unknown; fetchedAt: number; }
const regionCache: Map<string, RegionCacheEntry> = new Map();
const REGION_TTL_MS = 24 * 60 * 60 * 1000;

router.get("/proxy/region", async (req, res) => {
  const q = String(req.query["q"] || "").trim();
  if (!q || q.length > 120) {
    res.status(400).json({ error: "missing or invalid q" });
    return;
  }
  const key = q.toLowerCase();
  const cached = regionCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < REGION_TTL_MS) {
    res.json(cached.body);
    return;
  }
  try {
    const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&polygon_geojson=1&format=json&limit=1`;
    const upstream = await fetch(url, {
      headers: {
        "Accept": "application/json",
        // Nominatim requires an identifying UA per its usage policy.
        "User-Agent": "WORLDVIEW/1.0 (tactical geospatial demo)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) throw new Error(`nominatim ${upstream.status}`);
    const body = await upstream.json();
    regionCache.set(key, { body, fetchedAt: Date.now() });
    res.json(body);
  } catch (err: unknown) {
    logError(req, { err, q }, "region proxy error");
    if (cached) { res.json(cached.body); return; }
    res.status(502).json({ error: "upstream error" });
  }
});

// ---------- Maritime / ships proxy ----------
//
// Mirrors the FUSED_INTEL/AISSTREAM/MARINETRAFFIC ships radar feed so the
// browser can poll without CORS or upstream rate-limit headaches. We add a
// short in-memory cache so many browsers polling share one upstream request.
// While an upstream fetch is in progress, we continue serving the last cached
// data to prevent client-side latency stalls.

export const DEFAULT_SHIPS_UPSTREAM_URL = "https://worldview-intel-i09c.onrender.com";
const SHIPS_UPSTREAM_URL = (process.env.SHIPS_UPSTREAM_URL || DEFAULT_SHIPS_UPSTREAM_URL).replace(/\/+$/, "");
const SHIPS_URL = `${SHIPS_UPSTREAM_URL}/api/radar`;
const DARK_FLEET_URL = `${SHIPS_UPSTREAM_URL}/api/dark-fleet`;

interface ShipsCacheEntry {
  body: unknown;
  fetchedAt: number;
}
let shipsCache: ShipsCacheEntry | null = null;
const SHIPS_TTL_MS = 8_000;
let shipsFetchPromise: Promise<void> | null = null;

let darkFleetCache: ShipsCacheEntry | null = null;
let darkFleetFetchPromise: Promise<void> | null = null;

async function fetchShipsUpstream(): Promise<void> {
  try {
    const upstream = await fetch(SHIPS_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "WORLDVIEW/1.0",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (upstream.ok) {
      const body = await upstream.json();
      shipsCache = { body, fetchedAt: Date.now() };
    }
  } catch {
    // Upstream unavailable or timed out; retain existing cache (stale on error)
  } finally {
    shipsFetchPromise = null;
  }
}

function triggerShipsFetch(): void {
  const now = Date.now();
  const isStale = !shipsCache || now - shipsCache.fetchedAt >= SHIPS_TTL_MS;
  if (isStale && !shipsFetchPromise) {
    shipsFetchPromise = fetchShipsUpstream();
  }
}

async function fetchDarkFleetUpstream(): Promise<void> {
  try {
    const upstream = await fetch(DARK_FLEET_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "WORLDVIEW/1.0",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (upstream.ok) {
      const body = await upstream.json();
      darkFleetCache = { body, fetchedAt: Date.now() };
    }
  } catch {
    // Retain existing cache (stale on error)
  } finally {
    darkFleetFetchPromise = null;
  }
}

function triggerDarkFleetFetch(): void {
  const now = Date.now();
  const isStale = !darkFleetCache || now - darkFleetCache.fetchedAt >= SHIPS_TTL_MS;
  if (isStale && !darkFleetFetchPromise) {
    darkFleetFetchPromise = fetchDarkFleetUpstream();
  }
}

const FALLBACK_SHIPS = [
  { mmsi: 367123450, vessel_name: "USNS PECOS", lat: 26.54, lon: 56.45, sog: 14.2, cog: 110, last_updated: Date.now(), category: "MILITARY", source: "FUSED_INTEL" },
  { mmsi: 211987650, vessel_name: "HAMBURG EXPRESS", lat: 25.12, lon: 57.34, sog: 18.5, cog: 142, last_updated: Date.now(), category: "TANKER", source: "FUSED_INTEL", est_barrels: 1200000 },
  { mmsi: 413001230, vessel_name: "COSCO PRIDE", lat: 1.25, lon: 103.85, sog: 12.1, cog: 280, last_updated: Date.now(), category: "UNKNOWN", source: "AISSTREAM" },
  { mmsi: 273445560, vessel_name: "ADMIRAL GORSHKOV", lat: 55.70, lon: 19.80, sog: 15.0, cog: 65, last_updated: Date.now(), category: "MILITARY", source: "FUSED_INTEL" },
  { mmsi: 636015520, vessel_name: "EVER GIVEN", lat: 12.58, lon: 43.35, sog: 16.4, cog: 320, last_updated: Date.now(), category: "TANKER", source: "MARINETRAFFIC", est_barrels: 1800000 },
  { mmsi: 311000456, vessel_name: "PACIFIC VOYAGER", lat: 34.01, lon: -119.5, sog: 11.8, cog: 215, last_updated: Date.now(), category: "TANKER", source: "AISSTREAM" },
];

const FALLBACK_DARK_FLEET = [
  { mmsi: "470050000", ship_name: "RAHEEB", last_known_lat: 24.990086666666667, last_known_lon: 55.05668166666667, time_went_dark: "2026-10-09T09:51:16.138+00:00", last_sog: 6.9, last_cog: 246.6 },
  { mmsi: "353641000", ship_name: "DAEWOO DIAMOND", last_known_lat: 13.259836666666667, last_known_lon: 80.34889, time_went_dark: "2026-10-09T09:20:32.072+00:00", last_sog: 4.9, last_cog: 352.4 },
  { mmsi: "246643000", ship_name: "SEA BULLDOG", last_known_lat: 25.186708333333335, last_known_lon: 55.20324166666667, time_went_dark: "2026-10-09T09:08:38.36+00:00", last_sog: 6.2, last_cog: 137.5 },
  { mmsi: "419001342", ship_name: "OCEAN BLISS", last_known_lat: 13.092993333333334, last_known_lon: 80.29828666666667, time_went_dark: "2026-10-09T08:55:38.272+00:00", last_sog: 7.9, last_cog: 358.2 },
  { mmsi: "245508000", ship_name: "HAM 318", last_known_lat: 25.183151666666667, last_known_lon: 55.13538833333334, time_went_dark: "2026-10-09T08:05:33.973+00:00", last_sog: 11.6, last_cog: 297.4 },
  { mmsi: "341840001", ship_name: "UNKNOWN", last_known_lat: 24.988481666666665, last_known_lon: 55.055258333333335, time_went_dark: "2026-10-09T07:39:48.913+00:00", last_sog: 4.5, last_cog: 332.3 },
  { mmsi: "563285600", ship_name: "SEASPAN BELLWETHER", last_known_lat: 13.142853333333333, last_known_lon: 80.54245666666667, time_went_dark: "2026-10-09T07:14:15.254+00:00", last_sog: 9.9, last_cog: 354.3 },
  { mmsi: "577345000", ship_name: "UNKNOWN", last_known_lat: 24.988058333333335, last_known_lon: 55.05459166666667, time_went_dark: "2026-10-09T06:59:18.788+00:00", last_sog: 5.3, last_cog: 161 },
  { mmsi: "470068000", ship_name: "MIHAIZ", last_known_lat: 24.987894999999998, last_known_lon: 55.05671666666667, time_went_dark: "2026-10-09T04:48:31.737+00:00", last_sog: 7.4, last_cog: 172.3 },
  { mmsi: "470346000", ship_name: "RED SEA II", last_known_lat: 25.085269999999998, last_known_lon: 55.11257333333333, time_went_dark: "2026-10-09T04:13:19.126+00:00", last_sog: 12, last_cog: 258.6 },
];

router.get("/proxy/ships", async (_req, res) => {
  const now = Date.now();

  // If cache is fresh (< 8s), serve immediately
  if (shipsCache && now - shipsCache.fetchedAt < SHIPS_TTL_MS) {
    res.json(shipsCache.body);
    return;
  }

  // Trigger upstream fetch if not already in flight
  triggerShipsFetch();

  // If we already have cached data, keep serving the last cached data while it waits
  if (shipsCache) {
    res.json(shipsCache.body);
    return;
  }

  // Cold boot with no cache yet: wait for the initial fetch to settle
  if (shipsFetchPromise) {
    await shipsFetchPromise;
  }

  const freshShips = shipsCache as ShipsCacheEntry | null;
  if (freshShips) {
    res.json(freshShips.body);
    return;
  }

  res.json(FALLBACK_SHIPS);
});

async function handleDarkFleetProxy(_req: Request, res: Response) {
  const now = Date.now();

  // If cache is fresh (< 8s), serve immediately
  if (darkFleetCache && now - darkFleetCache.fetchedAt < SHIPS_TTL_MS) {
    res.json(darkFleetCache.body);
    return;
  }

  // Trigger upstream fetch if not already in flight
  triggerDarkFleetFetch();

  // If we already have cached data, keep serving the last cached data while it waits
  if (darkFleetCache) {
    res.json(darkFleetCache.body);
    return;
  }

  // Cold boot with no cache yet: wait for initial fetch to settle
  if (darkFleetFetchPromise) {
    await darkFleetFetchPromise;
  }

  const freshDarkFleet = darkFleetCache as ShipsCacheEntry | null;
  if (freshDarkFleet) {
    res.json(freshDarkFleet.body);
    return;
  }

  res.json(FALLBACK_DARK_FLEET);
}

router.get("/proxy/dark-fleet", handleDarkFleetProxy);
router.get("/proxy/ships/dark-fleet", handleDarkFleetProxy);

// ---------- Oil Analytics Proxies ----------
//
// Proxies live oil and daily India crude statistics from the maritime upstream.
// In-memory TTL cache of 30 seconds, 60s cold-start timeout, serve last cached data on failure/while waiting.

const OIL_LIVE_URL = `${SHIPS_UPSTREAM_URL}/api/analytics/live-oil`;
const OIL_DAILY_URL = `${SHIPS_UPSTREAM_URL}/api/analytics/india/daily?days=14`;
const OIL_TTL_MS = 30_000;

interface OilCacheEntry {
  body: unknown;
  fetchedAt: number;
}

let oilLiveCache: OilCacheEntry | null = null;
let oilLiveFetchPromise: Promise<void> | null = null;

let oilDailyCache: OilCacheEntry | null = null;
let oilDailyFetchPromise: Promise<void> | null = null;

async function fetchOilLiveUpstream(): Promise<void> {
  try {
    const upstream = await fetch(OIL_LIVE_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "WORLDVIEW/1.0",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (upstream.ok) {
      const body = await upstream.json();
      oilLiveCache = { body, fetchedAt: Date.now() };
    }
  } catch {
    // Retain existing cache (stale on error)
  } finally {
    oilLiveFetchPromise = null;
  }
}

function triggerOilLiveFetch(): void {
  const now = Date.now();
  const isStale = !oilLiveCache || now - oilLiveCache.fetchedAt >= OIL_TTL_MS;
  if (isStale && !oilLiveFetchPromise) {
    oilLiveFetchPromise = fetchOilLiveUpstream();
  }
}

async function fetchOilDailyUpstream(): Promise<void> {
  try {
    const upstream = await fetch(OIL_DAILY_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "WORLDVIEW/1.0",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (upstream.ok) {
      const body = await upstream.json();
      oilDailyCache = { body, fetchedAt: Date.now() };
    }
  } catch {
    // Retain existing cache (stale on error)
  } finally {
    oilDailyFetchPromise = null;
  }
}

function triggerOilDailyFetch(): void {
  const now = Date.now();
  const isStale = !oilDailyCache || now - oilDailyCache.fetchedAt >= OIL_TTL_MS;
  if (isStale && !oilDailyFetchPromise) {
    oilDailyFetchPromise = fetchOilDailyUpstream();
  }
}

router.get("/proxy/oil/live", async (_req, res) => {
  const now = Date.now();

  // If cache is fresh (< 30s), serve immediately
  if (oilLiveCache && now - oilLiveCache.fetchedAt < OIL_TTL_MS) {
    res.json(oilLiveCache.body);
    return;
  }

  // Trigger upstream fetch if not in flight
  triggerOilLiveFetch();

  // If cached data exists, serve stale while revalidating
  if (oilLiveCache) {
    res.json(oilLiveCache.body);
    return;
  }

  // Cold boot: wait for first fetch
  if (oilLiveFetchPromise) {
    await oilLiveFetchPromise;
  }

  const freshOilLive = oilLiveCache as OilCacheEntry | null;
  if (freshOilLive) {
    res.json(freshOilLive.body);
    return;
  }

  // Fallback empty structure
  res.json({
    active_tankers: 0,
    total_barrels_in_transit: 0,
    capacity_barrels_in_region: 0,
    inbound_tankers: 0,
    inbound_barrels_to_india: 0,
    arrived_last_24h: { tankers: 0, barrels: 0 },
    note: "Estimates. Barrels = DWT x 0.90 x 7.33 for crude-size tankers (DWT >= 60,000).",
  });
});

router.get("/proxy/oil/daily", async (_req, res) => {
  const now = Date.now();

  // If cache is fresh (< 30s), serve immediately
  if (oilDailyCache && now - oilDailyCache.fetchedAt < OIL_TTL_MS) {
    res.json(oilDailyCache.body);
    return;
  }

  // Trigger upstream fetch if not in flight
  triggerOilDailyFetch();

  // If cached data exists, serve stale while revalidating
  if (oilDailyCache) {
    res.json(oilDailyCache.body);
    return;
  }

  // Cold boot: wait for first fetch
  if (oilDailyFetchPromise) {
    await oilDailyFetchPromise;
  }

  const freshOilDaily = oilDailyCache as OilCacheEntry | null;
  if (freshOilDaily) {
    res.json(freshOilDaily.body);
    return;
  }

  // Fallback empty structure
  res.json({
    days: [],
    avg_barrels_per_day_last_7d: 0,
    note: "Estimate of crude arriving at Indian ports (IST days). Counting starts when this server first ran, so early days are low. Compare with PPAC monthly data.",
  });
});

router.get("/proxy/ships/status", async (_req, res) => {
  try {
    const upstream = await fetch(`${SHIPS_UPSTREAM_URL}/api/status`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "WORLDVIEW/1.0",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (upstream.ok) {
      const body = await upstream.json();
      res.json(body);
      return;
    }
  } catch {
    // upstream error
  }
  res.status(502).json({ error: "Upstream status unavailable" });
});

// ---------- Playback Proxies ----------
//
// Proxies historical radar/aircraft playback feeds from SHIPS_UPSTREAM_URL.
// Frames never change once recorded, so they are cached in memory for 1 hour (max ~40 entries).
// Index endpoints are dynamic and cached for 30 seconds. Config cached for 1 hour.
// Gracefully falls back to stale cache on upstream timeout or network glitch.

const PLAYBACK_FRAME_TTL_MS = 60 * 60 * 1000; // 1 hour
const PLAYBACK_INDEX_TTL_MS = 30 * 1000;       // 30 seconds
const PLAYBACK_CONFIG_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_FRAME_CACHE_ENTRIES = 40;

interface PlaybackCacheEntry {
  body: unknown;
  fetchedAt: number;
}

const playbackFrameCache = new Map<string, PlaybackCacheEntry>();
const playbackIndexCache = new Map<string, PlaybackCacheEntry>();
const playbackTrailCache = new Map<string, PlaybackCacheEntry>();
let playbackConfigCache: PlaybackCacheEntry | null = null;

function setPlaybackFrameCache(key: string, body: unknown) {
  if (playbackFrameCache.size >= MAX_FRAME_CACHE_ENTRIES) {
    const oldestKey = playbackFrameCache.keys().next().value;
    if (oldestKey) playbackFrameCache.delete(oldestKey);
  }
  playbackFrameCache.set(key, { body, fetchedAt: Date.now() });
}

async function fetchPlaybackUpstream(pathAndQuery: string, timeoutMs = 60_000): Promise<unknown> {
  const url = `${SHIPS_UPSTREAM_URL}/api/playback/${pathAndQuery.replace(/^\/+/, "")}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "WORLDVIEW/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Upstream returned ${response.status} for ${url}`);
  }
  return response.json();
}

// 1. Config
router.get("/proxy/playback/config", async (req, res) => {
  const now = Date.now();
  if (playbackConfigCache && now - playbackConfigCache.fetchedAt < PLAYBACK_CONFIG_TTL_MS) {
    res.json(playbackConfigCache.body);
    return;
  }
  try {
    const data = await fetchPlaybackUpstream("config");
    playbackConfigCache = { body: data, fetchedAt: now };
    res.json(data);
  } catch (err) {
    logError(req, err, "Failed to fetch playback config");
    if (playbackConfigCache) {
      res.json(playbackConfigCache.body);
      return;
    }
    res.status(502).json({ error: "Failed to fetch playback config from upstream" });
  }
});

// 2. Ships Index
router.get("/proxy/playback/ships/:region/index", async (req, res) => {
  const region = String(req.params.region || "").toUpperCase();
  const hours = req.query.hours ? String(req.query.hours) : "24";
  const cacheKey = `ships:${region}:index:${hours}`;
  const now = Date.now();
  const cached = playbackIndexCache.get(cacheKey);

  if (cached && now - cached.fetchedAt < PLAYBACK_INDEX_TTL_MS) {
    res.json(cached.body);
    return;
  }

  try {
    const data = await fetchPlaybackUpstream(`ships/${encodeURIComponent(region)}/index?hours=${encodeURIComponent(hours)}`);
    playbackIndexCache.set(cacheKey, { body: data, fetchedAt: now });
    res.json(data);
  } catch (err) {
    logError(req, err, `Failed to fetch ships ${region} index`);
    if (cached) {
      res.json(cached.body);
      return;
    }
    res.status(502).json({ error: "Failed to fetch playback ships index" });
  }
});

// 3. Ships Frame
router.get("/proxy/playback/ships/:region/frame/:id", async (req, res) => {
  const region = String(req.params.region || "").toUpperCase();
  const id = String(req.params.id || "");
  const cacheKey = `ships:${region}:frame:${id}`;
  const now = Date.now();
  const cached = playbackFrameCache.get(cacheKey);

  if (cached && now - cached.fetchedAt < PLAYBACK_FRAME_TTL_MS) {
    res.json(cached.body);
    return;
  }

  try {
    const data = await fetchPlaybackUpstream(`ships/${encodeURIComponent(region)}/frame/${encodeURIComponent(id)}`);
    setPlaybackFrameCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    logError(req, err, `Failed to fetch ships ${region} frame ${id}`);
    if (cached) {
      res.json(cached.body);
      return;
    }
    res.status(502).json({ error: "Failed to fetch playback ships frame" });
  }
});

// 4. Ships Trail
router.get("/proxy/playback/ships/:region/trail/:mmsi", async (req, res) => {
  const region = String(req.params.region || "").toUpperCase();
  const mmsi = String(req.params.mmsi || "");
  const hours = req.query.hours ? String(req.query.hours) : "24";
  const cacheKey = `ships:${region}:trail:${mmsi}:${hours}`;
  const now = Date.now();
  const cached = playbackTrailCache.get(cacheKey);

  if (cached && now - cached.fetchedAt < 60_000) {
    res.json(cached.body);
    return;
  }

  try {
    const data = await fetchPlaybackUpstream(`ships/${encodeURIComponent(region)}/trail/${encodeURIComponent(mmsi)}?hours=${encodeURIComponent(hours)}`);
    playbackTrailCache.set(cacheKey, { body: data, fetchedAt: now });
    res.json(data);
  } catch (err) {
    logError(req, err, `Failed to fetch ships ${region} trail for mmsi ${mmsi}`);
    if (cached) {
      res.json(cached.body);
      return;
    }
    res.status(502).json({ error: "Failed to fetch playback ship trail" });
  }
});

// 5. Planes Index
router.get("/proxy/playback/planes/index", async (req, res) => {
  const hours = req.query.hours ? String(req.query.hours) : "24";
  const cacheKey = `planes:index:${hours}`;
  const now = Date.now();
  const cached = playbackIndexCache.get(cacheKey);

  if (cached && now - cached.fetchedAt < PLAYBACK_INDEX_TTL_MS) {
    res.json(cached.body);
    return;
  }

  try {
    const data = await fetchPlaybackUpstream(`planes/index?hours=${encodeURIComponent(hours)}`);
    playbackIndexCache.set(cacheKey, { body: data, fetchedAt: now });
    res.json(data);
  } catch (err) {
    logError(req, err, "Failed to fetch planes index");
    if (cached) {
      res.json(cached.body);
      return;
    }
    res.status(502).json({ error: "Failed to fetch playback planes index" });
  }
});

// 6. Planes Frame
router.get("/proxy/playback/planes/frame/:id", async (req, res) => {
  const id = String(req.params.id || "");
  const cacheKey = `planes:frame:${id}`;
  const now = Date.now();
  const cached = playbackFrameCache.get(cacheKey);

  if (cached && now - cached.fetchedAt < PLAYBACK_FRAME_TTL_MS) {
    res.json(cached.body);
    return;
  }

  try {
    const data = await fetchPlaybackUpstream(`planes/frame/${encodeURIComponent(id)}`);
    setPlaybackFrameCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    logError(req, err, `Failed to fetch planes frame ${id}`);
    if (cached) {
      res.json(cached.body);
      return;
    }
    res.status(502).json({ error: "Failed to fetch playback planes frame" });
  }
});

// 7. Planes Trail
router.get("/proxy/playback/planes/trail/:hex", async (req, res) => {
  const hex = String(req.params.hex || "");
  const hours = req.query.hours ? String(req.query.hours) : "24";
  const cacheKey = `planes:trail:${hex}:${hours}`;
  const now = Date.now();
  const cached = playbackTrailCache.get(cacheKey);

  if (cached && now - cached.fetchedAt < 60_000) {
    res.json(cached.body);
    return;
  }

  try {
    const data = await fetchPlaybackUpstream(`planes/trail/${encodeURIComponent(hex)}?hours=${encodeURIComponent(hours)}`);
    playbackTrailCache.set(cacheKey, { body: data, fetchedAt: now });
    res.json(data);
  } catch (err) {
    logError(req, err, `Failed to fetch planes trail for hex ${hex}`);
    if (cached) {
      res.json(cached.body);
      return;
    }
    res.status(502).json({ error: "Failed to fetch playback planes trail" });
  }
});

export default router;
