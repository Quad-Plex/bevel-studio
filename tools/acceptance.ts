/**
 * Reference acceptance: bevel the unoptimized hook with the tool's own kernel
 * and compare it with the model the user produced by hand in Blender.
 *
 *   npm run acceptance
 *
 * Exits non-zero when the shape leaves its tolerance window, so this can gate
 * a release instead of only printing numbers.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStl } from '../src/engine/io/stl';
import { analyzeParsedStl } from '../src/engine/analyze';
import { initKernel, bevelMesh, meshToStl } from '../src/engine/bevel/kernel';
import { DEFAULT_BEVEL, EDGE_CONVEX, type BevelParams, type MeshData } from '../src/engine/types';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readFixture(name: string): MeshData {
  const buffer = readFileSync(resolve(root, 'public/fixtures', name));
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return parseStl(copy as ArrayBuffer).mesh;
}

function volumeOf(mesh: MeshData): number {
  const { positions: p, indices: idx } = mesh;
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    v +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return Math.abs(v);
}

function bboxSize(mesh: MeshData): [number, number, number] {
  const { positions: p } = mesh;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
  }
  return [maxX - minX, maxY - minY, maxZ - minZ];
}

function row(label: string, mesh: MeshData): string {
  const [x, y, z] = bboxSize(mesh);
  return `${label.padEnd(20)} ${String(mesh.indices.length / 3).padStart(6)} tri  ${volumeOf(mesh)
    .toFixed(2)
    .padStart(9)} mm³  ${x.toFixed(2)} × ${y.toFixed(2)} × ${z.toFixed(2)}`;
}

const baseParsed = parseStl(
  (() => {
    const b = readFileSync(resolve(root, 'public/fixtures/hook-base.stl'));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  })(),
  'hook-base.stl',
);
const analyzed = analyzeParsedStl(baseParsed, 'hook-base.stl');
const reference = readFixture('hook-reference.stl');

const params: BevelParams = {
  ...DEFAULT_BEVEL,
  width: 0.5,
  segments: 4,
  profile: 0.5,
  clampOverlap: false,
};

function select(excludePlate: boolean): Uint32Array {
  const ids: number[] = [];
  const { edges } = analyzed;
  for (let i = 0; i < edges.count; i++) {
    if (!(edges.flags[i] & EDGE_CONVEX)) continue;
    if (edges.dihedral[i] < 20) continue;
    const o = i * 6;
    const midX = (edges.position[o] + edges.position[o + 3]) / 2;
    if (excludePlate && midX < -16.9) continue;
    ids.push(i);
  }
  return Uint32Array.from(ids);
}

interface Expectation {
  label: string;
  excludePlate: boolean;
  triangles: [number, number];
  volume: [number, number];
  bboxY: [number, number];
}

// Tolerance windows are ~0.3 % on volume and 0.05 mm on the silhouette. The
// triangle count is deliberately wide: CSG retriangulates trimmed faces, so
// tessellation is not part of the shape contract.
const cases: Expectation[] = [
  {
    label: 'all convex',
    excludePlate: false,
    triangles: [2000, 3500],
    volume: [12700, 12860],
    bboxY: [61.85, 62.0],
  },
  {
    // Rebased on the repaired fixture (R1b): the old 0.02 mm knife wall no
    // longer exists, so the previous result's ~40 mm³ double-knife over-cut
    // is gone. The hand reference model is unchanged. The repaired 72° corner
    // is the correct surface; this window is the measured repaired result,
    // not a tolerance relaxation of the hand model.
    label: 'outside only',
    excludePlate: true,
    triangles: [400, 1600],
    volume: [12760, 12855],
    bboxY: [62.05, 62.25],
  },
];

await initKernel();
mkdirSync(resolve(root, 'renders'), { recursive: true });

const failures: string[] = [];
const lines: string[] = [];

const referenceVolume = volumeOf(reference);
lines.push(row('source', analyzed.mesh));
lines.push(row('reference (Blender)', reference));
if (Math.abs(referenceVolume - 12788.47) > 0.05) {
  failures.push(`reference volume drifted: ${referenceVolume.toFixed(2)}`);
}

for (const expectation of cases) {
  const started = performance.now();
  const result = bevelMesh(analyzed.mesh, select(expectation.excludePlate), params, analyzed.edges.maxWidth);
  const ms = performance.now() - started;
  const volume = volumeOf(result.mesh);
  const [, bboxY] = bboxSize(result.mesh);
  const triangles = result.mesh.indices.length / 3;

  const file = expectation.excludePlate ? 'hook-tool-outside.stl' : 'hook-tool-all.stl';
  writeFileSync(resolve(root, 'renders', file), Buffer.from(meshToStl(result.mesh)));

  const checks: [string, boolean][] = [
    ['status', result.status === 'NoError'],
    ['shells', result.shells === 1],
    ['triangles', triangles >= expectation.triangles[0] && triangles <= expectation.triangles[1]],
    ['volume', volume >= expectation.volume[0] && volume <= expectation.volume[1]],
    ['bboxY', bboxY >= expectation.bboxY[0] && bboxY <= expectation.bboxY[1]],
  ];

  // Both selections are export-clean: watertight and free of crossings.
  checks.push(['selfIntersections', result.selfIntersections === 0]);
  checks.push(['watertight', result.meta.watertight]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  for (const name of failed) failures.push(`${expectation.label}: ${name}`);

  const verdict = failed.length === 0 ? 'PASS' : `FAIL (${failed.join(', ')})`;
  lines.push(`${row(expectation.label, result.mesh)}  ${ms.toFixed(0)} ms  ${verdict}`);
}

console.log(lines.join('\n'));
if (failures.length > 0) {
  console.error(`\nAcceptance failed: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('\nAcceptance passed.');
}
