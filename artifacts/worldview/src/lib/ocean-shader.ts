import * as Cesium from "cesium";

/**
 * Tactical maritime ocean for the cinematic ship view: a ship-centred grid mesh
 * (local ENU metres, denser near the hull) displaced by procedural waves in the
 * vertex shader and shaded as glowing turquoise "digital water" with neon crests,
 * a world-anchored grid, a Kelvin wake, hull foam and sonar-style rings.
 */

export const OCEAN_BASE_HEIGHT = 3.5;
const HALF_SIZE = 12_000;
const GRID_N = 320;

/** Builds a binary glTF of an N×N grid in the XY plane (Z up), spacing grows with distance. */
function buildOceanGlb(): Uint8Array {
  const n = GRID_N;
  const coord = (i: number) => {
    const u = (i / (n - 1)) * 2 - 1;
    return HALF_SIZE * (0.05 * u + 0.95 * u * Math.abs(u));
  };
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    const y = coord(j);
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      positions[k] = coord(i);
      positions[k + 1] = y;
      positions[k + 2] = 0;
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let q = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[q++] = a;
      indices[q++] = b;
      indices[q++] = d;
      indices[q++] = a;
      indices[q++] = d;
      indices[q++] = c;
    }
  }

  const posBytes = positions.byteLength;
  const idxBytes = indices.byteLength;
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0, 0.6, 0.6, 1] } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] }],
    buffers: [{ byteLength: posBytes + idxBytes }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: idxBytes, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: n * n,
        type: "VEC3",
        min: [-HALF_SIZE, -HALF_SIZE, 0],
        max: [HALF_SIZE, HALF_SIZE, 0],
      },
      { bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" },
    ],
  };

  const jsonText = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(jsonText.length / 4) * 4;
  const binLen = Math.ceil((posBytes + idxBytes) / 4) * 4;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLen);
  out.set(jsonText, 20);
  const binStart = 20 + jsonLen;
  dv.setUint32(binStart, binLen, true);
  dv.setUint32(binStart + 4, 0x004e4942, true);
  out.set(new Uint8Array(positions.buffer), binStart + 8);
  out.set(new Uint8Array(indices.buffer), binStart + 8 + posBytes);
  return out;
}

const WAVES_GLSL = /* glsl */ `
void wv_add(vec2 p, float t, vec2 dir, float len, float amp, float phi, inout float h, inout vec2 g) {
  float k = 6.2831853 / len;
  float w = sqrt(9.81 * k);
  float ph = k * dot(dir, p) - w * t + phi;
  float b = 0.5 + 0.5 * sin(ph);
  h += amp * (2.0 * pow(b, 2.2) - 1.0);
  g += amp * 2.2 * pow(max(b, 1e-4), 1.2) * cos(ph) * k * dir;
}

// detail: 0 = swell only (vertex shader), 1 = full chop; fragment fades it with distance to avoid shimmer.
float wv_height(vec2 p, float t, float detail, out vec2 g) {
  float h = 0.0;
  g = vec2(0.0);
  wv_add(p, t, normalize(vec2(1.0, 0.35)), 96.0, 1.25, 0.0, h, g);
  wv_add(p, t, normalize(vec2(0.6, 1.0)), 61.0, 0.8, 1.3, h, g);
  wv_add(p, t, normalize(vec2(1.0, -0.7)), 38.0, 0.5, 2.1, h, g);
  if (detail > 0.001) {
    wv_add(p, t, normalize(vec2(-0.3, 1.0)), 23.0, 0.3 * detail, 0.7, h, g);
    wv_add(p, t, normalize(vec2(0.9, 0.2)), 14.0, 0.17 * detail, 4.0, h, g);
    wv_add(p, t, normalize(vec2(0.2, -1.0)), 8.5, 0.09 * detail, 5.2, h, g);
    wv_add(p, t, normalize(vec2(-0.8, 0.5)), 5.0, 0.05 * detail, 1.9, h, g);
  }
  return h;
}

// Waves flatten inside the hull footprint so they don't wash over the deck.
float wv_calm(vec2 local) {
  vec2 fwd = vec2(sin(u_heading), cos(u_heading));
  vec2 right = vec2(fwd.y, -fwd.x);
  float e = length(vec2(dot(local, fwd) / (u_shipLen * 0.5), dot(local, right) / (u_beam * 0.5)));
  return mix(0.2, 1.0, smoothstep(1.0, 2.4, e));
}
`;

