// Dev utility: prints world-space bounds and orientation hints for the GLB models.
// Usage: node scripts/analyze-glb.mjs artifacts/worldview/public/aeroplane.glb
import { readFileSync } from "node:fs";

function mat4Mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function nodeMatrix(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart);
  const pts = [];

  const visit = (idx, parent) => {
    const n = gltf.nodes[idx];
    const m = mat4Mul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) {
      for (const p of gltf.meshes[n.mesh].primitives) {
        const acc = gltf.accessors[p.attributes.POSITION];
        if (acc.bufferView === undefined) {
          // Draco-compressed: use accessor bounds (8 corners) instead of raw vertices.
          const [a0, a1, a2] = acc.min, [b0, b1, b2] = acc.max;
          for (const x of [a0, b0]) for (const y of [a1, b1]) for (const z of [a2, b2])
            pts.push([
              m[0] * x + m[4] * y + m[8] * z + m[12],
              m[1] * x + m[5] * y + m[9] * z + m[13],
              m[2] * x + m[6] * y + m[10] * z + m[14],
            ]);
          continue;
        }
        const bv = gltf.bufferViews[acc.bufferView];
        const stride = bv.byteStride ?? 12;
        const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const step = Math.max(1, Math.floor(acc.count / 4000));
        for (let i = 0; i < acc.count; i += step) {
          const o = off + i * stride;
          const x = bin.readFloatLE(o), y = bin.readFloatLE(o + 4), z = bin.readFloatLE(o + 8);
          pts.push([
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          ]);
        }
      }
    }
    for (const c of n.children ?? []) visit(c, m);
  };
  const scene = gltf.scenes[gltf.scene ?? 0];
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of scene.nodes) visit(r, I);

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  const size = max.map((v, k) => v - min[k]);
  // glTF is Y-up. Top 15% (by Y) of vertices: mean X/Z shows where the tail fin / superstructure is.
  const yCut = max[1] - size[1] * 0.15;
  const top = pts.filter((p) => p[1] >= yCut);
  const mean = (arr, k) => arr.reduce((s, p) => s + p[k], 0) / arr.length;
  console.log(file.split("/").pop(), JSON.stringify({
    extensions: gltf.extensionsUsed ?? [],
    min: min.map((v) => +v.toFixed(3)), max: max.map((v) => +v.toFixed(3)), size: size.map((v) => +v.toFixed(3)),
    center: [mean(pts, 0), mean(pts, 1), mean(pts, 2)].map((v) => +v.toFixed(3)),
    topMeanXZ: [mean(top, 0), mean(top, 2)].map((v) => +v.toFixed(3)),
  }));
}
