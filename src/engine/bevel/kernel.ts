/**
 * Bevel kernel — the production cut-solid boolean bevel.
 *
 * The kernel is deliberately synchronous after `initKernel()`: the worker
 * owns scheduling, cancellation and caching of parameters. `bevelMesh` takes
 * the repaired base mesh, the selected canonical edge ids, the shared
 * parameters and an optional per-edge `maxWidth` from the analyzer.
 *
 * Pipeline (PLAN §4.4):
 *   1. rebuild the canonical edge table once per MeshData (cached by identity)
 *   2. clamp each selected edge independently (never a global minimum)
 *   3. build one closed cut solid per edge, with the radius tapered to zero at
 *      terminations, plus sphere cuts at fully-selected 3-face convex corners
 *   4. `Manifold.union(cuts)` once, then `base.subtract(union)` once
 *   5. drop zero-volume boolean fragments, weld at 1e-4 mm and rebuild the
 *      Manifold; on failure retry once with a 1e-4 mm arc inset
 *
 * Units are millimetres. Nothing is rescaled or recentred.
 *
 * Clamp/taper policy (what the inspector should surface):
 *   - clampOverlap: each edge uses min(width, 0.98 × maxWidth[e]); maxWidth is
 *     the caller's per-edge limit, or 0.45 × min(two adjacent altitudes,
 *     shortest incident edge) when the analyzer has not supplied one. There is
 *     deliberately no global minimum over the selection.
 *   - an edge clamped below 1 % of the requested width is skipped and reported,
 *     not silently beveled at a useless size; an edge shorter than 4× its
 *     applied width is skipped too.
 *   - at a termination the radius fades to zero over min(r, 0.25 × L). At a
 *     fully selected convex 3-face corner it stays full and a sphere cut
 *     finishes the corner; unsupported corners taper instead.
 */
import Module from 'manifold-3d';
import type { ErrorStatus, Manifold, ManifoldToplevel } from 'manifold-3d';
import { computeBasicMeta } from '../meta';
import type { BevelParams, BevelResult, MeshData, MeshWarning, Vec3 } from '../types';
import { buildCornerCut, buildEdgeCutSolid } from './cutSolid';
import { countSelfIntersections } from './selfIntersection';
import {
  buildTopology,
  FLAT_DEGREES,
  localMaxWidth,
  type MeshTopology,
} from './topology';

const KERNEL_NAME = 'manifold-3d 3.5.5';
const WELD_TOLERANCE = 1e-4;
const RETRY_INSET = 1e-4;
/**
 * faceID stamped on every base triangle. Manifold keeps faceIDs through
 * booleans, so a triangle that still carries this value after the subtract is
 * untouched base surface; everything else was created by a cut solid.
 */
const BASE_FACE_ID = 0x7fffffff;

let wasm: ManifoldToplevel | null = null;
let loading: Promise<void> | null = null;

/** Load manifold-3d once. Safe to call repeatedly and concurrently. */
export async function initKernel(): Promise<void> {
  if (wasm) return;
  if (!loading) {
    loading = Module()
      .then((instance) => {
        instance.setup();
        wasm = instance;
      })
      .catch((error: unknown) => {
        loading = null;
        throw error;
      });
  }
  await loading;
}

export function isKernelReady(): boolean {
  return wasm !== null;
}

function requireWasm(): ManifoldToplevel {
  if (!wasm) throw new Error('Bevel kernel is not initialised; await initKernel() first.');
  return wasm;
}

/** Diagnostic switches; production uses the defaults. */
export interface BevelKernelOptions {
  /**
   * 'auto' (default) fades the radius to zero where a neighbouring edge is not
   * beveled. 'none' keeps the full radius to the vertex; used by the kernel
   * tests to pin the analytic full-length volume.
   */
  taper?: 'auto' | 'none';
  /** Set false to disable corner spheres (diagnostics only). */
  corners?: boolean;
  /** Override the corner cut resolution (8..12; the sphere doubles it). */
  cornerSegments?: number;
}

/**
 * `BevelResult` plus the validation facts the worker and inspector need.
 * Structurally assignable to `BevelResult`, so existing consumers are safe.
 */
export interface BevelKernelResult extends BevelResult {
  status: ErrorStatus;
  shells: number;
  volumeBefore: number;
  volumeAfter: number;
  manifold: boolean;
}

// --- cached per-mesh topology and base solid --------------------------------