const VERTEX_GLSL = /* glsl */ `
${WAVES_GLSL}
void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
  vec3 p = vsInput.attributes.positionMC;
  vec2 g;
  float h = wv_height(p.xy + u_offset, u_time, 0.0, g);
  float far = 1.0 - smoothstep(3000.0, 9000.0, length(p.xy));
  vsOutput.positionMC = vec3(p.xy, h * wv_calm(p.xy) * far);
  v_local = p.xy;
}
`;

const FRAGMENT_GLSL = /* glsl */ `
${WAVES_GLSL}
float wv_hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float wv_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wv_hash(i), wv_hash(i + vec2(1.0, 0.0)), u.x),
             mix(wv_hash(i + vec2(0.0, 1.0)), wv_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wv_fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * wv_noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec2 local = v_local;
  vec2 world = local + u_offset;
  float t = u_time;
  float dist = length(fsInput.attributes.positionEC);
  float nearFade = 1.0 - smoothstep(900.0, 4000.0, dist);

  vec2 g;
  float calm = wv_calm(local);
  float detail = 1.0 - smoothstep(350.0, 2200.0, dist);
  float h = wv_height(world, t, detail, g) * calm;
  g *= calm;

  vec3 n = normalize(vec3(-g, 1.0));
  vec3 nEC = normalize(czm_normal * n);
  vec3 vEC = normalize(-fsInput.attributes.positionEC);
  float fres = pow(1.0 - clamp(abs(dot(nEC, vEC)), 0.0, 1.0), 4.0);

  vec3 deep = vec3(0.003, 0.012, 0.03);
  vec3 mid = vec3(0.0, 0.1, 0.16);
  vec3 turq = vec3(0.04, 0.86, 0.84);
  vec3 neon = vec3(0.6, 1.0, 0.97);

  float hn = clamp(h / 2.8 * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(deep, mid, smoothstep(0.25, 0.9, hn));
  col += turq * fres * 0.28;
  col += turq * 0.22 * smoothstep(0.55, 0.9, hn);

  // Neon crests, broken into filaments by drifting noise.
  float slope = length(g);
  float streak = wv_fbm(world * vec2(0.07, 0.11) + vec2(t * 0.05, -t * 0.03));
  float crest = smoothstep(0.7, 0.95, hn) * (0.3 + smoothstep(0.15, 0.6, slope));
  crest *= smoothstep(0.3, 0.72, streak);
  col += neon * crest * 1.25 * (0.35 + 0.65 * nearFade);

  // Height contour filaments (holographic look).
  float fil = 1.0 - smoothstep(0.0, 0.06, abs(fract(h * 1.4 + streak * 0.9) - 0.5));
  col += turq * fil * 0.18 * smoothstep(0.4, 0.85, hn) * nearFade;

  // World-anchored tactical grid: the ship visibly moves through it.
  vec2 gp = world / 40.0;
  vec2 gd = abs(fract(gp - 0.5) - 0.5) / max(fwidth(gp), vec2(1e-4));
  float grid = 1.0 - min(min(gd.x, gd.y), 1.0);
  col += vec3(0.08, 0.62, 0.68) * grid * 0.32 * (1.0 - smoothstep(500.0, 2600.0, dist));

  // Ship frame.
  vec2 fwd = vec2(sin(u_heading), cos(u_heading));
  vec2 right = vec2(fwd.y, -fwd.x);
  float a = dot(local, fwd);
  float c = dot(local, right);
  float halfL = u_shipLen * 0.5;
  float halfB = u_beam * 0.5;
  float e = length(vec2(a / halfL, c / halfB));
  float spd = max(u_speed, 2.5);
  float ws = clamp(spd / 8.0, 0.3, 1.2);

  float wake = 0.0;
  float b = -(a + halfL * 0.85);
  if (b > 0.0) {
    // Kelvin wake arms (19.5 degree half angle) with travelling ripples.
    float fadeB = exp(-b / (750.0 * ws));
    float armW = 3.0 + b * 0.03;
    float arm = exp(-pow((abs(c) - b * 0.354) / armW, 2.0));
    float rip = 0.5 + 0.5 * sin(b * 0.25 - t * 3.0);
    wake += arm * (0.45 + 0.55 * rip) * fadeB;
    // Turbulent centreline.
    float cw = halfB * 0.75 + b * 0.035;
    float centre = exp(-pow(c / cw, 2.0)) * exp(-b / (380.0 * ws));
    float churn = wv_fbm(vec2(c * 0.15, b * 0.06 - t * spd * 0.06) + world * 0.01);
    wake += centre * smoothstep(0.3, 0.8, churn) * 1.3;
    // Transverse waves between the arms.
    float inside = smoothstep(b * 0.354, b * 0.354 - 8.0, abs(c));
    wake += inside * pow(0.5 + 0.5 * sin(b * 0.18 - t * 2.2), 6.0) * 0.35 * fadeB;
  }
  // Hull foam, strongest at the bow.
  float hull = exp(-pow((e - 1.1) / 0.2, 2.0));
  float bow = smoothstep(0.1, 1.0, a / halfL);
  float foamN = wv_noise(local * 0.35 + t * 1.6);
  wake += hull * (0.35 + bow * 1.2) * smoothstep(0.2, 0.7, foamN) * 1.4;
  wake *= ws;
  col += neon * wake * 1.4;

  // Expanding ripples + fixed range rings around the vessel.
  float r = length(local);
  float rings = pow(0.5 + 0.5 * sin(r * 0.09 - t * 1.6), 10.0) * exp(-r / 450.0) * smoothstep(halfL * 0.8, halfL * 1.6, r);
  col += turq * rings * 0.55;
  float fr = max(fwidth(r), 0.01);
  float hud = 0.0;
  for (int i = 1; i <= 3; i++) {
    hud += 1.0 - smoothstep(0.0, 1.3, abs(r - float(i) * 180.0) / fr);
  }
  col += turq * hud * 0.4;

  // Fade into the dark horizon.
  col = mix(col, deep * 0.5, smoothstep(2500.0, 11000.0, r));

  material.diffuse = col;
  material.alpha = 1.0;
}
`;

