/**
 * Spike edge table: per undirected edge the two adjacent triangles, the turn
 * angle (0 = flat), convexity, length and a rough safe width.
 *
 * Convexity test (PLAN §4.3, verbatim):
 *   for edge A–B with faces f1, f2, outward normals n1, n2 and opposite
 *   vertices C1, C2: convex iff dot(n1, C2 - C1) < 0.
 * It requires outward-facing windings, so `ensureOutward` runs first and flips
 * every triangle when the signed volume is negative.
 *
 * `maxWidth` is the cheap spike proxy the brief allows: half the distance from
 * the edge midpoint to the nearest midpoint of a non-incident edge (edges that
 * share a vertex do not count). It is O(E²) and only meant for meshes of a few
 * thousand edges — a production build needs a spatial index plus the altitude
 * and incident-edge-length limits from PLAN §4.3.
 */
import type { MeshData } from './load';

export interface EdgeTable {
  count: number;
  /** 2 vertex ids per edge */
  v: Uint32Array;
  /** 2 triangle ids per edge, 0xffffffff when absent */
  tris: Uint32Array;
  /** 6 floats per edge: x0 y0 z0 x1 y1 z1 */
  position: Float32Array;
  /** turn angle in degrees, 0 = coplanar */
  dihedral: Float32Array;
  /** 1 convex, 0 concave, 2 flat (below the 0.5° epsilon) */
  convex: Uint8Array;
  length: Float32Array;
  /** rough safe radius in mm */
  maxWidth: Float32Array;
  /** 6 floats per edge: outward normal of triangle 1 then triangle 2 */
  normals: Float32Array;
  boundaryEdges: number;
  nonManifoldEdges: number;
}

export interface EdgeStats {
  edges: number;
  convex: number;
  concave: number;
  flat: number;
  boundary: number;
  nonManifold: number;
}

const FLAT_DEG = 0.5;

/**
 * Flip every triangle if the mesh is inside-out. Mutates `indices` in place so
 * the caller's mesh stays the single source of truth. Returns true if flipped.
 */
export function ensureOutward(mesh: MeshData): boolean {
  const { positions: p, indices: idx } = mesh;
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  if (vol >= 0) return false;
  for (let t = 0; t < idx.length; t += 3) {
    const tmp = idx[t + 1];
    idx[t + 1] = idx[t + 2];
    idx[t + 2] = tmp;
  }
  return true;
}