interface CachedMesh {
  topo: MeshTopology;
  base: Manifold;
  baseStatus: ErrorStatus;
  baseVolume: number;
  baseShells: number | null;
}

const cache = new WeakMap<MeshData, CachedMesh>();

function topologyFor(mesh: MeshData): CachedMesh {
  const hit = cache.get(mesh);
  if (hit) return hit;
  const instance = requireWasm();
  const topo = buildTopology(mesh);
  const base = meshToManifold(mesh, BASE_FACE_ID);
  const baseStatus = safeStatus(base);
  const baseVolume = safeVolume(base);
  const entry: CachedMesh = { topo, base, baseStatus, baseVolume, baseShells: null };
  cache.set(mesh, entry);
  return entry;
}

function baseShells(cached: CachedMesh): number {
  if (cached.baseShells === null) {
    try {
      cached.baseShells = cached.base.decompose().length;
    } catch {
      cached.baseShells = 1;
    }
  }
  return cached.baseShells;
}

// --- helpers ----------------------------------------------------------------

function now(): number {
  return performance.now();
}

function clampInt(value: number, lo: number, hi: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : lo;
  return Math.max(lo, Math.min(hi, n));
}

function formatMm(value: number): string {
  return value >= 0.1 ? value.toFixed(2) : value.toFixed(3);
}

function safeStatus(m: Manifold): ErrorStatus {
  try {
    return m.status();
  } catch {
    return 'NotManifold';
  }
}