export interface OceanHandle {
  model: Cesium.Model;
  shader: Cesium.CustomShader;
}

export async function createOcean(): Promise<OceanHandle> {
  const shader = new Cesium.CustomShader({
    lightingModel: Cesium.LightingModel.UNLIT,
    translucencyMode: Cesium.CustomShaderTranslucencyMode.OPAQUE,
    uniforms: {
      u_time: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_offset: { type: Cesium.UniformType.VEC2, value: new Cesium.Cartesian2(0, 0) },
      u_heading: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_speed: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_shipLen: { type: Cesium.UniformType.FLOAT, value: 110 },
      u_beam: { type: Cesium.UniformType.FLOAT, value: 18 },
    },
    varyings: { v_local: Cesium.VaryingType.VEC2 },
    vertexShaderText: VERTEX_GLSL,
    fragmentShaderText: FRAGMENT_GLSL,
  });
  const model = await Cesium.Model.fromGltfAsync({
    gltf: buildOceanGlb(),
    upAxis: Cesium.Axis.Z,
    forwardAxis: Cesium.Axis.X,
    customShader: shader,
    shadows: Cesium.ShadowMode.DISABLED,
    backFaceCulling: false,
    show: false,
  } as unknown as Parameters<typeof Cesium.Model.fromGltfAsync>[0]);
  return { model, shader };
}

/** Glowing dot used for splash particles. */
export function createSprayImage(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(170,255,250,0.95)");
    g.addColorStop(0.6, "rgba(20,230,220,0.35)");
    g.addColorStop(1, "rgba(0,180,200,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
  }
  return c;
}

const gravityScratch = new Cesium.Cartesian3();
export function sprayGravity(particle: Cesium.Particle, dt: number): void {
  Cesium.Cartesian3.normalize(particle.position, gravityScratch);
  Cesium.Cartesian3.multiplyByScalar(gravityScratch, -9.8 * dt, gravityScratch);
  particle.velocity = Cesium.Cartesian3.add(particle.velocity, gravityScratch, particle.velocity);
}

export function createSpray(image: HTMLCanvasElement, cone: number, size: [number, number], speed: [number, number]): Cesium.ParticleSystem {
  return new Cesium.ParticleSystem({
    image,
    startColor: Cesium.Color.fromCssColorString("#e8fffd").withAlpha(1),
    endColor: Cesium.Color.fromCssColorString("#14e6dc").withAlpha(0),
    startScale: 1,
    endScale: 0.35,
    minimumParticleLife: 0.7,
    maximumParticleLife: 1.6,
    minimumSpeed: speed[0],
    maximumSpeed: speed[1],
    minimumImageSize: new Cesium.Cartesian2(size[0], size[0]),
    maximumImageSize: new Cesium.Cartesian2(size[1], size[1]),
    sizeInMeters: true,
    emissionRate: 160,
    emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(cone)),
    lifetime: 16,
    loop: true,
    updateCallback: sprayGravity,
    show: false,
  });
}
