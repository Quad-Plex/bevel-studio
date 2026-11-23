/**
 * Bevel kernel — rolling-ball bevels as sweep solids and a Manifold boolean.
 *
 * The kernel is synchronous after `initKernel()`; the worker owns scheduling.
 * `bevelMesh` takes the repaired base mesh, the selected canonical edge ids
 * and the shared parameters.
 *
 * Pipeline:
 *   1. topology, base Manifold and (when clamping) a triangle BVH are built
 *      once per MeshData and cached by identity
 *   2. `planBevel` (plan.ts) turns the selection into sweeps with trim planes
 *      and vertex blends: irregularities below the micro length are bridged,
 *      widths are limited by real geometry (wall thickness, gaps), chain
 *      joints are mitred, fully selected corners get a rolling-ball blend
 *   3. concave sweeps/blends (inside fillets) are unioned with the base, then
 *      the convex ones are unioned and subtracted
 *   4. zero-volume fragments are dropped, the result is welded at 1e-3 mm and
 *      validated; on failure it is retried once with a 1e-4 mm arc inset
 *
 * Units are millimetres. Nothing is rescaled or recentred.
 */
import Module from 'manifold-3d';
import type { ErrorStatus, Manifold, ManifoldToplevel } from 'manifold-3d';
import { computeBasicMeta } from '../meta';
import type { BevelParams, BevelResult, MeshData, MeshWarning } from '../types';
import { buildBvh, type TriangleBvh } from './bvh';
import { BAND, linkChains, planBevel, type PlannedSweep } from './plan';
import { countSelfIntersections } from './selfIntersection';
import { buildChainSweep, buildVertexBlend, keepBelow } from './sweep';
import { buildTopology, type MeshTopology } from './topology';

const KERNEL_NAME = 'manifold-3d 3.5.5';
const WELD_TOLERANCE = 1e-3;
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
   * 'auto' (default) fades the radius to zero at a genuine termination, where
   * no other selected sharp edge meets the vertex. 'none' keeps the full
   * radius to every endpoint; used by the kernel tests to pin the analytic
   * full-length volume.
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
  /** Effective sweep radius at each selected edge's A/B endpoint. */
  endWidths?: Float32Array;
  /** 1 when that endpoint fades to zero (a termination, not a chain joint). */
  endTapers?: Uint8Array;
  /** vertex blends (rounded corners) in the result */
  corners?: number;
}

// --- cached per-mesh topology and base solid --------------------------------

interface CachedMesh {
  topo: MeshTopology;
  bvh: TriangleBvh | null;
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
  const entry: CachedMesh = { topo, bvh: null, base, baseStatus, baseVolume, baseShells: null };
  cache.set(mesh, entry);
  return entry;
}

function bvhFor(cached: CachedMesh, mesh: MeshData): TriangleBvh {
  if (!cached.bvh) cached.bvh = buildBvh(mesh);
  return cached.bvh;
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

/** 1 for bevel-solid triangles, 0 for untouched base surface. */
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


// --- boolean attempt bookkeeping -------------------------------------------

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
  /** self-intersecting triangle pairs, computed on demand */
  crossings?: number;
  buildMs: number;
  booleanMs: number;
  failedSolids: number;
  failedCorners: number;
  error?: string;
}