function safeVolume(m: Manifold): number {
  try {
    return Math.abs(m.volume());
  } catch {
    return 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- mesh <-> Manifold ------------------------------------------------------

/** Build a Manifold from an indexed triangle mesh. Throws if it is not one. */
export function meshToManifold(mesh: MeshData, faceId?: number): Manifold {
  const instance = requireWasm();
  const gl = new instance.Mesh({
    numProp: 3,
    vertProperties: mesh.positions,
    triVerts: mesh.indices,
    ...(faceId === undefined
      ? {}
      : { faceID: new Uint32Array(mesh.indices.length / 3).fill(faceId) }),
  });
  try {
    return new instance.Manifold(gl);
  } catch {
    // The Mesh wrapper is only the input; Manifold owns its own copy.
    throw new Error('The mesh could not be converted to a solid.');
  }
}

/** Plain MeshData from a Manifold; drops any extra vertex properties. */
export function manifoldToMesh(manifold: Manifold): MeshData {
  return manifoldToMeshWithFaces(manifold).mesh;
}

/**
 * MeshData plus the per-triangle face IDs Manifold carried through the
 * boolean. `null` when the result has no attribution.
 */
function manifoldToMeshWithFaces(manifold: Manifold): {
  mesh: MeshData;
  faceIds: Uint32Array | null;
} {
  const out = manifold.getMesh();
  try {
    const np = out.numProp;
    const vertexCount = out.vertProperties.length / np;
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      positions[i * 3] = out.vertProperties[i * np];
      positions[i * 3 + 1] = out.vertProperties[i * np + 1];
      positions[i * 3 + 2] = out.vertProperties[i * np + 2];
    }
    const indices = new Uint32Array(out.triVerts);
    const triangles = indices.length / 3;
    const faceIds =
      out.faceID && out.faceID.length === triangles ? new Uint32Array(out.faceID) : null;
    return { mesh: { positions, indices }, faceIds };
  } finally {
    // getMesh() returns a WASM-backed Mesh that is never garbage collected.
    (out as unknown as { delete?: () => void }).delete?.();
  }
}

/** 1 for cut-solid triangles, 0 for untouched base surface. */
function bevelMask(faceIds: Uint32Array | null, triangles: number): Uint8Array | undefined {
  if (!faceIds || faceIds.length !== triangles) return undefined;
  const mask = new Uint8Array(triangles);
  for (let i = 0; i < triangles; i++) mask[i] = faceIds[i] === BASE_FACE_ID ? 0 : 1;
  return mask;
}

/**
 * Binary STL, millimetres, in the mesh's own coordinate frame. No recentring,
 * no unit conversion. Normals are recomputed from the winding.
 */
export function meshToStl(mesh: MeshData): ArrayBuffer {
  const { positions: p, indices } = mesh;
  const triangles = indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const header = 'Bevel Studio binary STL (mm)';
  for (let i = 0; i < header.length && i < 80; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, triangles, true);

  let o = 84;
  for (let t = 0; t < triangles; t++) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const ax = p[ia];
    const ay = p[ia + 1];
    const az = p[ia + 2];
    const bx = p[ib];
    const by = p[ib + 1];
    const bz = p[ib + 2];
    const cx = p[ic];
    const cy = p[ic + 1];
    const cz = p[ic + 2];

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const wx = cx - ax;
    const wy = cy - ay;
    const wz = cz - az;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) {
      nx /= l;
      ny /= l;
      nz /= l;
    } else {
      nx = ny = nz = 0;
    }

    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3;
      view.setFloat32(o, p[v], true);
      view.setFloat32(o + 4, p[v + 1], true);
      view.setFloat32(o + 8, p[v + 2], true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return buffer;
}

/**
 * Merge vertices within `tolerance` mm. The 27-neighbour cell check means two
 * points that straddle a grid boundary still merge; the naive one-cell version
 * does not.
 */
function weldMesh(positions: Float32Array, indices: Uint32Array, tolerance: number): MeshData {
  const inv = 1 / tolerance;
  const tol2 = tolerance * tolerance;
  const cells = new Map<string, number[]>();
  const outPos: number[] = [];
  const remap = new Uint32Array(positions.length / 3);

  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const cx = Math.round(x * inv);
    const cy = Math.round(y * inv);
    const cz = Math.round(z * inv);
    let id = -1;
    for (let dx = -1; dx <= 1 && id < 0; dx++) {
      for (let dy = -1; dy <= 1 && id < 0; dy++) {
        for (let dz = -1; dz <= 1 && id < 0; dz++) {
          const bucket = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const cand of bucket) {
            const ex = outPos[cand * 3] - x;
            const ey = outPos[cand * 3 + 1] - y;
            const ez = outPos[cand * 3 + 2] - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) {
              id = cand;
              break;
            }
          }
        }
      }
    }
    if (id < 0) {
      id = outPos.length / 3;
      outPos.push(x, y, z);
      const key = `${cx},${cy},${cz}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(id);
      else cells.set(key, [id]);
    }
    remap[i] = id;
  }

  const outIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) outIdx[i] = remap[indices[i]];
  return { positions: new Float32Array(outPos), indices: outIdx };
}

// --- cut selection ----------------------------------------------------------

interface EdgeJob {
  edge: number;
  aVertex: number;
  bVertex: number;
  a: Vec3;
  b: Vec3;
  n1: Vec3;
  n2: Vec3;
  length: number;
  radius: number;
  taperA: number;
  taperB: number;
}

interface CornerCandidate {
  vertex: number;
  position: Vec3;
  normals: Vec3[];
  radius: number;
}

interface CleanupResult {
  manifold: Manifold;
  mesh: MeshData;
  /** per-triangle face IDs parallel to `mesh`, when attribution survived */
  faceIds: Uint32Array | null;
  status: ErrorStatus;
  shells: number;
  volume: number;
  droppedComponents: number;
  weldedVerts: number;
  ok: boolean;
}

interface Attempt extends CleanupResult {
  buildMs: number;
  booleanMs: number;
  failedSolids: number;
  failedCorners: number;
  error?: string;
}

/** Drop zero-volume fragments, weld at 1e-4 and rebuild the Manifold. */
function cleanup(raw: Manifold, baseVolume: number, instance: ManifoldToplevel): CleanupResult {
  const parts = raw.decompose();
  const eps = Math.max(1e-9, Math.abs(baseVolume) * 1e-9);
  const keep: Manifold[] = [];
  for (const part of parts) {
    if (Math.abs(safeVolume(part)) > eps) keep.push(part);
  }

  let out: Manifold;
  if (keep.length === 0) out = raw;
  else if (keep.length === 1) out = keep[0];
  else out = instance.Manifold.union(keep);

  // CSG leaves the exact input surface untouched; the weld below merges the
  // 1e-4 slivers. A global `simplify()` was tried and removed: it decimates
  // flat regions (1.08 M → 4 200 triangles) and is unit-dependent.
  const source = manifoldToMeshWithFaces(out);
  const welded = weldMesh(source.mesh.positions, source.mesh.indices, WELD_TOLERANCE);
  const weldedVerts = source.mesh.positions.length / 3 - welded.positions.length / 3;
  const shells = Math.max(1, keep.length || parts.length);
  // weldMesh only remaps vertex ids, so triangle order (and the parallel face
  // IDs) survive the weld and can be handed to the rebuilt Manifold.
  const weldedFaceIds =
    source.faceIds && source.faceIds.length === welded.indices.length / 3
      ? source.faceIds
      : null;

  let rebuilt: Manifold | null = null;
  try {
    const gl = new instance.Mesh({
      numProp: 3,
      vertProperties: welded.positions,
      triVerts: welded.indices,
      ...(weldedFaceIds ? { faceID: weldedFaceIds } : {}),
    });
    rebuilt = new instance.Manifold(gl);
  } catch {
    rebuilt = null;
  }

  if (rebuilt && safeStatus(rebuilt) === 'NoError') {
    const final = manifoldToMeshWithFaces(rebuilt);
    return {
      manifold: rebuilt,
      mesh: final.mesh,
      faceIds: final.faceIds,
      status: 'NoError',
      shells,
      volume: safeVolume(rebuilt),
      droppedComponents: parts.length - keep.length,
      weldedVerts,
      ok: true,
    };
  }

  return {
    manifold: out,
    mesh: source.mesh,
    faceIds: source.faceIds,
    status: rebuilt ? safeStatus(rebuilt) : 'NotManifold',
    shells,
    volume: safeVolume(out),
    droppedComponents: parts.length - keep.length,
    weldedVerts,
    ok: false,
  };
}

// --- public kernel ----------------------------------------------------------

/**
 * Bevel the selected convex edges.
 *
 * @param mesh      repaired, outward-wound, immutable indexed mesh (mm)
 * @param edgeIds   canonical edge ids from `edgeOrder.ts`
 * @param params    shared bevel parameters; `clampOverlap` enables per-edge clamp
 * @param maxWidth  optional per-edge safe width from the analyzer, indexed by id
 * @param options   diagnostics only; production uses the defaults
 *
 * The mesh must be treated as immutable: the kernel caches its edge table and
 * base Manifold by object identity so a slider drag does not rebuild them.
 */
export function bevelMesh(
  mesh: MeshData,
  edgeIds: Uint32Array,
  params: BevelParams,
  maxWidth?: Float32Array,
  options: BevelKernelOptions = {},
): BevelKernelResult {
  const started = now();
  const instance = requireWasm();
  const cached = topologyFor(mesh);
  const topo = cached.topo;
  const base = cached.base;
  const volumeBefore = cached.baseVolume;

  const warnings: MeshWarning[] = [];
  const requested = Number.isFinite(params.width) ? Math.max(0, params.width) : 0;
  const segments = clampInt(params.segments, 1, 12);
  const profile = Number.isFinite(params.profile) ? Math.max(0, Math.min(1, params.profile)) : 0.5;
  const taperMode = options.taper ?? 'auto';
  const wantCorners = options.corners !== false;

  const selectionCount = edgeIds.length;
  const appliedWidth = new Float32Array(selectionCount);

  if (!(requested > 1e-9)) {
    warnings.push({
      code: 'bevel.width',
      severity: 'warning',
      message: 'Width is zero; nothing was beveled.',
    });
    return emptyResult(mesh, cached, appliedWidth, warnings, started);
  }

  // --- selection, per-edge clamp -------------------------------------------
  const jobs: EdgeJob[] = [];
  let concave = 0;
  let unusable = 0;
  let narrow = 0;
  let short = 0;

  for (let i = 0; i < selectionCount; i++) {
    const e = edgeIds[i];
    if (!Number.isInteger(e) || e < 0 || e >= topo.edgeCount) {
      unusable++;
      continue;
    }
    const kind = topo.convex[e];
    if (kind === 0) {
      concave++;
      continue;
    }
    if (kind !== 1) {
      unusable++;
      continue;
    }

    const length = topo.length[e];
    if (!(length > 1e-9)) {
      short++;
      continue;
    }

    let radius = requested;
    if (params.clampOverlap) {
      const limit =
        maxWidth && e < maxWidth.length ? maxWidth[e] : localMaxWidth(topo, mesh, e);
      if (Number.isFinite(limit) && limit >= 0) radius = Math.min(radius, 0.98 * limit);
    }

    // A bevel narrower than 1 % of the request is visually nothing and makes
    // fragile slivers; skip it and tell the UI instead of silently shrinking.
    if (!(radius > 0) || radius < requested * 0.01) {
      narrow++;
      continue;
    }
    if (length < 4 * radius) {
      short++;
      continue;
    }

    appliedWidth[i] = radius;
    jobs.push({
      edge: e,
      aVertex: topo.v[e * 2],
      bVertex: topo.v[e * 2 + 1],
      a: [mesh.positions[topo.v[e * 2] * 3], mesh.positions[topo.v[e * 2] * 3 + 1], mesh.positions[topo.v[e * 2] * 3 + 2]],
      b: [mesh.positions[topo.v[e * 2 + 1] * 3], mesh.positions[topo.v[e * 2 + 1] * 3 + 1], mesh.positions[topo.v[e * 2 + 1] * 3 + 2]],
      n1: [topo.normals[e * 6], topo.normals[e * 6 + 1], topo.normals[e * 6 + 2]],
      n2: [topo.normals[e * 6 + 3], topo.normals[e * 6 + 4], topo.normals[e * 6 + 5]],
      length,
      radius,
      taperA: 0,
      taperB: 0,
    });
  }

  if (concave > 0) {
    warnings.push({
      code: 'bevel.concave',
      severity: 'warning',
      message: `Skipped ${concave} concave edge${concave === 1 ? '' : 's'}; this version bevels outside edges only.`,
    });
  }
  if (unusable > 0) {
    warnings.push({
      code: 'bevel.unusable',
      severity: 'warning',
      message: `Skipped ${unusable} edge${unusable === 1 ? '' : 's'} that ${unusable === 1 ? 'is' : 'are'} not two-sided.`,
    });
  }
  if (narrow > 0) {
    warnings.push({
      code: 'bevel.narrow',
      severity: 'warning',
      message: `Skipped ${narrow} edge${narrow === 1 ? '' : 's'} with no room at the requested width.`,
    });
  }
  if (short > 0) {
    warnings.push({
      code: 'bevel.short',
      severity: 'info',
      message: `Skipped ${short} edge${short === 1 ? '' : 's'} shorter than 4× the bevel width.`,
    });
  }

  let clampedEdges = 0;
  let narrowestClamp = Infinity;
  for (let i = 0; i < selectionCount; i++) {
    const w = appliedWidth[i];
    if (w > 0 && w < requested - 1e-9) {
      clampedEdges++;
      if (w < narrowestClamp) narrowestClamp = w;
    }
  }
  if (clampedEdges > 0) {
    warnings.push({
      code: 'bevel.clamped',
      severity: 'info',
      message: `Width limited on ${clampedEdges} edge${clampedEdges === 1 ? '' : 's'}; the narrowest is ${formatMm(narrowestClamp)} mm.`,
    });
  }

  if (jobs.length === 0) {
    return emptyResult(mesh, cached, appliedWidth, warnings, started);
  }

  // --- corners and terminations -------------------------------------------
  const widthByEdge = new Float32Array(topo.edgeCount);
  for (const job of jobs) widthByEdge[job.edge] = job.radius;

  // Selected edges incident to a vertex, so a bevel can tell a real termination
  // from a chain that merely bends (a rim split into many short edges).
  const incident = new Map<number, { edge: number; other: number }[]>();
  for (const job of jobs) {
    const a = incident.get(job.aVertex);
    if (a) a.push({ edge: job.edge, other: job.bVertex });
    else incident.set(job.aVertex, [{ edge: job.edge, other: job.bVertex }]);
    const b = incident.get(job.bVertex);
    if (b) b.push({ edge: job.edge, other: job.aVertex });
    else incident.set(job.bVertex, [{ edge: job.edge, other: job.aVertex }]);
  }

  const position = mesh.positions;
  const continues = (vertex: number, other: number, edge: number): boolean => {
    const list = incident.get(vertex);
    if (!list || list.length < 2) return false;
    const vx = position[other * 3] - position[vertex * 3];
    const vy = position[other * 3 + 1] - position[vertex * 3 + 1];
    const vz = position[other * 3 + 2] - position[vertex * 3 + 2];
    const vLength = Math.hypot(vx, vy, vz);
    if (vLength < 1e-9) return false;

    for (const item of list) {
      if (item.edge === edge) continue;
      const wx = position[item.other * 3] - position[vertex * 3];
      const wy = position[item.other * 3 + 1] - position[vertex * 3 + 1];
      const wz = position[item.other * 3 + 2] - position[vertex * 3 + 2];
      const wLength = Math.hypot(wx, wy, wz);
      if (wLength < 1e-9) continue;
      const dot = (vx * wx + vy * wy + vz * wz) / (vLength * wLength);
      // Outgoing directions at a straight chain point opposite ways, so a
      // nearly collinear continuation has a dot close to -1.
      if (dot < -0.5) return true;
    }
    return false;
  };

  const vertexCount = mesh.positions.length / 3;
  const cornerOk = new Uint8Array(vertexCount);
  const cornerCandidates: CornerCandidate[] = [];
  const probeSolids: (Manifold | null)[] = [];
  let unsupportedCorners = 0;

  if (wantCorners) {
    const cornerSegments = clampInt(options.cornerSegments ?? segments * 2, 8, 12);
    for (let v = 0; v < vertexCount; v++) {
      const start = topo.vertexOffset[v];
      const end = topo.vertexOffset[v + 1];
      let sharp = 0;
      let allBeveled = true;
      let allConvex = true;
      let minRadius = Infinity;
      const normals: Vec3[] = [];

      for (let i = start; i < end; i++) {
        const e = topo.vertexEdges[i];
        if (topo.dihedral[e] < FLAT_DEGREES) continue;
        sharp++;
        if (!(widthByEdge[e] > 0)) allBeveled = false;
        if (topo.convex[e] !== 1) allConvex = false;
        if (widthByEdge[e] > 0 && widthByEdge[e] < minRadius) minRadius = widthByEdge[e];
        addUniqueNormal(normals, topo.normals, e * 6);
        addUniqueNormal(normals, topo.normals, e * 6 + 3);
      }

      if (sharp !== 3 || !allBeveled || !allConvex) continue;
      if (normals.length !== 3 || !Number.isFinite(minRadius)) {
        unsupportedCorners++;
        continue;
      }

      const candidate: CornerCandidate = {
        vertex: v,
        position: [
          mesh.positions[v * 3],
          mesh.positions[v * 3 + 1],
          mesh.positions[v * 3 + 2],
        ],
        normals,
        radius: minRadius,
      };

      let solid: Manifold | null = null;
      try {
        solid = buildCornerCut(instance, candidate.position, normals, minRadius, cornerSegments, 0);
      } catch {
        solid = null;
      }
      if (!solid) {
        unsupportedCorners++;
        continue;
      }
      cornerOk[v] = 1;
      cornerCandidates.push(candidate);
      probeSolids.push(solid);
    }
  }

  for (const job of jobs) {
    const continuesA = continues(job.aVertex, job.bVertex, job.edge);
    const continuesB = continues(job.bVertex, job.aVertex, job.edge);

    job.taperA = taperMode === 'none' || cornerOk[job.aVertex] || continuesA
      ? 0
      : Math.min(job.radius, 0.25 * job.length);
    job.taperB = taperMode === 'none' || cornerOk[job.bVertex] || continuesB
      ? 0
      : Math.min(job.radius, 0.25 * job.length);

    // At a bend, two cut solids that stop exactly on the vertex plane leave a
    // thin V of original wall between them. Extend each one past the joint so
    // the union covers it; a real termination keeps its flat cap.
    if (continuesA || continuesB) {
      const dx = job.b[0] - job.a[0];
      const dy = job.b[1] - job.a[1];
      const dz = job.b[2] - job.a[2];
      const length = Math.hypot(dx, dy, dz);
      if (length > 1e-9) {
        const extension = Math.min(job.radius * 0.75, length * 0.4) / length;
        if (continuesA) {
          job.a[0] -= dx * extension;
          job.a[1] -= dy * extension;
          job.a[2] -= dz * extension;
        }
        if (continuesB) {
          job.b[0] += dx * extension;
          job.b[1] += dy * extension;
          job.b[2] += dz * extension;
        }
      }
    }
  }

  if (unsupportedCorners > 0) {
    warnings.push({
      code: 'bevel.corner',
      severity: 'info',
      message: `${unsupportedCorners} corner${unsupportedCorners === 1 ? '' : 's'} left sharp: the faces do not meet as a simple 3-face corner.`,
    });
  }

  // --- one boolean attempt -------------------------------------------------
  const attempt = (inset: number): Attempt => {
    const buildStart = now();
    const solids: Manifold[] = [];
    let failedSolids = 0;
    let failedCorners = 0;

    for (const job of jobs) {
      const raw = buildEdgeCutSolid(job.a, job.b, job.n1, job.n2, {
        radius: job.radius,
        segments,
        profile,
        inset,
        taperA: job.taperA,
        taperB: job.taperB,
        taperStations: 1,
        extend: 0,
      });
      if (!raw) {
        failedSolids++;
        continue;
      }
      try {
        solids.push(meshToManifold(raw));
      } catch {
        failedSolids++;
      }
    }

    for (let i = 0; i < cornerCandidates.length; i++) {
      const candidate = cornerCandidates[i];
      let solid: Manifold | null;
      if (inset === 0) {
        solid = probeSolids[i];
      } else {
        try {
          solid = buildCornerCut(
            instance,
            candidate.position,
            candidate.normals,
            candidate.radius,
            clampInt(options.cornerSegments ?? segments * 2, 8, 12),
            inset,
          );
        } catch {
          solid = null;
        }
      }
      if (solid) solids.push(solid);
      else failedCorners++;
    }

    const buildMs = now() - buildStart;
    const booleanStart = now();

    let raw: Manifold;
    try {
      if (solids.length === 0) {
        raw = base;
      } else {
        const union = solids.length === 1 ? solids[0] : instance.Manifold.union(solids);
        raw = base.subtract(union);
      }
      void raw.numTri(); // force the deferred CSG tree inside the timed region
    } catch (error) {
      return {
        manifold: base,
        mesh,
        faceIds: null,
        status: cached.baseStatus,
        shells: baseShells(cached),
        volume: volumeBefore,
        droppedComponents: 0,
        weldedVerts: 0,
        buildMs,
        booleanMs: now() - booleanStart,
        failedSolids,
        failedCorners,
        ok: false,
        error: `boolean failed: ${errorMessage(error)}`,
      };
    }

    const rawStatus = safeStatus(raw);
    if (rawStatus !== 'NoError') {
      let rawMesh: MeshData;
      try {
        rawMesh = manifoldToMesh(raw);
      } catch {
        rawMesh = mesh;
      }
      return {
        manifold: raw,
        mesh: rawMesh,
        faceIds: null,
        status: rawStatus,
        shells: 1,
        volume: safeVolume(raw),
        droppedComponents: 0,
        weldedVerts: 0,
        buildMs,
        booleanMs: now() - booleanStart,
        failedSolids,
        failedCorners,
        ok: false,
        error: `boolean status ${rawStatus}`,
      };
    }

    let cleaned: CleanupResult;
    try {
      cleaned = cleanup(raw, volumeBefore, instance);
    } catch (error) {
      let rawMesh: MeshData;
      try {
        rawMesh = manifoldToMesh(raw);
      } catch {
        rawMesh = mesh;
      }
      return {
        manifold: raw,
        mesh: rawMesh,
        faceIds: null,
        status: 'NoError',
        shells: 1,
        volume: safeVolume(raw),
        droppedComponents: 0,
        weldedVerts: 0,
        buildMs,
        booleanMs: now() - booleanStart,
        failedSolids,
        failedCorners,
        ok: false,
        error: `cleanup failed: ${errorMessage(error)}`,
      };
    }

    return {
      ...cleaned,
      buildMs,
      booleanMs: now() - booleanStart,
      failedSolids,
      failedCorners,
    };
  };

  let buildMs = 0;
  let booleanMs = 0;
  const first = attempt(0);
  buildMs += first.buildMs;
  booleanMs += first.booleanMs;
  let chosen = first;

  if (!first.ok) {
    const second = attempt(RETRY_INSET);
    buildMs += second.buildMs;
    booleanMs += second.booleanMs;
    const score = (a: Attempt) => (a.ok ? 2 : a.status === 'NoError' ? 1 : 0);
    chosen = score(second) >= score(first) ? second : first;
    warnings.push({
      code: 'bevel.retry',
      severity: 'info',
      message: 'The first result was not watertight; retried once with a 1e-4 mm arc inset.',
    });
  }

  if (chosen.failedSolids > 0) {
    warnings.push({
      code: 'bevel.cutSolid',
      severity: 'warning',
      message: `${chosen.failedSolids} cut solid${chosen.failedSolids === 1 ? '' : 's'} could not be built and ${chosen.failedSolids === 1 ? 'was' : 'were'} skipped.`,
    });
  }
  if (chosen.failedCorners > 0) {
    warnings.push({
      code: 'bevel.cornerSolid',
      severity: 'info',
      message: `${chosen.failedCorners} corner sphere${chosen.failedCorners === 1 ? '' : 's'} could not be built and ${chosen.failedCorners === 1 ? 'was' : 'were'} skipped.`,
    });
  }
  if (chosen.droppedComponents > 0) {
    warnings.push({
      code: 'bevel.fragments',
      severity: 'info',
      message: `Removed ${chosen.droppedComponents} zero-volume fragment${chosen.droppedComponents === 1 ? '' : 's'} left by the boolean.`,
    });
  }
  if (chosen.error) {
    warnings.push({
      code: 'bevel.boolean',
      severity: 'error',
      message: `The bevel could not be completed: ${chosen.error}.`,
    });
  }
  if (!chosen.ok) {
    warnings.push({
      code: 'bevel.nonManifold',
      severity: 'error',
      message: `The beveled mesh did not pass the watertight check (${chosen.status}); returning the closest result.`,
    });
  } else if (chosen.shells > 1) {
    warnings.push({
      code: 'bevel.shells',
      severity: 'warning',
      message: `The result has ${chosen.shells} separate shells.`,
    });
  }

  const removed = volumeBefore - chosen.volume;
  if (removed < -1e-6) {
    warnings.push({
      code: 'bevel.volumeGain',
      severity: 'error',
      message: 'The bevel added material instead of removing it; check the mesh orientation.',
    });
  } else if (removed <= 1e-6) {
    warnings.push({
      code: 'bevel.volumeUnchanged',
      severity: 'warning',
      message: 'The bevel removed no material.',
    });
  }

  const meta = computeBasicMeta(chosen.mesh, 'beveled');
  meta.volume = chosen.volume;
  meta.triangles = chosen.mesh.indices.length / 3;
  meta.vertices = chosen.mesh.positions.length / 3;
  meta.shells = chosen.shells;
  meta.watertight = chosen.ok;

  // Manifold status proves topology, not geometry: a mesh can be closed and
  // still have triangles passing through each other. Only check small results
  // (the O(n²) SAT pass would dominate a million-triangle export).
  const triangleCount = chosen.mesh.indices.length / 3;
  let selfIntersections = 0;
  if (chosen.ok && triangleCount <= 20_000) {
    selfIntersections = countSelfIntersections(chosen.mesh);
    if (selfIntersections > 0) {
      warnings.push({
        code: 'bevel.selfIntersection',
        severity: 'error',
        message: `The bevel produced ${selfIntersections} self-intersecting triangle pairs. Reduce the width or deselect the tight corners before exporting.`,
      });
    }
  }

  // The Manifold status is the topological guarantee; edge-use counts are the
  // analyzer's job and stay at the MeshMeta default here.
  meta.boundaryEdges = 0;
  meta.nonManifoldEdges = 0;
  meta.genus = genusOf(chosen);

  return {
    mesh: chosen.mesh,
    meta,
    appliedWidth,
    clampedEdges,
    warnings,
    timings: { buildMs, booleanMs, totalMs: now() - started },
    status: chosen.status,
    shells: chosen.shells,
    volumeBefore,
    volumeAfter: chosen.volume,
    manifold: chosen.ok,
    selfIntersections,
    bevelFaces: bevelMask(chosen.faceIds, triangleCount),
  };
}

function emptyResult(
  mesh: MeshData,
  cached: CachedMesh,
  appliedWidth: Float32Array,
  warnings: MeshWarning[],
  started: number,
): BevelKernelResult {
  const meta = computeBasicMeta(mesh, 'beveled');
  const shells = baseShells(cached);
  meta.volume = cached.baseVolume;
  meta.shells = shells;
  meta.watertight = cached.baseStatus === 'NoError';
  meta.genus = meta.watertight && shells === 1 ? genusOfCached(cached) : -1;
  return {
    mesh,
    meta,
    appliedWidth,
    clampedEdges: 0,
    warnings,
    timings: { buildMs: 0, booleanMs: 0, totalMs: now() - started },
    status: cached.baseStatus,
    shells,
    volumeBefore: cached.baseVolume,
    volumeAfter: cached.baseVolume,
    manifold: cached.baseStatus === 'NoError',
  };
}

function genusOf(attempt: Attempt): number {
  if (!attempt.ok || attempt.shells !== 1) return -1;
  try {
    return attempt.manifold.genus();
  } catch {
    return -1;
  }
}

function genusOfCached(cached: CachedMesh): number {
  try {
    return cached.base.genus();
  } catch {
    return -1;
  }
}

function addUniqueNormal(out: Vec3[], normals: Float32Array, offset: number): void {
  const x = normals[offset];
  const y = normals[offset + 1];
  const z = normals[offset + 2];
  if (x === 0 && y === 0 && z === 0) return;
  for (const n of out) {
    if (n[0] * x + n[1] * y + n[2] * z > 1 - 1e-7) return;
  }
  out.push([x, y, z]);
}

export { KERNEL_NAME };
