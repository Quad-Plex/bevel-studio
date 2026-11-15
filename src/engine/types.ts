/**
 * Shared geometry contracts. Every module (worker, viewport, UI) speaks these
 * types; changing a field here is a breaking change for all workstreams.
 * Units are millimetres throughout, matching the imported STL.
 */

export type Vec3 = [number, number, number];

/** Indexed, welded triangle mesh. positions.length === vertexCount * 3. */
export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

export type EdgeKind = 'convex' | 'concave' | 'flat' | 'boundary' | 'nonManifold';

/**
 * Edge table produced once per repaired mesh. All per-edge arrays are indexed
 * by edge id and have length `count`. Parallel arrays keep transfer cheap and
 * let the renderer upload straight to GPU buffers.
 */
export interface EdgeTable {
  count: number;
  /** vertex ids, 2 per edge */
  v: Uint32Array;
  /** 6 floats per edge: x0,y0,z0,x1,y1,z1 */
  position: Float32Array;
  /** interior dihedral angle in degrees, 0 = coplanar */
  dihedral: Float32Array;
  /**
   * bit 0 convex, bit 1 concave, bit 2 boundary, bit 3 non-manifold,
   * bit 4 auto-detected candidate, bit 5 crease >= 30 deg
   */
  flags: Uint8Array;
  /** largest safe bevel width in mm for this edge, from local geometry */
  maxWidth: Float32Array;
  /** 2 triangle ids per edge, 0xffffffff when absent */
  tris: Uint32Array;
}

export const EDGE_CONVEX = 1 << 0;
export const EDGE_CONCAVE = 1 << 1;
export const EDGE_BOUNDARY = 1 << 2;
export const EDGE_NON_MANIFOLD = 1 << 3;
export const EDGE_CANDIDATE = 1 << 4;
export const EDGE_CREASE = 1 << 5;

export type RepairCode =
  | 'weld'
  | 'sliver'
  | 'degenerate'
  | 'duplicate'
  | 'flipped'
  | 'hole'
  | 'nonManifold'
  | 'shell'
  | 'orientation';

export interface RepairRecord {
  code: RepairCode;
  count: number;
  detail: string;
}

export interface MeshWarning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface MeshMeta {
  name: string;
  units: 'mm';
  /** true when the STL did not say mm; we still treat numbers as mm */
  unitsAssumed: boolean;
  bbox: Bounds;
  volume: number;
  area: number;
  triangles: number;
  vertices: number;
  edges: number;
  shells: number;
  genus: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  flippedTriangles: number;
  degenerateTriangles: number;
  watertight: boolean;
}

export interface AnalysisResult {
  meta: MeshMeta;
  edges: EdgeTable;
  repairs: RepairRecord[];
  warnings: MeshWarning[];
}

export interface BevelParams {
  /** fillet radius in mm; UI calls it width */
  width: number;
  /** 1 = chamfer, 2..8 = rounded */
  segments: number;
  /** 0.0 .. 1.0, 0.5 = circular */
  profile: number;
  /** auto-clamp width to the per-edge maxWidth */
  clampOverlap: boolean;
  /** shading applied to the result */
  smoothing: 'creased' | 'flat';
}

export const DEFAULT_BEVEL: BevelParams = {
  width: 0.5,
  segments: 4,
  profile: 0.5,
  clampOverlap: true,
  smoothing: 'creased',
};

export interface BevelResult {
  mesh: MeshData;
  meta: MeshMeta;
  /** width actually used after clamping, per edge id (parallel to input selection) */
  appliedWidth: Float32Array;
  clampedEdges: number;
  warnings: MeshWarning[];
  timings: { buildMs: number; booleanMs: number; totalMs: number };
  /** Triangle pairs passing through each other; 0 is the only safe value. */
  selfIntersections?: number;
  /**
   * One byte per result triangle: 1 when the triangle was created by a bevel
   * solid — a subtractive cut or an additive concave fillet (the bevel band) —
   * 0 when it is untouched base surface. Absent when the kernel could not
   * attribute faces, in which case nothing is tinted.
   */
  bevelFaces?: Uint8Array;
}

export interface ImportResult extends AnalysisResult {
  mesh: MeshData;
}