/** Drop zero-volume fragments, weld at 1e-3 and rebuild the Manifold. */
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
  // sub-micron T-junction vertices. A global `simplify()` was tried and
  // removed: it decimates
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
 * Bevel the selected edges: convex edges are rounded off, concave edges get
 * an inside fillet.
 *
 * @param mesh      repaired, outward-wound, immutable indexed mesh (mm)
 * @param edgeIds   canonical edge ids from `edgeOrder.ts`
 * @param params    shared bevel parameters; `clampOverlap` enables the
 *                  geometric width limit
 * @param maxWidth  optional explicit per-edge cap, indexed by edge id; applied
 *                  only with `clampOverlap`
 * @param options   diagnostics only; production uses the defaults
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
  const wantCorners = options.corners !== false;
  const sphereSegments = clampInt(options.cornerSegments ?? segments * 4, 12, 32);

  if (!(requested > 1e-9)) {
    warnings.push({
      code: 'bevel.width',
      severity: 'warning',
      message: 'Width is zero; nothing was beveled.',
    });
    return emptyResult(mesh, cached, new Float32Array(edgeIds.length), warnings, started);
  }

  const bvh = params.clampOverlap ? bvhFor(cached, mesh) : null;
  const plan = planBevel(
    mesh,
    topo,
    edgeIds,
    params,
    requested,
    bvh,
    options.taper ?? 'auto',
    params.clampOverlap ? maxWidth : undefined,
  );
  if (!wantCorners) plan.blends.length = 0;
  const { appliedWidth } = plan;
  const chains = linkChains(plan.sweeps);

  const concaveCount = plan.sweeps.filter((s) => s.concave).length;
  if (concaveCount > 0) {
    warnings.push({
      code: 'bevel.fillet',
      severity: 'info',
      message: `Added inside fillets on ${concaveCount} concave edge${concaveCount === 1 ? '' : 's'}.`,
    });
  }
  if (plan.unusable > 0) {
    warnings.push({
      code: 'bevel.unusable',
      severity: 'warning',
      message: `Skipped ${plan.unusable} edge${plan.unusable === 1 ? '' : 's'} that ${plan.unusable === 1 ? 'is' : 'are'} flat or not two-sided.`,
    });
  }
  if (plan.narrow > 0) {
    warnings.push({
      code: 'bevel.narrow',
      severity: 'warning',
      message: `Skipped ${plan.narrow} edge${plan.narrow === 1 ? '' : 's'} with no room at the requested width.`,
    });
  }
  if (plan.micro > 0) {
    warnings.push({
      code: 'bevel.short',
      severity: 'info',
      message: `Bridged ${plan.micro} edge${plan.micro === 1 ? '' : 's'} shorter than ${formatMm(plan.microLength)} mm; the bevel runs across ${plan.micro === 1 ? 'it' : 'them'}.`,
    });
  }

  let clampedEdges = 0;
  let narrowestClamp = Infinity;
  for (let i = 0; i < appliedWidth.length; i++) {
    const w = appliedWidth[i];
    if (w > 0 && w < requested - 1e-6) {
      clampedEdges++;
      if (w < narrowestClamp) narrowestClamp = w;
    }
  }
  if (clampedEdges > 0) {
    warnings.push({
      code: 'bevel.clamped',
      severity: 'info',
      message: `Width limited by the surrounding geometry on ${clampedEdges} edge${clampedEdges === 1 ? '' : 's'}; the narrowest is ${formatMm(narrowestClamp)} mm.`,
    });
  }
  if (plan.mixedNodes > 0) {
    warnings.push({
      code: 'bevel.mixedCorner',
      severity: 'info',
      message: `${plan.mixedNodes} corner${plan.mixedNodes === 1 ? '' : 's'} mix outside and inside bevels; they are mitred, not blended.`,
    });
  }

  if (plan.sweeps.length === 0) {
    return emptyResult(mesh, cached, appliedWidth, warnings, started);
  }

  // --- one boolean attempt -------------------------------------------------
  const attempt = (inset: number): Attempt => {
    const buildStart = now();
    const cutSolids: Manifold[] = [];
    const fillSolids: Manifold[] = [];
    let failedSolids = 0;
    let failedCorners = 0;

    for (const chain of chains) {
      const solid = buildPlannedChain(chain, segments, profile, inset);
      if (!solid) {
        failedSolids += chain.length;
        continue;
      }
      (chain[0].concave ? fillSolids : cutSolids).push(solid);
    }

    for (const blend of plan.blends) {
      let solid: Manifold | null = null;
      try {
        solid =
          buildVertexBlend(
            instance,
            blend.planes,
            blend.point,
            blend.radius,
            blend.concave,
            sphereSegments,
            inset,
          )?.solid ?? null;
      } catch {
        solid = null;
      }
      if (solid) (blend.concave ? fillSolids : cutSolids).push(solid);
      else failedCorners++;
    }

    const buildMs = now() - buildStart;
    const booleanStart = now();

    let raw: Manifold;
    try {
      // Inside fillets first, then the outside cuts.
      let working = base;
      if (fillSolids.length > 0) {
        const fill = fillSolids.length === 1 ? fillSolids[0] : instance.Manifold.union(fillSolids);
        working = working.add(fill);
      }
      if (cutSolids.length > 0) {
        const cut = cutSolids.length === 1 ? cutSolids[0] : instance.Manifold.union(cutSolids);
        working = working.subtract(cut);
      }
      raw = working;
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
  // Manifold status proves topology, not geometry: a mesh can be closed and
  // still have triangles passing through each other. Only check small results
  // (the O(n²) SAT pass would dominate a million-triangle export).
  const crossings = (a: Attempt): number => {
    if (!a.ok || a.mesh.indices.length / 3 > 20_000) return 0;
    if (a.crossings === undefined) a.crossings = countSelfIntersections(a.mesh);
    return a.crossings;
  };
  const first = attempt(0);
  buildMs += first.buildMs;
  booleanMs += first.booleanMs;
  let chosen = first;

  if (!first.ok || crossings(first) > 0) {
    // A sub-micron coincidence between two solids is the usual cause; pulling
    // every arc in by 1e-4 mm moves the contacts apart.
    const second = attempt(RETRY_INSET);
    buildMs += second.buildMs;
    booleanMs += second.booleanMs;
    const score = (a: Attempt) =>
      (a.ok ? 4 : a.status === 'NoError' ? 2 : 0) + (a.ok && crossings(a) === 0 ? 1 : 0);
    const better =
      score(second) > score(first) ||
      (score(second) === score(first) && crossings(second) < crossings(first));
    if (better) chosen = second;
    warnings.push({
      code: 'bevel.retry',
      severity: 'info',
      message: first.ok
        ? 'The first result had crossing triangles; retried once with a 1e-4 mm arc inset.'
        : 'The first result was not watertight; retried once with a 1e-4 mm arc inset.',
    });
  }

  if (chosen.failedSolids > 0) {
    warnings.push({
      code: 'bevel.cutSolid',
      severity: 'warning',
      message: `${chosen.failedSolids} edge sweep${chosen.failedSolids === 1 ? '' : 's'} could not be built and ${chosen.failedSolids === 1 ? 'was' : 'were'} skipped.`,
    });
  }
  if (chosen.failedCorners > 0) {
    warnings.push({
      code: 'bevel.corner',
      severity: 'info',
      message: `${chosen.failedCorners} corner blend${chosen.failedCorners === 1 ? '' : 's'} could not be built; ${chosen.failedCorners === 1 ? 'that corner is' : 'those corners are'} mitred instead.`,
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
  } else if (chosen.shells > baseShells(cached)) {
    warnings.push({
      code: 'bevel.shells',
      severity: 'warning',
      message: `The result has ${chosen.shells} separate shells.`,
    });
  }

  const removed = volumeBefore - chosen.volume;
  const hasAdditive = concaveCount > 0;
  if (removed < -1e-6 && !hasAdditive) {
    warnings.push({
      code: 'bevel.volumeGain',
      severity: 'error',
      message: 'The bevel added material instead of removing it; check the mesh orientation.',
    });
  } else if (Math.abs(removed) <= 1e-6) {
    warnings.push({
      code: 'bevel.volumeUnchanged',
      severity: 'warning',
      message: 'The bevel changed no material.',
    });
  }

  const meta = computeBasicMeta(chosen.mesh, 'beveled');
  meta.volume = chosen.volume;
  meta.triangles = chosen.mesh.indices.length / 3;
  meta.vertices = chosen.mesh.positions.length / 3;
  meta.shells = chosen.shells;
  meta.watertight = chosen.ok;

  const triangleCount = chosen.mesh.indices.length / 3;
  const selfIntersections = crossings(chosen);
  if (selfIntersections > 0) {
    warnings.push({
      code: 'bevel.selfIntersection',
      severity: 'error',
      message: `The bevel produced ${selfIntersections} self-intersecting triangle pairs. Reduce the width or deselect the tight corners before exporting.`,
    });
  }

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
    endWidths: plan.endWidths,
    endTapers: plan.endTapers,
    corners: plan.blends.length,
  };
}

/**
 * Chain → Manifold, trimmed by the planes at its two free ends. When a trim
 * would leave nothing, falls back to the plain sweep without extensions.
 */
function buildPlannedChain(
  chain: PlannedSweep[],
  segments: number,
  profile: number,
  inset: number,
): Manifold | null {
  const make = (extended: boolean): Manifold | null => {
    const raw = buildChainSweep(
      chain.map((sweep) => ({
        a: sweep.a,
        b: sweep.b,
        n1: sweep.n1,
        n2: sweep.n2,
        concave: sweep.concave,
        radiusA: sweep.radiusA,
        radiusB: sweep.radiusB,
        taperA: sweep.taperA,
        taperB: sweep.taperB,
        extendA: extended ? sweep.extendA : 0,
        extendB: extended ? sweep.extendB : 0,
        segments,
        profile,
        band: BAND,
        inset,
      })),
    );
    if (!raw) return null;
    let solid: Manifold;
    try {
      solid = meshToManifold(raw);
    } catch {
      return null;
    }
    if (!extended) return solid;
    const head = chain[0];
    const tail = chain[chain.length - 1];
    if (chain.length === 1 && head.clipsA.length + head.clipsB.length > 0 && isShortSweep(head)) {
      // one short edge: whole-solid trims are exact and cheaper
      for (const clip of [...head.clipsA, ...head.clipsB]) solid = keepBelow(solid, clip.n, clip.c);
      return solid;
    }
    // Trim planes are infinite, but a long or curved chain may pass the plane
    // of its other end far away. Each trim only acts near its own end.
    for (const [clips, center, reach] of [
      [head.clipsA, head.a, trimReach(head, 0)],
      [tail.clipsB, tail.b, trimReach(tail, 1)],
    ] as const) {
      for (const clip of clips) solid = trimNear(solid, clip.n, clip.c, center, reach);
    }
    return solid;
  };
  // Trims stay lazy: forcing each one here would evaluate the CSG tree per
  // chain. A trim that removes everything simply contributes nothing.
  try {
    return make(true) ?? make(false);
  } catch {
    try {
      return make(false);
    } catch {
      return null;
    }
  }
}

/** Distance from a sweep end within which its trim planes act. */
function trimReach(sweep: PlannedSweep, end: 0 | 1): number {
  const r = end === 0 ? sweep.radiusA : sweep.radiusB;
  const extend = end === 0 ? sweep.extendA : sweep.extendB;
  const c = Math.max(-1, Math.min(1, sweep.n1[0] * sweep.n2[0] + sweep.n1[1] * sweep.n2[1] + sweep.n1[2] * sweep.n2[2]));
  const footprint = r * (Math.tan(Math.acos(c) / 2) + BAND + 1);
  return extend + 2 * footprint + 1e-3;
}

function isShortSweep(sweep: PlannedSweep): boolean {
  const L = Math.hypot(sweep.b[0] - sweep.a[0], sweep.b[1] - sweep.a[1], sweep.b[2] - sweep.a[2]);
  return L < Math.min(trimReach(sweep, 0), trimReach(sweep, 1));
}

/** Remove { n·x > c } but only inside the cube of half-size `reach` at `center`. */
function trimNear(
  solid: Manifold,
  n: readonly [number, number, number],
  c: number,
  center: readonly [number, number, number],
  reach: number,
): Manifold {
  const instance = requireWasm();
  const box = instance.Manifold.cube([2 * reach, 2 * reach, 2 * reach], true).translate([
    center[0],
    center[1],
    center[2],
  ]);
  const beyond = box.trimByPlane([n[0], n[1], n[2]], c);
  return solid.subtract(beyond);
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

export { KERNEL_NAME };
