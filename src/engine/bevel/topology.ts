/**
 * Internal edge table for the bevel kernel.
 *
 * Edge ids are produced by the frozen `edgeOrder.ts` contract, so a selection
 * coming from the analyzer points at exactly the same undirected edges here.
 * Production receives only ids, therefore the kernel rebuilds the adjacency
 * once per MeshData object (cached by identity in `kernel.ts`).
 *
 * `convex` encoding: 1 = convex, 0 = concave, 2 = flat, boundary or
 * non-manifold. `dihedral` is the angle between the two face normals in
 * degrees, 0 = coplanar.
 */
import { edgeKey, keyA, keyB, orderEdges } from '../topo/edgeOrder';
import type { MeshData } from '../types';

export const EDGE_ABSENT = 0xffffffff;
/** second triangle slot marker for a third face on the same edge */
export const EDGE_THIRD = 0x80000000;
export const FLAT_DEGREES = 0.5;

export interface MeshTopology {
  edgeCount: number;
  /** vertex ids, 2 per edge */
  v: Uint32Array;
  /** 2 triangle ids per edge, EDGE_ABSENT when missing */
  tris: Uint32Array;
  /** 6 floats per edge: outward normal of triangle 1 then triangle 2 */
  normals: Float32Array;
  /** interior dihedral in degrees, 0 = coplanar */
  dihedral: Float32Array;
  /** 1 convex, 0 concave, 2 flat/boundary/non-manifold */
  convex: Uint8Array;
  /** edge length in mm */
  length: Float32Array;
  /** per-vertex incident edge ids in CSR form */
  vertexOffset: Uint32Array;
  vertexEdges: Uint32Array;
  /** local safe width, lazily filled; NaN = not computed yet */
  localMaxWidth: Float32Array;
  /** 3 floats per triangle */
  faceNormals: Float32Array;
}

export function buildTopology(mesh: MeshData): MeshTopology {
  const { positions: p, indices: idx } = mesh;
  const vertexCount = p.length / 3;
  const triCount = idx.length / 3;
  const order = orderEdges(idx, vertexCount);
  const count = order.count;

  const idOf = new Map<number, number>();
  for (let e = 0; e < count; e++) idOf.set(order.keys[e], e);

  const v = new Uint32Array(count * 2);
  for (let e = 0; e < count; e++) {
    v[e * 2] = keyA(order.keys[e]);
    v[e * 2 + 1] = keyB(order.keys[e]);
  }

  const tris = new Uint32Array(count * 2).fill(EDGE_ABSENT);
  const faceNormals = new Float32Array(triCount * 3);

  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const wx = p[c] - p[a];
    const wy = p[c + 1] - p[a + 1];
    const wz = p[c + 2] - p[a + 2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) {
      nx /= l;
      ny /= l;
      nz /= l;
    }
    faceNormals[t * 3] = nx;
    faceNormals[t * 3 + 1] = ny;
    faceNormals[t * 3 + 2] = nz;
  }

  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k];
      const b = idx[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const e = idOf.get(edgeKey(a, b));
      if (e === undefined) continue; // cannot happen; orderEdges walked the same triangles
      if (tris[e * 2] === EDGE_ABSENT) tris[e * 2] = t;
      else if (tris[e * 2 + 1] === EDGE_ABSENT) tris[e * 2 + 1] = t;
      else tris[e * 2 + 1] = EDGE_THIRD;
    }
  }

  const normals = new Float32Array(count * 6);
  const dihedral = new Float32Array(count);
  const convex = new Uint8Array(count);
  const length = new Float32Array(count);

  const n1: [number, number, number] = [0, 0, 0];
  const n2: [number, number, number] = [0, 0, 0];

  for (let e = 0; e < count; e++) {
    const a = v[e * 2];
    const b = v[e * 2 + 1];
    const ax = p[a * 3];
    const ay = p[a * 3 + 1];
    const az = p[a * 3 + 2];
    const bx = p[b * 3];
    const by = p[b * 3 + 1];
    const bz = p[b * 3 + 2];
    length[e] = Math.hypot(bx - ax, by - ay, bz - az);

    const t1 = tris[e * 2];
    const t2 = tris[e * 2 + 1];
    if (t2 === EDGE_ABSENT || t2 === EDGE_THIRD) {
      convex[e] = 2;
      continue;
    }

    n1[0] = faceNormals[t1 * 3];
    n1[1] = faceNormals[t1 * 3 + 1];
    n1[2] = faceNormals[t1 * 3 + 2];
    n2[0] = faceNormals[t2 * 3];
    n2[1] = faceNormals[t2 * 3 + 1];
    n2[2] = faceNormals[t2 * 3 + 2];
    normals[e * 6] = n1[0];
    normals[e * 6 + 1] = n1[1];
    normals[e * 6 + 2] = n1[2];
    normals[e * 6 + 3] = n2[0];
    normals[e * 6 + 4] = n2[1];
    normals[e * 6 + 5] = n2[2];

    const dotN = Math.min(1, Math.max(-1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]));
    const deg = (Math.acos(dotN) * 180) / Math.PI;
    dihedral[e] = deg;
    if (deg < FLAT_DEGREES) {
      convex[e] = 2;
      continue;
    }

    // PLAN §4.3: the neighbour's opposite vertex lies behind face 1.
    const c1 = oppositeVertex(idx, t1, a, b);
    const c2 = oppositeVertex(idx, t2, a, b);
    const dx = p[c2 * 3] - p[c1 * 3];
    const dy = p[c2 * 3 + 1] - p[c1 * 3 + 1];
    const dz = p[c2 * 3 + 2] - p[c1 * 3 + 2];
    convex[e] = n1[0] * dx + n1[1] * dy + n1[2] * dz < 0 ? 1 : 0;
  }

  // per-vertex incident edge ids in CSR form
  const vertexOffset = new Uint32Array(vertexCount + 1);
  for (let e = 0; e < count; e++) {
    vertexOffset[v[e * 2] + 1]++;
    vertexOffset[v[e * 2 + 1] + 1]++;
  }
  for (let i = 0; i < vertexCount; i++) vertexOffset[i + 1] += vertexOffset[i];
  const cursor = vertexOffset.slice();
  const vertexEdges = new Uint32Array(vertexOffset[vertexCount]);
  for (let e = 0; e < count; e++) {
    vertexEdges[cursor[v[e * 2]]++] = e;
    vertexEdges[cursor[v[e * 2 + 1]]++] = e;
  }

  return {
    edgeCount: count,
    v,
    tris,
    normals,
    dihedral,
    convex,
    length,
    vertexOffset,
    vertexEdges,
    localMaxWidth: new Float32Array(count).fill(NaN),
    faceNormals,
  };
}

