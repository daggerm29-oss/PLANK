# CCTV integration (God's-Eye-style camera layer)

Status: **implemented**. This file is the hand-off doc so any future AI/dev session can continue without re-explaining.

## Architecture (matches the rest of sky7)

```
Browser (artifacts/worldview, Vite + React + MapLibre)
   │  fetch /api/proxy/cctv/*
   ▼
api-server (artifacts/api-server, Express 5)   ← also mounted inside vite.config.ts for dev
   │  fetch + normalise + in-memory cache (10 min, stale-on-error)
   ▼
Public feeds: NYC DOT · TfL JamCams · Caltrans · LTA Singapore · City of Austin · Windy (opt) · OSM Overpass
```

Same pattern as Maritime/Aviation: server proxy → normalised JSON → `useXxx` hook → MapLibre layer component → toolbar button → `FloatingPanel`.

## Files

| File | Role |
| --- | --- |
| `artifacts/api-server/src/routes/cctv.ts` | All server logic: 6 fetchers, cache, OSM Overpass bbox endpoint, allow-listed image proxy |
| `artifacts/api-server/src/routes/index.ts` | Registers `cctvRouter` |
| `artifacts/worldview/vite.config.ts` | Registers `cctvRouter` in the dev/preview API plugin |
| `artifacts/worldview/src/lib/cctv.ts` | Shared types, source colours, `proxiedImage()` |
| `artifacts/worldview/src/hooks/use-cctv.ts` | Loads catalogue (10 min refresh) + OSM viewport scan (zoom >= 12, debounced) |
| `artifacts/worldview/src/components/CctvLayer.tsx` | Clustered circle layers, selection ring, click handlers |
| `artifacts/worldview/src/components/CctvPanel.tsx` | Source toggles with counts, search, attribution |
| `artifacts/worldview/src/components/CctvViewer.tsx` | Viewer: HLS (hls.js) → MP4 loop → refreshing snapshot, with fallbacks |
| `artifacts/worldview/src/components/MasterToolbar.tsx` | Adds `CctvIcon` |
| `artifacts/worldview/src/pages/WorldviewMap.tsx` | State, hook, `<CctvLayer>`, toolbar item, two `FloatingPanel`s |
| `artifacts/worldview/package.json` | Adds `hls.js` |
| `.env.example` | Adds optional `WINDY_API_KEY` |

## Endpoints

- `GET /api/proxy/cctv/sources` – catalogue + live counts + per-source errors
- `GET /api/proxy/cctv/cameras?sources=nyc,tfl,...` – normalised `Camera[]`
- `GET /api/proxy/cctv/osm?s=&w=&n=&e=` – OSM camera locations (max 0.6° span, else 413)
- `GET /api/proxy/cctv/image?url=` – HTTPS-only, host allow-list (SSRF-safe)

## Sources (all key-free unless noted)

| Id | Provider | Feed type | Approx. cameras |
| --- | --- | --- | --- |
| `nyc` | webcams.nyctmc.org | refreshing JPEG | ~980 |
| `tfl` | api.tfl.gov.uk JamCam | MP4 loop + JPEG | ~790 |
| `caltrans` | cwwp2.dot.ca.gov (districts 1–12) | HLS + JPEG | ~3,000+ |
| `singapore` | api.data.gov.sg traffic-images | JPEG | ~10 (feed currently returns few) |
| `austin` | data.austintexas.gov `b4k4-adkb` | JPEG | ~820 |
| `windy` | api.windy.com webcams v3 | JPEG (needs `WINDY_API_KEY`) | thousands |
| `osm` | Overpass `man_made=surveillance` | **locations only** | millions worldwide |

Deliberately excluded: Insecam / Shodan-style scrapers of unsecured private IP cameras (privacy/legal).

## Adding a new source

1. Add the id to `SourceId` + `SOURCES` + `LIVE_SOURCES` in `cctv.ts` (server) and `CctvSourceId` / `CCTV_SOURCE_COLORS` in `lib/cctv.ts`.
2. Write `fetchXxx(): Promise<Camera[]>` and add it to `FETCHERS`.
3. Add its image host to `IMAGE_HOSTS` if it serves JPEGs.
4. Add it to the default `cctvEnabled` array in `WorldviewMap.tsx`.

Good next candidates: WSDOT (access code), 511 networks (Ontario, Georgia, Ohio — need free keys), Windy per-region.

## Known limits / next steps

- Verified: the router was run standalone and returned live data (NYC 979, TfL 785, Caltrans 3,397, Austin 822, OSM 271 in central London, image proxy OK, non-allow-listed hosts 403); new files type-check against React 19, Express 5, MapLibre. Not yet run end-to-end inside sky7 itself.
- Caltrans HLS may be blocked by CORS in some browsers; the viewer auto-falls back to the JPEG snapshot.
- Playback mode hides the CCTV layer (same as ships).
- Possible upgrade: add a server-side spatial index so very large catalogues are streamed per-viewport instead of all at once.

## Near-live still feeds (1 Hz)

- `GET /api/proxy/cctv/frame?id=<camera id>` returns the newest frame for one camera. It re-resolves the upstream URL on every call (Singapore links are signed and expire), keeps a ~0.9 s micro-cache with in-flight de-duplication, serves the last good frame on a transient upstream error, and sets `X-Frame-Hash` so the client can tell whether the picture changed.
- `CctvViewer` polls it once per second, one request at a time, pauses while the tab is hidden, and only shows "OFFLINE" after 5 consecutive failures.
- Some hosts (images.data.gov.sg) label JPEGs `application/octet-stream`; both image endpoints detect the type from the file's first bytes.
- The badge shows how old the picture is. Upstream cameras publish at their own pace (NYC ~1-3 s, Austin ~15 s, Singapore ~20 s, Caltrans ~1 min, TfL a few min), so polling faster than that cannot produce new footage.

## Added sources: Maryland, Florida, Oregon

| Source | Cameras | Type | Notes |
|---|---|---|---|
| Maryland CHART (`maryland`) | ~549 | Live HLS | `https://<cctvIp>/rtplive/<id>/playlist.m3u8`, open CORS, no key. A few encoders are broken upstream and show "offline". |
| Florida FL511 (`florida`) | ~4,990 | Snapshot (~10 s) | Catalogue pages at 100 rows. FL511 video requires a login, so only the still image is used. |
| Oregon TripCheck (`oregon`) | ~1,160 | Snapshot (~2 min) | Rejects `Accept: application/json`; the fetcher sends `*/*`. |

`HlsPlayer` loads hls.js first and only uses native HLS when hls.js is unsupported (Chrome 142+ reports native support but is stricter about live TS).