export function buildEdgeTable(mesh: MeshData): EdgeTable {
  const { positions: p, indices: idx } = mesh;
  const triCount = idx.length / 3;
  const vertCount = p.length / 3;

  // --- group triangles per undirected edge ---------------------------------
  const key = (a: number, b: number) => (a < b ? a * vertCount + b : b * vertCount + a);
  const edgeOf = new Map<number, number>();
  const edgeV: number[] = [];
  const edgeTris: number[] = [];

  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k];
      const b = idx[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const kk = key(a, b);
      let e = edgeOf.get(kk);
      if (e === undefined) {
        e = edgeV.length / 2;
        edgeOf.set(kk, e);
        edgeV.push(Math.min(a, b), Math.max(a, b));
        edgeTris.push(t, 0xffffffff);
      } else if (edgeTris[e * 2 + 1] === 0xffffffff) {
        edgeTris[e * 2 + 1] = t;
      } else {
        // third face on the same edge: keep the first two, flag non-manifold
        edgeTris[e * 2 + 1] = 0x80000000;
      }
    }
  }

  const count = edgeV.length / 2;
  const v = new Uint32Array(edgeV);
  const tris = new Uint32Array(edgeTris);
  const position = new Float32Array(count * 6);
  const dihedral = new Float32Array(count);
  const convex = new Uint8Array(count);
  const length = new Float32Array(count);
  const maxWidth = new Float32Array(count);
  const normals = new Float32Array(count * 6);

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;

  const triNormal = (t: number, out: number[]) => {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    out[0] = nx; out[1] = ny; out[2] = nz;
  };

  const n1: number[] = [0, 0, 0];
  const n2: number[] = [0, 0, 0];

  for (let e = 0; e < count; e++) {
    const a = v[e * 2], b = v[e * 2 + 1];
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
    position[e * 6] = ax; position[e * 6 + 1] = ay; position[e * 6 + 2] = az;
    position[e * 6 + 3] = bx; position[e * 6 + 4] = by; position[e * 6 + 5] = bz;
    length[e] = Math.hypot(bx - ax, by - ay, bz - az);

    const t1 = tris[e * 2];
    const t2 = tris[e * 2 + 1];
    if (t2 === 0xffffffff) { boundaryEdges++; convex[e] = 2; dihedral[e] = 0; continue; }
    if (t2 === 0x80000000) { nonManifoldEdges++; convex[e] = 2; dihedral[e] = 0; continue; }

    triNormal(t1, n1);
    triNormal(t2, n2);
    normals[e * 6] = n1[0]; normals[e * 6 + 1] = n1[1]; normals[e * 6 + 2] = n1[2];
    normals[e * 6 + 3] = n2[0]; normals[e * 6 + 4] = n2[1]; normals[e * 6 + 5] = n2[2];

    const dotN = Math.min(1, Math.max(-1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]));
    const deg = (Math.acos(dotN) * 180) / Math.PI;
    dihedral[e] = deg;
    if (deg < FLAT_DEG) { convex[e] = 2; continue; }

    // opposite vertex of each triangle
    const c1 = oppositeVertex(idx, t1, a, b);
    const c2 = oppositeVertex(idx, t2, a, b);
    const dx = p[c2 * 3] - p[c1 * 3];
    const dy = p[c2 * 3 + 1] - p[c1 * 3 + 1];
    const dz = p[c2 * 3 + 2] - p[c1 * 3 + 2];
    convex[e] = n1[0] * dx + n1[1] * dy + n1[2] * dz < 0 ? 1 : 0;
  }

  // --- maxWidth: PLAN §4.3 terms, computed per edge ------------------------
  // 0.45 × min(altitude of each adjacent triangle from the edge, shortest edge
  // sharing a vertex). The "distance to the nearest selected edge at each
  // endpoint" term needs a spatial index and is left out; the midpoint-to-
  // midpoint proxy the brief suggested collapses to ~0.002 mm on this model
  // (sliver triangles), which makes a global clamp useless.
  const maxWidthMeasured = count <= 5000;
  for (let e = 0; e < count && maxWidthMeasured; e++) {
    let best = Infinity;
    for (const t of [tris[e * 2], tris[e * 2 + 1]]) {
      if (t === 0xffffffff || t === 0x80000000) continue;
      const c = oppositeVertex(idx, t, v[e * 2], v[e * 2 + 1]);
      const ax = p[v[e * 2] * 3], ay = p[v[e * 2] * 3 + 1], az = p[v[e * 2] * 3 + 2];
      const ux = p[v[e * 2 + 1] * 3] - ax, uy = p[v[e * 2 + 1] * 3 + 1] - ay, uz = p[v[e * 2 + 1] * 3 + 2] - az;
      const wx = p[c * 3] - ax, wy = p[c * 3 + 1] - ay, wz = p[c * 3 + 2] - az;
      const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
      const area2 = Math.hypot(cx, cy, cz);
      const alt = length[e] > 0 ? area2 / length[e] : 0;
      if (alt < best) best = alt;
    }
    for (let f = 0; f < count; f++) {
      if (f === e) continue;
      if (v[f * 2] !== v[e * 2] && v[f * 2] !== v[e * 2 + 1] && v[f * 2 + 1] !== v[e * 2] && v[f * 2 + 1] !== v[e * 2 + 1]) continue;
      if (length[f] < best) best = length[f];
    }
    maxWidth[e] = Number.isFinite(best) ? 0.45 * best : 1e3;
  }
  if (!maxWidthMeasured) maxWidth.fill(1e3);

  return { count, v, tris, position, dihedral, convex, length, maxWidth, normals, boundaryEdges, nonManifoldEdges };
}

function oppositeVertex(idx: Uint32Array, t: number, a: number, b: number): number {
  for (let k = 0; k < 3; k++) {
    const x = idx[t * 3 + k];
    if (x !== a && x !== b) return x;
  }
  return idx[t * 3];
}

export function edgeStats(table: EdgeTable): EdgeStats {
  let convex = 0, concave = 0, flat = 0;
  for (let e = 0; e < table.count; e++) {
    if (table.convex[e] === 1) convex++;
    else if (table.convex[e] === 0) concave++;
    else flat++;
  }
  return {
    edges: table.count,
    convex,
    concave,
    flat,
    boundary: table.boundaryEdges,
    nonManifold: table.nonManifoldEdges,
  };
}

/**
 * Per-vertex incident edge ids in CSR form: edges of vertex v are
 * `ids[offset[v] .. offset[v+1])`.
 */
export function vertexIncidence(table: EdgeTable, vertexCount: number): { offset: Uint32Array; ids: Uint32Array } {
  const offset = new Uint32Array(vertexCount + 1);
  for (let e = 0; e < table.count; e++) {
    offset[table.v[e * 2] + 1]++;
    offset[table.v[e * 2 + 1] + 1]++;
  }
  for (let i = 0; i < vertexCount; i++) offset[i + 1] += offset[i];
  const cursor = offset.slice();
  const ids = new Uint32Array(offset[vertexCount]);
  for (let e = 0; e < table.count; e++) {
    ids[cursor[table.v[e * 2]]++] = e;
    ids[cursor[table.v[e * 2 + 1]]++] = e;
  }
  return { offset, ids };
}
