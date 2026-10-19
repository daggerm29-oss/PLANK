import * as Cesium from "cesium";

type EcefAt = (when: Date) => { x: number; y: number; z: number } | null;

/**
 * Glowing dashed orbital trajectory. Polyline `st.s` runs 0..1 by vertex index, and
 * samples are evenly spaced in time, so `(s - sSat) * lengthM` is the along-track
 * distance from the satellite. Dashes are laid out on a log scale of that distance,
 * which keeps them a similar size on screen near and far, and `march` scrolls them
 * forward in the direction of travel.
 */
const DASH_SOURCE = /* glsl */ `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  float d = (st.s - sSat) * lengthM;
  float u = sign(d) * log(1.0 + abs(d) / 220.0) * 5.0 - march;
  float f = fract(u);
  float dash = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.5, 0.56, f));
  float across = abs(st.t - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.15, 0.4, across);
  float halo = pow(1.0 - across, 2.2);
  // Short gap at the satellite so the line doesn't cut through the model.
  float gap = smoothstep(18.0, 45.0, abs(d));
  float fadeFar = 1.0 - smoothstep(0.42, 0.5, abs(st.s - sSat));
  material.diffuse = mix(color.rgb, vec3(0.75, 1.0, 0.85), core * 0.3);
  material.emission = color.rgb * (halo * 0.9 + core);
  material.alpha = clamp(dash * (core + halo * 0.75) + halo * 0.12, 0.0, 1.0) * gap * fadeFar * color.a;
  return material;
}
`;

export interface OrbitPath {
  collection: Cesium.PolylineCollection;
  update(nowMs: number, dtSec: number): void;
  destroy(): void;
}

export function createOrbitPath(scene: Cesium.Scene, ecefAt: () => EcefAt | undefined, periodSec: () => number | undefined): OrbitPath {
  const material = new Cesium.Material({
    fabric: {
      type: "WvOrbitDash",
      uniforms: {
        color: Cesium.Color.fromCssColorString("#22ff8a"),
        sSat: 0.5,
        lengthM: 1,
        march: 0,
      },
      source: DASH_SOURCE,
    },
    translucent: true,
  });
  const collection = scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection;
  let polyline: Cesium.Polyline | null = null;
  let builtAt = 0;
  let startMs = 0;
  let spanMs = 1;
  let march = 0;

  const rebuild = (nowMs: number) => {
    const fn = ecefAt();
    const period = periodSec();
    console.log("[v0] orbit rebuild", !!fn, period);
    if (!fn || !period) return;
    const halfMs = (period * 1000) / 2;
    const stepMs = Math.max(1000, (period * 1000) / 6000);
    const n = Math.floor((halfMs * 2) / stepMs) + 1;
    const positions: Cesium.Cartesian3[] = [];
    const t0 = nowMs - halfMs;
    let length = 0;
    let prev: Cesium.Cartesian3 | null = null;
    for (let i = 0; i < n; i++) {
      const p = fn(new Date(t0 + i * stepMs));
      if (!p) return;
      const c = new Cesium.Cartesian3(p.x, p.y, p.z);
      if (prev) length += Cesium.Cartesian3.distance(prev, c);
      positions.push(c);
      prev = c;
    }
    startMs = t0;
    spanMs = (n - 1) * stepMs;
    material.uniforms.lengthM = length;
    if (polyline) polyline.positions = positions;
    else polyline = collection.add({ positions, width: 9, material });
    builtAt = nowMs;
  };

  return {
    collection,
    update(nowMs, dtSec) {
      if (!polyline || nowMs - builtAt > 4000) rebuild(nowMs);
      if (!polyline) return;
      march += dtSec * 1.6;
      material.uniforms.sSat = (nowMs - startMs) / spanMs;
      material.uniforms.march = march;
    },
    destroy() {
      if (!collection.isDestroyed()) scene.primitives.remove(collection);
    },
  };
}
