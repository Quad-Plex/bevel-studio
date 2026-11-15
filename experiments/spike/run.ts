/**
 * Kernel spike CLI.
 *
 *   npm run spike -- [flags]
 *     --test=A,B,C,D,E     which tests to run (default: all)
 *     --width=0.5          bevel radius for C/D
 *     --segments=4
 *     --profile=0.5
 *     --angle=20           candidate dihedral threshold for C/D
 *     --inflate=0          fillet arc inset in mm (0 = exact tangency)
 *     --taper=auto|none    termination rule
 *     --clamp=on|off       per-edge maxWidth clamp for C/D
 *
 * Prints a compact JSON report and writes experiments/spike/report.json plus
 * STL exports in experiments/spike/out/. Everything is millimetres, nothing is
 * rescaled or recentred.
 */
import Module from 'manifold-3d';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStl, meshBounds, signedVolume, weld, type MeshData } from './load';
import { buildEdgeTable, edgeStats, ensureOutward, vertexIncidence, type EdgeTable } from './edges';
import {
  buildCornerCut,
  buildEdgeCutSolid,
  expectedCutVolume,
  sliverArea,
  toManifold,
  type EdgeCutParams,
  type Vec3,
} from './cut';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const HOOK = 'C:/Users/basti/AI_printing/example_stl_beveling/Desk_Hook_Quatsch_unoptimized.stl';

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : 'true';
};
const num = (name: string, fallback: number): number => {
  const v = Number(flag(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
};

const TESTS = new Set(flag('test', 'A,B,C,D,E').split(',').map((s) => s.trim().toUpperCase()));
const WIDTH = num('width', 0.5);
const SEGMENTS = Math.max(1, Math.round(num('segments', 4)));
const PROFILE = Math.min(1, Math.max(0, num('profile', 0.5)));
const ANGLE = num('angle', 20);
const INFLATE = num('inflate', 0);
const TAPER = flag('taper', 'auto') as 'auto' | 'none';
const CLAMP = flag('clamp', 'on') !== 'off';
const CORNERS = flag('corners', 'on') !== 'off';
const ONLY = flag('only', '');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Timings = { build: number; boolean: number; clean: number; total: number };

const round = (n: number, digits = 4): number => {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
};

function bboxOf(m: MeshData) {
  const b = meshBounds(m);
  return { min: b.min.map((v) => round(v, 3)), max: b.max.map((v) => round(v, 3)), size: b.size.map((v) => round(v, 3)) };
}

/** Manifold MeshGL → plain MeshData (first three properties). */
function toMeshData(out: ReturnType<Manifold['getMesh']>): MeshData {
  const np = out.numProp;
  const positions = new Float32Array((out.vertProperties.length / np) * 3);
  for (let i = 0, n = out.vertProperties.length / np; i < n; i++) {
    positions[i * 3] = out.vertProperties[i * np];
    positions[i * 3 + 1] = out.vertProperties[i * np + 1];
    positions[i * 3 + 2] = out.vertProperties[i * np + 2];
  }
  return { positions, indices: new Uint32Array(out.triVerts) };
}

interface BevelOptions {
  width: number;
  segments: number;
  profile: number;
  clamp: boolean;
  minAngle: number;
  inflate: number;
  taper: 'auto' | 'none';
  cornerSegments: number;
  corners: boolean;
  edgeFilter?: (e: number, table: EdgeTable) => boolean;
}

interface CutSet {
  solids: Manifold[];
  cutTriangles: number;
  selected: number[];
  appliedWidth: { min: number; max: number; median: number; full: number; clamped: number; skipped: number };
  corners: number;
  unsupportedCorners: number;
  skippedShort: number;
  expectedRemoved: number;
  buildMs: number;
  notes: string[];
}

/** Selection, clamping, corner detection and cut-solid construction. */
function collectCuts(wasm: ManifoldToplevel, mesh: MeshData, table: EdgeTable, opts: BevelOptions): CutSet {
  const t0 = performance.now();
  const notes: string[] = [];

  const selected: number[] = [];
  for (let e = 0; e < table.count; e++) {
    if (table.convex[e] !== 1) continue;
    if (table.dihedral[e] < opts.minAngle) continue;
    if (opts.edgeFilter && !opts.edgeFilter(e, table)) continue;
    selected.push(e);
  }
  const selectedSet = new Set(selected);

  // per-edge clamp: PLAN §4.4.4 wants a single global width, but a global min
  // over this model's sliver triangles collapses to 0.002 mm, so clamp per edge
  // and drop edges with no room at all.
  const widthOf = new Float32Array(table.count).fill(-1);
  let full = 0, clamped = 0, skipped = 0;
  const used: number[] = [];
  for (const e of selected) {
    const lim = opts.clamp ? Math.min(opts.width, 0.98 * table.maxWidth[e]) : opts.width;
    if (lim < opts.width * 0.05) { skipped++; continue; }
    widthOf[e] = lim;
    used.push(e);
    if (lim >= opts.width - 1e-9) full++; else clamped++;
  }
  const sorted = used.map((e) => widthOf[e]).sort((a, b) => a - b);
  const appliedWidth = {
    min: sorted.length ? sorted[0] : 0,
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    full,
    clamped,
    skipped,
  };

  // corners: a vertex with exactly three sharp incident edges, all selected
  const vertexCount = mesh.positions.length / 3;
  const incidence = vertexIncidence(table, vertexCount);
  const corner = new Uint8Array(vertexCount);
  const cornerNormals: (Vec3[] | null)[] = new Array(vertexCount).fill(null);
  const cornerWidth = new Float32Array(vertexCount);
  let unsupportedCorners = 0;

  for (let v = 0; v < vertexCount; v++) {
    const s = incidence.offset[v];
    const e = incidence.offset[v + 1];
    let sharp = 0;
    let allSelected = true;
    let minW = Infinity;
    const nrm: Vec3[] = [];
    for (let i = s; i < e; i++) {
      const ei = incidence.ids[i];
      if (table.dihedral[ei] < 0.5) continue;
      sharp++;
      if (!selectedSet.has(ei)) allSelected = false;
      if (widthOf[ei] > 0) minW = Math.min(minW, widthOf[ei]);
      for (const off of [0, 3]) {
        const n: Vec3 = [table.normals[ei * 6 + off], table.normals[ei * 6 + off + 1], table.normals[ei * 6 + off + 2]];
        if (!nrm.some((m) => m[0] * n[0] + m[1] * n[1] + m[2] * n[2] > 1 - 1e-7)) nrm.push(n);
      }
    }
    if (sharp !== 3 || !allSelected) continue;
    if (nrm.length !== 3 || !Number.isFinite(minW)) {
      unsupportedCorners++;
      continue;
    }
    corner[v] = 1;
    cornerNormals[v] = nrm;
    cornerWidth[v] = minW;
  }

  const solids: Manifold[] = [];
  let cutTriangles = 0;
  let skippedShort = 0;
  let expectedRemoved = 0;
  let corners = 0;

  for (const e of used) {
    const a: Vec3 = [table.position[e * 6], table.position[e * 6 + 1], table.position[e * 6 + 2]];
    const b: Vec3 = [table.position[e * 6 + 3], table.position[e * 6 + 4], table.position[e * 6 + 5]];
    const n1: Vec3 = [table.normals[e * 6], table.normals[e * 6 + 1], table.normals[e * 6 + 2]];
    const n2: Vec3 = [table.normals[e * 6 + 3], table.normals[e * 6 + 4], table.normals[e * 6 + 5]];
    const L = table.length[e];
    const w = widthOf[e];
    if (L < 4 * w) {
      skippedShort++;
      continue;
    }
    const cut: EdgeCutParams = {
      radius: w,
      segments: opts.segments,
      profile: opts.profile,
      inflate: opts.inflate,
      taperA: opts.taper === 'none' || corner[table.v[e * 2]] ? 0 : Math.min(w, 0.25 * L),
      taperB: opts.taper === 'none' || corner[table.v[e * 2 + 1]] ? 0 : Math.min(w, 0.25 * L),
      taperStations: 1,
      extend: 0,
    };
    const solid = buildEdgeCutSolid(a, b, n1, n2, cut);
    if (!solid) continue;
    try {
      solids.push(toManifold(wasm, solid));
    } catch {
      notes.push(`cut solid rejected for edge ${e}`);
      continue;
    }
    cutTriangles += solid.indices.length / 3;
    const area = sliverArea(w, opts.segments, opts.profile, n1, n2, [b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    expectedRemoved += expectedCutVolume(area, L, cut.taperA, cut.taperB);
  }

  for (let v = 0; v < vertexCount && opts.corners; v++) {
    if (!corner[v]) continue;
    const nrm = cornerNormals[v];
    if (!nrm) continue;
    const p: Vec3 = [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
    const solid = buildCornerCut(wasm, p, nrm, cornerWidth[v], opts.cornerSegments, opts.inflate);
    if (!solid) {
      unsupportedCorners++;
      continue;
    }
    solids.push(solid);
    corners++;
    cutTriangles += solid.numTri();
  }

  return {
    solids,
    cutTriangles,
    selected: used,
    appliedWidth,
    corners,
    unsupportedCorners,
    skippedShort,
    expectedRemoved,
    buildMs: performance.now() - t0,
    notes,
  };
}

/**
 * Post-clean (PLAN §4.4.7): drop zero-volume components the boolean leaves at
 * tangent seams, then snap to float32 and rebuild. The snap is essential: a
 * boolean can put two vertices closer than float32 resolution, which makes
 * them coincide in the exported STL and turns the mesh non-manifold on
 * re-import.
 */
function cleanup(wasm: ManifoldToplevel, m: Manifold, baseVolume: number): {
  manifold: Manifold;
  droppedComponents: number;
  weldedVerts: number;
} {
  const parts = m.decompose();
  const eps = Math.max(1e-9, Math.abs(baseVolume) * 1e-9);
  const keep = parts.filter((p) => Math.abs(p.volume()) > eps);
  let out = keep.length === 0 ? m : keep.length === 1 ? keep[0] : wasm.Manifold.union(keep);

  const mesh = toMeshData(out.getMesh());
  const welded = weld(mesh.positions, mesh.indices, 1e-4);
  const before = mesh.positions.length / 3;
  const after = welded.positions.length / 3;
  try {
    out = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: welded.positions, triVerts: welded.indices }));
  } catch {
    // keep the uncleaned manifold if the rebuild is rejected
  }
  return { manifold: out, droppedComponents: parts.length - keep.length, weldedVerts: before - after };
}

interface BevelOutcome extends CutSet {
  result: Manifold;
  mesh: MeshData;
  timings: Timings;
  droppedComponents: number;
  weldedVerts: number;
}

function bevel(wasm: ManifoldToplevel, mesh: MeshData, table: EdgeTable, opts: BevelOptions): BevelOutcome {
  const t0 = performance.now();
  const cuts = collectCuts(wasm, mesh, table, opts);
  const base = toManifold(wasm, mesh);

  const tb = performance.now();
  const union = cuts.solids.length === 0 ? null : cuts.solids.length === 1 ? cuts.solids[0] : wasm.Manifold.union(cuts.solids);
  const raw = union ? base.subtract(union) : base;
  void raw.numTri(); // force the deferred CSG tree inside the timed region
  const booleanMs = performance.now() - tb;

  const tc = performance.now();
  const cleaned = cleanup(wasm, raw, base.volume());
  const cleanMs = performance.now() - tc;

  return {
    ...cuts,
    result: cleaned.manifold,
    mesh: toMeshData(cleaned.manifold.getMesh()),
    droppedComponents: cleaned.droppedComponents,
    weldedVerts: cleaned.weldedVerts,
    timings: { build: cuts.buildMs, boolean: booleanMs, clean: cleanMs, total: performance.now() - t0 },
  };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

interface Validation {
  triangles: number;
  vertices: number;
  volume: number;
  status: string;
  shells: number;
  genus: number;
  bbox: { min: number[]; max: number[]; size: number[] };
  /** edge-use counts by index: the topological truth */
  boundaryEdges: number;
  nonManifoldEdges: number;
  /** vertices that collide after the float32 snap (break a naive re-import) */
  duplicatePositions: number;
  zeroAreaTriangles: number;
  /** weld at the 1e-4 import tolerance, as the app will on re-import */
  reimport: { boundaryEdges: number; nonManifoldEdges: number; vertices: number };
  selfIntersections: number | 'skipped';
}

function validate(wasm: ManifoldToplevel, m: Manifold, mesh: MeshData, light = false): Validation {
  const bbox = bboxOf(mesh);
  const raw = edgeUseByIndex(mesh);
  const rewelded = weld(mesh.positions, mesh.indices, 1e-4);
  const re = edgeUseByIndex(rewelded);
  const shells = light ? -1 : m.decompose().length;
  return {
    triangles: m.numTri(),
    vertices: m.numVert(),
    volume: m.volume(),
    status: m.status(),
    shells,
    genus: !light && shells === 1 ? m.genus() : -1,
    bbox,
    boundaryEdges: raw.boundary,
    nonManifoldEdges: raw.nonManifold,
    duplicatePositions: countDuplicatePositions(mesh),
    zeroAreaTriangles: countDegenerate(mesh),
    reimport: { boundaryEdges: re.boundary, nonManifoldEdges: re.nonManifold, vertices: rewelded.positions.length / 3 },
    selfIntersections: !light && m.numTri() <= 3000 ? countSelfIntersections(mesh) : 'skipped',
  };
}

function edgeUseByIndex(mesh: MeshData): { boundary: number; nonManifold: number } {
  const map = new Map<string, number>();
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k];
      const b = idx[t + ((k + 1) % 3)];
      const kk = a < b ? `${a}_${b}` : `${b}_${a}`;
      map.set(kk, (map.get(kk) ?? 0) + 1);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const n of map.values()) {
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
  }
  return { boundary, nonManifold };
}

function countDuplicatePositions(mesh: MeshData): number {
  const p = mesh.positions;
  const seen = new Set<string>();
  let dup = 0;
  for (let i = 0; i < p.length / 3; i++) {
    const k = `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
    if (seen.has(k)) dup++;
    else seen.add(k);
  }
  return dup;
}

function countDegenerate(mesh: MeshData): number {
  const { positions: p, indices } = mesh;
  let n = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) / 2 <= 1e-12) n++;
  }
  return n;
}

/**
 * Triangle-triangle intersection via the separating-axis theorem, ignoring
 * pairs that share a vertex. Coplanar overlaps count as penetrations.
 * O(T²) with an AABB prefilter, only for small meshes.
 */
function countSelfIntersections(mesh: MeshData): number {
  const { positions: p, indices: idx } = mesh;
  const T = idx.length / 3;
  const c = new Float64Array(T * 9);
  const box = new Float64Array(T * 6);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      const x = p[v], y = p[v + 1], z = p[v + 2];
      c[t * 9 + k * 3] = x;
      c[t * 9 + k * 3 + 1] = y;
      c[t * 9 + k * 3 + 2] = z;
      if (k === 0) {
        box[t * 6] = box[t * 6 + 3] = x;
        box[t * 6 + 1] = box[t * 6 + 4] = y;
        box[t * 6 + 2] = box[t * 6 + 5] = z;
      } else {
        box[t * 6] = Math.min(box[t * 6], x);
        box[t * 6 + 1] = Math.min(box[t * 6 + 1], y);
        box[t * 6 + 2] = Math.min(box[t * 6 + 2], z);
        box[t * 6 + 3] = Math.max(box[t * 6 + 3], x);
        box[t * 6 + 4] = Math.max(box[t * 6 + 4], y);
        box[t * 6 + 5] = Math.max(box[t * 6 + 5], z);
      }
    }
  }
  const eps = 1e-7;
  let hits = 0;
  for (let i = 0; i < T; i++) {
    for (let j = i + 1; j < T; j++) {
      if (
        box[i * 6] > box[j * 6 + 3] + eps || box[j * 6] > box[i * 6 + 3] + eps ||
        box[i * 6 + 1] > box[j * 6 + 4] + eps || box[j * 6 + 1] > box[i * 6 + 4] + eps ||
        box[i * 6 + 2] > box[j * 6 + 5] + eps || box[j * 6 + 2] > box[i * 6 + 5] + eps
      ) continue;
      if (sharesVertex(idx, i, j)) continue;
      if (trianglesIntersect(c, i, j)) hits++;
    }
  }
  return hits;
}

function sharesVertex(idx: Uint32Array, i: number, j: number): boolean {
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) if (idx[i * 3 + a] === idx[j * 3 + b]) return true;
  }
  return false;
}

function trianglesIntersect(c: Float64Array, i: number, j: number): boolean {
  const A = [c[i * 9], c[i * 9 + 1], c[i * 9 + 2]];
  const B = [c[i * 9 + 3], c[i * 9 + 4], c[i * 9 + 5]];
  const C = [c[i * 9 + 6], c[i * 9 + 7], c[i * 9 + 8]];
  const D = [c[j * 9], c[j * 9 + 1], c[j * 9 + 2]];
  const E = [c[j * 9 + 3], c[j * 9 + 4], c[j * 9 + 5]];
  const F = [c[j * 9 + 6], c[j * 9 + 7], c[j * 9 + 8]];

  const e1 = [subV(B, A), subV(C, B), subV(A, C)];
  const e2 = [subV(E, D), subV(F, E), subV(D, F)];
  const n1 = crossV(e1[0], e1[1]);
  const n2 = crossV(e2[0], e2[1]);
  const l1 = Math.hypot(n1[0], n1[1], n1[2]);
  const l2 = Math.hypot(n2[0], n2[1], n2[2]);
  if (l1 < 1e-14 || l2 < 1e-14) return false; // degenerate triangle

  const eps = 1e-9;
  const sd = [D, E, F].map((v) => dot3(subV(v, A), n1) / l1);
  if (sd.every((s) => s > eps) || sd.every((s) => s < -eps)) return false;
  const st = [A, B, C].map((v) => dot3(subV(v, D), n2) / l2);
  if (st.every((s) => s > eps) || st.every((s) => s < -eps)) return false;

  // coplanar: the 3-D axes all collapse, so test the 2-D outlines instead
  if (sd.every((s) => Math.abs(s) <= eps) && st.every((s) => Math.abs(s) <= eps)) {
    return coplanarOverlap2D([A, B, C], [D, E, F], n1);
  }

  const axes: number[][] = [n1, n2];
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      const x = crossV(e1[a], e2[b]);
      if (Math.hypot(x[0], x[1], x[2]) > 1e-12) axes.push(x);
    }
  }
  const tri1 = [A, B, C];
  const tri2 = [D, E, F];
  for (const ax of axes) {
    const l = Math.hypot(ax[0], ax[1], ax[2]);
    if (l < 1e-12) continue;
    const u = [ax[0] / l, ax[1] / l, ax[2] / l];
    let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
    for (const v of tri1) {
      const d = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
      if (d < min1) min1 = d;
      if (d > max1) max1 = d;
    }
    for (const v of tri2) {
      const d = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
      if (d < min2) min2 = d;
      if (d > max2) max2 = d;
    }
    if (max1 < min2 - eps || max2 < min1 - eps) return false;
  }
  return true;
}

const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 2-D separating-axis test for two coplanar triangles (project out the normal). */
function coplanarOverlap2D(t1: number[][], t2: number[][], n: number[]): boolean {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const drop = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  const proj = (p: number[]) => (drop === 0 ? [p[1], p[2]] : drop === 1 ? [p[0], p[2]] : [p[0], p[1]]);
  const P = t1.map(proj);
  const Q = t2.map(proj);
  const eps = 1e-9;
  const axes: number[][] = [];
  for (const poly of [P, Q]) {
    for (let k = 0; k < 3; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % 3];
      axes.push([a[1] - b[1], b[0] - a[0]]);
    }
  }
  for (const axis of axes) {
    const l = Math.hypot(axis[0], axis[1]);
    if (l < 1e-12) continue;
    const u = [axis[0] / l, axis[1] / l];
    let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
    for (const v of P) {
      const d = v[0] * u[0] + v[1] * u[1];
      if (d < min1) min1 = d;
      if (d > max1) max1 = d;
    }
    for (const v of Q) {
      const d = v[0] * u[0] + v[1] * u[1];
      if (d < min2) min2 = d;
      if (d > max2) max2 = d;
    }
    if (max1 <= min2 + eps || max2 <= min1 + eps) return false;
  }
  return true;
}

const subV = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a: number[], b: number[]): number[] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// ---------------------------------------------------------------------------
// STL writer
// ---------------------------------------------------------------------------

function writeStl(path: string, mesh: MeshData, header = 'Bevel Studio spike'): void {
  const { positions: p, indices } = mesh;
  const n = indices.length / 3;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write(header.slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8);
    o += 12;
    for (const v of [a, b, c]) {
      buf.writeFloatLE(p[v], o);
      buf.writeFloatLE(p[v + 1], o + 4);
      buf.writeFloatLE(p[v + 2], o + 8);
      o += 12;
    }
    buf.writeUInt16LE(0, o);
    o += 2;
  }
  writeFileSync(path, buf);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function cubeMesh(size = 20): MeshData {
  const s = size;
  const positions = new Float32Array([
    0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0,
    0, 0, s, s, 0, s, s, s, s, 0, s, s,
  ]);
  const indices = new Uint32Array([
    0, 3, 2, 0, 2, 1,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2,
    0, 4, 7, 0, 7, 3,
    1, 2, 6, 1, 6, 5,
  ]);
  return { positions, indices };
}

// ---------------------------------------------------------------------------
// report plumbing
// ---------------------------------------------------------------------------

interface TestReport {
  id: string;
  label: string;
  pass: boolean;
  base: { triangles: number; volume: number; bbox: { size: number[] } };
  selection: {
    edges: number; width: { min: number; max: number; median: number; full: number; clamped: number; skipped: number };
    corners: number; unsupportedCorners: number; skippedShort: number;
  };
  cuts: { solids: number; triangles: number };
  clean: { droppedComponents: number; weldedVerts: number };
  result: Validation & { removedVolume: number; bboxSize: number[] };
  ms: Timings;
  expected: { removedVolume: number; volume: number | null; note?: string };
  checks: Record<string, boolean | string | number>;
  notes: string[];
}

function checksFor(
  id: string,
  v: Validation,
  removed: number,
  exp: { removedVolume: number; volume: number | null; tolerance: number },
): Record<string, boolean | string | number> {
  const checks: Record<string, boolean | string | number> = {
    manifold: v.status === 'NoError',
    watertight: v.boundaryEdges === 0 && v.nonManifoldEdges === 0,
    oneShell: v.shells === 1,
    noZeroArea: v.zeroAreaTriangles === 0,
    noDuplicatePositions: v.duplicatePositions === 0,
    reimportsManifold: v.reimport.boundaryEdges === 0 && v.reimport.nonManifoldEdges === 0,
    selfIntersections: v.selfIntersections === 'skipped' ? 'skipped' : v.selfIntersections === 0,
    removedPositive: removed > 0,
  };
  if (exp.volume !== null) {
    checks.volumeWithinTolerance = Math.abs(v.volume - exp.volume) <= exp.tolerance;
    checks.volumeDelta = round(v.volume - exp.volume, 3);
  }
  if (exp.removedVolume > 0) checks.removedBelowPrediction = removed <= exp.removedVolume * 1.5 + 1e-6;
  if (id === 'B') checks.bboxUnchanged = v.bbox.size.every((s) => Math.abs(s - 20) < 1e-3);
  return checks;
}

const passes = (checks: Record<string, unknown>) => Object.values(checks).every((c) => c !== false);

function makeReport(
  id: string,
  label: string,
  base: { triangles: number; volume: number; bbox: { size: number[] } },
  out: BevelOutcome,
  v: Validation,
  exp: { removedVolume: number; volume: number | null; tolerance: number; note?: string },
  extraChecks: Record<string, boolean | string | number> = {},
): TestReport {
  const removed = base.volume - v.volume;
  const checks = { ...checksFor(id, v, removed, exp), ...extraChecks };
  return {
    id,
    label,
    pass: passes(checks),
    base,
    selection: { edges: out.selected.length, width: out.appliedWidth, corners: out.corners, unsupportedCorners: out.unsupportedCorners, skippedShort: out.skippedShort },
    cuts: { solids: out.solids.length, triangles: out.cutTriangles },
    clean: { droppedComponents: out.droppedComponents, weldedVerts: out.weldedVerts },
    result: { ...v, volume: round(v.volume, 3), bboxSize: v.bbox.size, removedVolume: round(removed, 3) },
    ms: {
      build: round(out.timings.build, 2),
      boolean: round(out.timings.boolean, 2),
      clean: round(out.timings.clean, 2),
      total: round(out.timings.total, 2),
    },
    expected: exp,
    checks,
    notes: out.notes,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const wasm = await Module();
  wasm.setup();

  const report: Record<string, unknown> = {
    kernel: 'manifold-3d 3.5.5 (wasm)',
    generatedAt: new Date().toISOString(),
    units: 'mm',
    flags: { width: WIDTH, segments: SEGMENTS, profile: PROFILE, angle: ANGLE, inflate: INFLATE, taper: TAPER, clamp: CLAMP },
    booleanMode: 'Manifold.union(cutSolids) once, then base.subtract(union) once; timing forces the deferred tree with numTri()',
    findings: [
      'PLAN §4.4.2: t1 = A + r·m2 is only the tangent point when the two faces are perpendicular; in general it is the foot of the perpendicular from the arc centre c onto each face.',
      'PLAN §4.4.4: clamping to 0.98·min(maxWidth) over the whole selection collapses to 0.002 mm on the reference model (sliver triangles with 0.001 mm altitude), which removes almost nothing. A per-edge clamp is required.',
      'PLAN §4.4.3: fading the radius to 0 over min(r, 0.25·L) at both ends of a 20 mm edge removes 16.27 mm³ instead of 18.77 mm³, so the "7981.2" expectation only holds for a full-length sweep.',
      'Test B expectation: 7900–7985 mm³ is inconsistent with the brief\'s own 18.77 mm³ per edge (12 × 18.77 + 8 corners ≈ 244 mm³ removed → 7756). Measured 7786.4, analytic 7785.',
      'manifold-3d 3.5.5 has no batchBoolean; Manifold.union(readonly Manifold[]) is the batched union and Manifold.difference(list) the batched difference.',
      'PLAN §5.3 says 87 candidates at dihedral ≥ 20°; 87 is the count of ALL convex edges (>0.5°), 77 are ≥ 20°.',
      'PLAN §9 ε-inset mitigation fails: shrinking the fillet arc turns the cut into a knife-edged slit that never reaches the surface (bbox unchanged, 2234 self-intersections). Not usable.',
      'A boolean can place two vertices closer than float32 resolution; the STL then welds them into degenerate triangles and re-imports non-manifold. Export must weld at 1e-4 mm and rebuild the Manifold first.',
      'CSG retriangulation costs triangles: 2204 vs the reference 654 for the same volume, mostly at terminations and trimmed faces.',
      'Corner spheres at 8 circular segments remove ~9 % more corner material than an exact sphere; at r=2 that is ~3 mm³ over 8 corners.',
    ],
    tests: [] as TestReport[],
    scale: null as unknown,
  };
  const tests = report.tests as TestReport[];

  // ---- cube fixtures ------------------------------------------------------
  if (TESTS.has('A') || TESTS.has('B')) {
    const cube = cubeMesh(20);
    const flipped = ensureOutward(cube);
    const table = buildEdgeTable(cube);
    const cubeStats = edgeStats(table);
    console.log(
      JSON.stringify({
        cube: {
          ...cubeStats,
          volume: round(signedVolume(cube), 3),
          flipped,
          minMaxWidth: round(Math.min(...table.maxWidth), 3),
        },
      }),
    );

    if (TESTS.has('B')) {
      const out = bevel(wasm, cube, table, {
        width: 2, segments: 4, profile: 0.5, clamp: false, minAngle: 20,
        inflate: INFLATE, taper: 'auto', cornerSegments: 8, corners: true,
      });
      const v = validate(wasm, out.result, out.mesh);
      const exp = { removedVolume: 244.0, volume: 7785, tolerance: 20, note: '12 edge prisms + 8 spherical octants; exact-circle rounded cube is 7804.7' };
      const t = makeReport('B', 'cube 20 mm, all 12 edges, r=2 seg 4, sphere corners', {
        triangles: 12, volume: round(signedVolume(cube), 3), bbox: { size: bboxOf(cube).size },
      }, out, v, exp, { roundedCorners: out.corners === 8 });
      tests.push(t);
      writeStl(join(OUT, 'cube-edges.stl'), out.mesh, 'cube 20mm all 12 edges r=2 seg4');
    }

    if (TESTS.has('A')) {
      const want: Vec3[] = [[20, 20, 0], [20, 20, 20]];
      let picked = -1;
      for (let e = 0; e < table.count; e++) {
        const a = [table.position[e * 6], table.position[e * 6 + 1], table.position[e * 6 + 2]];
        const b = [table.position[e * 6 + 3], table.position[e * 6 + 4], table.position[e * 6 + 5]];
        const match = (p: number[], q: Vec3) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(p[2] - q[2]) < 1e-6;
        if ((match(a, want[0]) && match(b, want[1])) || (match(a, want[1]) && match(b, want[0]))) { picked = e; break; }
      }
      if (picked < 0) throw new Error('cube edge (20,20,0)-(20,20,20) not found');

      for (const mode of ['none', 'auto'] as const) {
        const out = bevel(wasm, cube, table, {
          width: 2, segments: 4, profile: 0.5, clamp: false, minAngle: 20,
          inflate: INFLATE, taper: mode, cornerSegments: 8, corners: true,
          edgeFilter: (e) => e === picked,
        });
        const v = validate(wasm, out.result, out.mesh);
        const exp = mode === 'none'
          ? { removedVolume: 18.77, volume: 7981.2, tolerance: 2, note: 'analytic full-length 4-segment quarter-round' }
          : { removedVolume: 16.27, volume: 7983.7, tolerance: 2, note: 'same sweep, radius faded to 0 over 2 mm at each end' };
        const t = makeReport(
          mode === 'auto' ? 'A' : 'A-noTaper',
          mode === 'auto'
            ? 'cube 20 mm, ONE edge r=2 seg 4, radius tapered to 0 at both ends'
            : 'cube 20 mm, ONE edge r=2 seg 4, full radius to the vertex (no taper)',
          { triangles: 12, volume: round(signedVolume(cube), 3), bbox: { size: bboxOf(cube).size } },
          out, v, exp,
        );
        tests.push(t);
        if (mode === 'none') writeStl(join(OUT, 'cube-one-edge.stl'), out.mesh, 'cube 20mm one edge r=2 seg4');
      }
    }
  }

  // ---- reference hook -----------------------------------------------------
  let hookBest: { id: string; mesh: MeshData; volume: number; triangles: number; score: number } | null = null;
  let hookCuts: { cuts: CutSet; base: Manifold; table: EdgeTable; loaded: ReturnType<typeof loadStl> } | null = null;

  if (TESTS.has('C') || TESTS.has('D') || TESTS.has('E')) {
    const loaded = loadStl(HOOK);
    const flipped = ensureOutward(loaded.mesh);
    const table = buildEdgeTable(loaded.mesh);
    const hookStats = edgeStats(table);
    report.selfCheck = { baseHookSelfIntersections: countSelfIntersections(loaded.mesh) };
    console.log(
      JSON.stringify({
        hook: {
          ...hookStats,
          volume: round(loaded.stats.volume, 3),
          flipped,
          bbox: loaded.stats.bounds.size.map((x) => round(x, 3)),
          format: loaded.stats.format,
          weldedVerts: loaded.stats.vertices,
        },
      }),
    );

    const variants: { id: string; filter?: (e: number, t: EdgeTable) => boolean; label: string }[] = [
      { id: 'C', label: 'hook, ALL convex ≥ 20°, w=0.5 seg 4 p=0.5', filter: undefined },
      {
        id: 'D',
        label: 'hook, convex ≥ 20° excluding midpoint.x < −16.9 (under-table plate)',
        filter: (e, t) => (t.position[e * 6] + t.position[e * 6 + 3]) / 2 >= -16.9,
      },
    ];

    for (const variant of variants) {
      if (!TESTS.has(variant.id)) continue;
      const runs: { suffix: string; clamp: boolean; inflate: number; note: string }[] = ONLY
        ? [{ suffix: '', clamp: CLAMP, inflate: INFLATE, note: '' }]
        : [
            { suffix: '', clamp: CLAMP, inflate: INFLATE, note: '' },
            { suffix: '-noclamp', clamp: false, inflate: INFLATE, note: '' },
            { suffix: '+eps', clamp: CLAMP, inflate: 1e-4, note: ', arc inset 1e-4 mm' },
          ];
      for (const r of runs) {
        const out = bevel(wasm, loaded.mesh, table, {
          width: WIDTH, segments: SEGMENTS, profile: PROFILE, clamp: r.clamp, minAngle: ANGLE,
          inflate: r.inflate, taper: TAPER, cornerSegments: 8, corners: CORNERS, edgeFilter: variant.filter,
        });
        const v = validate(wasm, out.result, out.mesh);
        const exp = { removedVolume: 83.3, volume: 12788.5, tolerance: 127.9, note: 'reference Desk_Hook_Quatsch_improved.stl ±1 %' };
        const extra: Record<string, boolean | string | number> = {};
        if (variant.id === 'C') {
          extra.bboxWithin1pct = [47.88, 61.87, 35].every((s, i) => Math.abs(v.bbox.size[i] - s) / s < 0.01);
        }
        const id = `${variant.id}${r.suffix}`;
        const t = makeReport(id, `${variant.label}${r.note}${r.clamp ? '' : ', clamp off'}`, {
          triangles: loaded.stats.triangles,
          volume: round(loaded.stats.volume, 3),
          bbox: { size: loaded.stats.bounds.size.map((x) => round(x, 3)) },
        }, out, v, exp, extra);
        tests.push(t);

        // best match = volume, silhouette (bbox y) and material removed; the
        // triangle count is reported separately because no variant can hit 654.
        const score =
          Math.abs(v.volume - 12788.5) / 12788.5 +
          Math.abs(v.bbox.size[1] - 61.87) / 61.87 +
          Math.abs(loaded.stats.volume - v.volume - 83.3) / 83.3;
        if (v.status === 'NoError' && v.shells === 1 && (!hookBest || score < hookBest.score)) {
          hookBest = { id, mesh: out.mesh, volume: v.volume, triangles: v.triangles, score };
        }
        if (variant.id === 'C' && r.suffix !== '+eps') writeStl(join(OUT, 'hook-' + id + '.stl'), out.mesh, id);
        if (variant.id === 'C' && r.suffix === '') hookCuts = { cuts: out, base: toManifold(wasm, loaded.mesh), table, loaded };
      }
    }
  }

  // ---- E: timing and scaling ---------------------------------------------
  if (TESTS.has('E')) {
    const scale: unknown[] = [];
    if (hookCuts) {
      const { cuts, base } = hookCuts;
      const union = cuts.solids.length === 0 ? null : cuts.solids.length === 1 ? cuts.solids[0] : wasm.Manifold.union(cuts.solids);
      void union?.numTri();
      for (const level of [1, 8, 16, 32]) {
        const b = level === 1 ? base : base.refine(level);
        const tb = performance.now();
        const r = union ? b.subtract(union) : b;
        void r.numTri();
        const ms = performance.now() - tb;
        scale.push({
          refine: level,
          baseTriangles: level === 1 ? 140 : 140 * level * level,
          cuts: cuts.solids.length,
          cutTriangles: cuts.cutTriangles,
          resultTriangles: r.numTri(),
          volume: round(r.volume(), 3),
          status: r.status(),
          booleanMs: round(ms, 2),
        });
      }
    }
    report.scale = scale;
    if (scale.length >= 2) {
      const prev = scale[scale.length - 2] as { baseTriangles: number; booleanMs: number };
      const last = scale[scale.length - 1] as { baseTriangles: number; booleanMs: number };
      const slope = (last.booleanMs - prev.booleanMs) / (last.baseTriangles - prev.baseTriangles);
      const intercept = last.booleanMs - slope * last.baseTriangles;
      report.extrapolation = {
        model: 'booleanMs ≈ intercept + slope · baseTriangles (fixed 65 cut solids)',
        slopeMsPerTriangle: round(slope, 6),
        interceptMs: round(intercept, 2),
        at100k: round(intercept + slope * 100_000, 1),
        at1M: round(intercept + slope * 1_000_000, 1),
        note: 'measured up to 143 k base triangles; 1 M is extrapolated, not run',
      };
    }
  }

  // ---- write --------------------------------------------------------------
  if (hookBest) {
    writeStl(join(OUT, 'hook-beveled.stl'), hookBest.mesh, 'Desk hook beveled (best spike variant)');
    report.hookBest = { id: hookBest.id, volume: round(hookBest.volume, 3), triangles: hookBest.triangles };
  }

  writeFileSync(join(HERE, 'report.json'), JSON.stringify(report, null, 2));

  const rows = tests.map((t) => ({
    id: t.id,
    tri: t.result.triangles,
    vol: t.result.volume,
    removed: t.result.removedVolume,
    manifold: t.result.status,
    shells: t.result.shells,
    si: t.result.selfIntersections,
    bbox: t.result.bboxSize,
    ms: t.ms,
    pass: t.pass,
    failed: Object.entries(t.checks).filter(([, v]) => v === false).map(([k]) => k),
  }));
  console.log(JSON.stringify({ spike: 'bevel', rows }, null, 1));

  if (tests.some((t) => !t.pass)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