/**
 * Local safe width for one edge, from PLAN §4.3: 0.45 × the smaller of the
 * altitudes of the two adjacent triangles and the shortest edge sharing a
 * vertex. The "distance to the nearest other selected edge" term is the
 * analyzer's job; this is only the fallback when the caller does not supply
 * `maxWidth`.
 */
export function localMaxWidth(topo: MeshTopology, mesh: MeshData, edge: number): number {
  const cached = topo.localMaxWidth[edge];
  if (Number.isFinite(cached)) return cached;

  const p = mesh.positions;
  const idx = mesh.indices;
  const a = topo.v[edge * 2];
  const b = topo.v[edge * 2 + 1];
  const L = topo.length[edge];
  let best = Infinity;

  if (L > 1e-9) {
    for (let s = 0; s < 2; s++) {
      const t = topo.tris[edge * 2 + s];
      if (t === EDGE_ABSENT || t === EDGE_THIRD) continue;
      const c = oppositeVertex(idx, t, a, b);
      const ax = p[a * 3];
      const ay = p[a * 3 + 1];
      const az = p[a * 3 + 2];
      const ux = p[b * 3] - ax;
      const uy = p[b * 3 + 1] - ay;
      const uz = p[b * 3 + 2] - az;
      const wx = p[c * 3] - ax;
      const wy = p[c * 3 + 1] - ay;
      const wz = p[c * 3 + 2] - az;
      const cx = uy * wz - uz * wy;
      const cy = uz * wx - ux * wz;
      const cz = ux * wy - uy * wx;
      const altitude = Math.hypot(cx, cy, cz) / L;
      if (altitude < best) best = altitude;
    }
  }

  for (const vertex of [a, b]) {
    for (let i = topo.vertexOffset[vertex]; i < topo.vertexOffset[vertex + 1]; i++) {
      const f = topo.vertexEdges[i];
      if (f !== edge && topo.length[f] < best) best = topo.length[f];
    }
  }

  const width = Number.isFinite(best) ? 0.45 * best : 0;
  topo.localMaxWidth[edge] = width;
  return width;
}

export function oppositeVertex(idx: Uint32Array, t: number, a: number, b: number): number {
  for (let k = 0; k < 3; k++) {
    const x = idx[t * 3 + k];
    if (x !== a && x !== b) return x;
  }
  return idx[t * 3];
}
