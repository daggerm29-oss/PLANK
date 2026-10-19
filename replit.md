# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Artifacts

### WORLDVIEW (`artifacts/worldview`)
- Real-time tactical geospatial intelligence interface
- Map engine: MapLibre GL JS v5 with CARTO Dark Matter raster tiles
- 2D mode: flat Mercator projection; 3D mode: native globe projection via `map.setProjection({ type: 'globe' })`
- 3D globe: CSS starfield canvas behind MapLibre, `setSky({ atmosphere-blend: 1 })` for atmospheric halo, radial CSS glow overlay
- Flight data: ADS-B via adsb.lol (military + public aviation), 3s refresh interval
- Aircraft markers: SDF icon-image with heading rotation — same markers work in both 2D and 3D
- CORS-safe: adsb.lol is proxied via Express API routes (`/api/proxy/adsb/mil`, `/api/proxy/adsb/global`)
- Maritime intel: ships radar via `worldview-intel-i09c.onrender.com` proxied at `/api/proxy/ships` (8s server cache, 5s client poll). MapLibre circle layers (`ships-halo` + `ships-dot`) in `ShipsLayer.tsx` colored by source (AISSTREAM=white, TANKER=red, MILITARY=blue). `MaritimePanel.tsx` floating panel has Filters (3 toggles), Live Metrics, and Regional Analytics with two recharts placeholder line charts (Hormuz Transit Volume, Indian Subcontinent Unloading). Toggled via the maritime button in `MasterToolbar`.
- Note: MapLibre requires WebGL — works in deployed/real browsers; Replit preview sandbox lacks GPU acceleration

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
