/**
 * 1M-triangle end-to-end engine benchmark.
 *
 *   npm run bench
 *
 * Generates a subdivided cube (1,080,000 triangles, sharp 90° edges so there is
 * something to bevel), then times import, repair/analysis and a bevel of the
 * first 400 candidate edges. The STL is written to the OS temp folder, never
 * into the repository.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseStl } from '../src/engine/io/stl';
import { analyzeParsedStl } from '../src/engine/analyze';
import { initKernel, bevelMesh } from '../src/engine/bevel/kernel';
import { DEFAULT_BEVEL, EDGE_CONVEX, type MeshData } from '../src/engine/types';

const SEGMENTS = Number(process.env.BENCH_SEGMENTS ?? 300); // 6 faces × 2 × N² triangles
const SIZE = 300; // mm
const BEVEL_EDGES = 400;
// The kernel caps a short edge with a termination at 0.45 × its length;
// subdivided cube edges are one step long, so scale the radius to the tessellation.
const bevelWidth = Math.min(2, (SIZE / SEGMENTS) * 0.15);

function buildCube(segments: number, size: number): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const step = size / segments;

  type P = [number, number, number];
  const faces: { at: (u: number, v: number) => P; outward: P }[] = [
    { at: (u, v) => [size, u, v], outward: [1, 0, 0] },
    { at: (u, v) => [0, u, v], outward: [-1, 0, 0] },
    { at: (u, v) => [u, size, v], outward: [0, 1, 0] },
    { at: (u, v) => [u, 0, v], outward: [0, -1, 0] },
    { at: (u, v) => [u, v, size], outward: [0, 0, 1] },
    { at: (u, v) => [u, v, 0], outward: [0, 0, -1] },
  ];

  const quad = (a: P, b: P, c: P, d: P, outward: P) => {
    const base = positions.length / 3;
    for (const p of [a, b, c, d]) positions.push(p[0], p[1], p[2]);

    // Emit both triangles facing away from the cube interior.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const flip = nx * outward[0] + ny * outward[1] + nz * outward[2] < 0;
    if (flip) indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (const face of faces) {
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < segments; j++) {
        const u0 = i * step;
        const u1 = (i + 1) * step;
        const v0 = j * step;
        const v1 = (j + 1) * step;
        quad(face.at(u0, v0), face.at(u1, v0), face.at(u1, v1), face.at(u0, v1), face.outward);
      }
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const dir = join(tmpdir(), 'bevel-bench');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'cube-1m.stl');

console.log('building cube…');
const cube = buildCube(SEGMENTS, SIZE);
console.log(`  ${cube.indices.length / 3} triangles, ${cube.positions.length / 3} vertices`);

// Binary STL
const buffer = new ArrayBuffer(84 + (cube.indices.length / 3) * 50);
const view = new DataView(buffer);
view.setUint32(80, cube.indices.length / 3, true);
let offset = 84;
for (let t = 0; t < cube.indices.length; t += 3) {
  offset += 12;
  for (let k = 0; k < 3; k++) {
    const v = cube.indices[t + k] * 3;
    view.setFloat32(offset, cube.positions[v], true);
    view.setFloat32(offset + 4, cube.positions[v + 1], true);
    view.setFloat32(offset + 8, cube.positions[v + 2], true);
    offset += 12;
  }
  offset += 2;
}
writeFileSync(file, Buffer.from(buffer));
console.log(`  wrote ${file} (${mb(buffer.byteLength)})`);

const heapStart = process.memoryUsage().heapUsed;

console.log('parsing…');
let started = performance.now();
const parsed = parseStl(buffer);
const parseMs = performance.now() - started;
console.log(`  parse done (${parseMs.toFixed(0)} ms)`);

console.log('analyzing…');
started = performance.now();
const analyzed = analyzeParsedStl(parsed, 'cube-1m.stl');
const analyzeMs = performance.now() - started;
console.log(`  analyze done (${analyzeMs.toFixed(0)} ms)`);

let candidates = 0;
for (let i = 0; i < analyzed.edges.count; i++) {
  if (analyzed.edges.flags[i] & EDGE_CONVEX) candidates++;
}

await initKernel();
console.log('kernel ready');

const ids: number[] = [];
for (let i = 0; i < analyzed.edges.count && ids.length < BEVEL_EDGES; i++) {
  if (analyzed.edges.flags[i] & EDGE_CONVEX) ids.push(i);
}

started = performance.now();
const bevel = bevelMesh(
  analyzed.mesh,
  Uint32Array.from(ids),
  { ...DEFAULT_BEVEL, width: bevelWidth, segments: 3, clampOverlap: true },
);
const bevelMs = performance.now() - started;

const heapEnd = process.memoryUsage().heapUsed;

console.log('\nresult');
console.log(`  parse + weld     ${parseMs.toFixed(0)} ms   ${parsed.triangles} tris → ${parsed.mesh.positions.length / 3} verts`);
console.log(`  repair + edges   ${analyzeMs.toFixed(0)} ms   ${analyzed.edges.count} edges, ${candidates} convex`);
console.log(`  watertight       ${analyzed.meta.watertight}, ${analyzed.meta.shells} shell(s), genus ${analyzed.meta.genus}`);
console.log(`  bevel ${String(ids.length).padStart(4)} edges  ${bevelMs.toFixed(0)} ms   ${bevel.mesh.indices.length / 3} tris, status ${bevel.status}`);
console.log(
  `  bevel phases    build ${bevel.timings.buildMs.toFixed(0)} ms, boolean ${bevel.timings.booleanMs.toFixed(0)} ms, total ${bevel.timings.totalMs.toFixed(0)} ms
` +
  `  bevel detail    clamped ${bevel.clampedEdges}, volume ${bevel.volumeBefore.toFixed(1)} → ${bevel.volumeAfter.toFixed(1)} mm³, warnings [${bevel.warnings.map((w) => w.code).join(', ')}]`,
);
console.log(`  heap             ${mb(heapEnd)} (Δ ${mb(heapEnd - heapStart)})`);

// The 51.5 MB STL is only useful while the benchmark runs.
if (!process.argv.includes('--keep')) {
  rmSync(dir, { recursive: true, force: true });
  console.log('  cleaned benchmark STL (pass --keep to retain it)');
}
