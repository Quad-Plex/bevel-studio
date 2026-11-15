import type { EdgeTable, MeshData } from '../types';
import {
  EDGE_BOUNDARY,
  EDGE_CANDIDATE,
  EDGE_CONCAVE,
  EDGE_CONVEX,
  EDGE_CREASE,
  EDGE_NON_MANIFOLD,
} from '../types';
import { buildTopology, type MeshTopology } from './topology';

/** Below this the two faces are treated as coplanar; the dihedral is still reported. */
const FLAT_DEG = 0.5;
/** Auto-detected bevel candidates. */
const CANDIDATE_DEG = 20;
/** Crease flag used by shading. */
const CREASE_DEG = 30;
const MAX_WIDTH = 10;
const MAX_RING = 64;
/**
 * Incident edges shorter than this do not constrain the clamp. The bevel
 * kernel collapses edges below 0.05 mm and lets their neighbours bridge the
 * gap; letting a 0.001 mm tessellation edge clamp a 35 mm chain edge to
 * 0.0005 mm is what made the reference hook's bevel patchy.
 */
const MIN_CLAMP_EDGE = 0.05;

/**
 * Build the canonical edge table for a repaired mesh.
 *
 * Edge ids come from `MeshTopology`, which assigns them exactly like
 * `orderEdges()` in `edgeOrder.ts`. Convexity is the robust opposite-vertex
 * test: for edge (a,b) with faces f1/f2 and opposite vertices C1/C2,
 * `dot(n1, C2 - C1) < 0` means convex. It requires outward-facing windings;
 * `analyzeMesh` repairs those first.
 */
export function buildEdgeTable(mesh: MeshData, topology?: MeshTopology): EdgeTable {
  const topo = topology ?? buildTopology(mesh);
  const { positions, indices } = mesh;
  const count = topo.edgeCount;
  const triCount = topo.triCount;

  const v = topo.edgeV;
  const position = new Float32Array(count * 6);
  const dihedral = new Float32Array(count);
  const flags = new Uint8Array(count);
  const tris = new Uint32Array(count * 2);
  const maxWidth = computeMaxWidth(mesh, topo);

  const normals = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    const a = indices[base] * 3;
    const b = indices[base + 1] * 3;
    const c = indices[base + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const wx = positions[c] - positions[a];
    const wy = positions[c + 1] - positions[a + 1];
    const wz = positions[c + 2] - positions[a + 2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    normals[base] = nx;
    normals[base + 1] = ny;
    normals[base + 2] = nz;
  }

  for (let e = 0; e < count; e++) {
    const a = v[e * 2];
    const b = v[e * 2 + 1];
    position[e * 6] = positions[a * 3];
    position[e * 6 + 1] = positions[a * 3 + 1];
    position[e * 6 + 2] = positions[a * 3 + 2];
    position[e * 6 + 3] = positions[b * 3];
    position[e * 6 + 4] = positions[b * 3 + 1];
    position[e * 6 + 5] = positions[b * 3 + 2];

    const start = topo.edgeOffset[e];
    const end = topo.edgeOffset[e + 1];
    const incidence = end - start;
    const t1 = topo.edgeTris[start];
    tris[e * 2] = t1;
    tris[e * 2 + 1] = incidence >= 2 ? topo.edgeTris[start + 1] : 0xffffffff;

    if (incidence === 1) {
      flags[e] = EDGE_BOUNDARY;
      dihedral[e] = 0;
      continue;
    }

    if (incidence > 2) flags[e] = EDGE_NON_MANIFOLD;

    const t2 = topo.edgeTris[start + 1];
    const n1x = normals[t1 * 3];
    const n1y = normals[t1 * 3 + 1];
    const n1z = normals[t1 * 3 + 2];
    const n2x = normals[t2 * 3];
    const n2y = normals[t2 * 3 + 1];
    const n2z = normals[t2 * 3 + 2];

    const dot = Math.min(1, Math.max(-1, n1x * n2x + n1y * n2y + n1z * n2z));
    const deg = (Math.acos(dot) * 180) / Math.PI;
    dihedral[e] = deg;

    // A non-manifold edge has no unambiguous convexity; report the angle but
    // leave it ineligible for beveling.
    if (incidence !== 2 || deg < FLAT_DEG) continue;

    const c1 = oppositeVertex(indices, t1, a, b);
    const c2 = oppositeVertex(indices, t2, a, b);
    const dx = positions[c2 * 3] - positions[c1 * 3];
    const dy = positions[c2 * 3 + 1] - positions[c1 * 3 + 1];
    const dz = positions[c2 * 3 + 2] - positions[c1 * 3 + 2];
    const convex = n1x * dx + n1y * dy + n1z * dz < 0;

    if (convex) {
      flags[e] |= EDGE_CONVEX;
      if (deg >= CANDIDATE_DEG) flags[e] |= EDGE_CANDIDATE;
    } else {
      flags[e] |= EDGE_CONCAVE;
    }
    if (deg >= CREASE_DEG) flags[e] |= EDGE_CREASE;
  }

  return { count, v, position, dihedral, flags, maxWidth, tris };
}

function oppositeVertex(indices: Uint32Array, t: number, a: number, b: number): number {
  const base = t * 3;
  const i0 = indices[base];
  if (i0 !== a && i0 !== b) return i0;
  const i1 = indices[base + 1];
  if (i1 !== a && i1 !== b) return i1;
  return indices[base + 2];
}

/**
 * Per-edge safe bevel width.
 *
 * `min(0.5 * shortest incident edge length, 0.5 * distance from this edge's
 * midpoint to the nearest non-incident edge midpoint)`, clamped to [0, 10] mm.
 *
 * The distance term is computed with a spatial hash of edge midpoints. Only
 * midpoints closer than the incident-edge term can lower the result, so the
 * search radius is that term. This is deliberately per edge: the spike showed
 * that a global minimum over a selection collapses to 0.002 mm on the
 * reference hook. Incident edges below MIN_CLAMP_EDGE are ignored because the
 * kernel bridges them instead of beveling them (see that constant).
 */
export function computeMaxWidth(mesh: MeshData, topo: MeshTopology): Float32Array {
  const edgeCount = topo.edgeCount;
  const out = new Float32Array(edgeCount);
  if (edgeCount === 0) return out;

  const { positions } = mesh;
  const v = topo.edgeV;
  const vertexCount = topo.vertexCount;

  const length = new Float64Array(edgeCount);
  const mid = new Float64Array(edgeCount * 3);
  const vMin = new Float64Array(vertexCount);
  vMin.fill(Infinity);
  const vMinAny = new Float64Array(vertexCount);
  vMinAny.fill(Infinity);

  let lengthSum = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let e = 0; e < edgeCount; e++) {
    const a = v[e * 2];
    const b = v[e * 2 + 1];
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const bx = positions[b * 3];
    const by = positions[b * 3 + 1];
    const bz = positions[b * 3 + 2];
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    length[e] = len;
    lengthSum += len;
    if (len < vMinAny[a]) vMinAny[a] = len;
    if (len < vMinAny[b]) vMinAny[b] = len;
    if (len >= MIN_CLAMP_EDGE) {
      if (len < vMin[a]) vMin[a] = len;
      if (len < vMin[b]) vMin[b] = len;
    }
    mid[e * 3] = (ax + bx) * 0.5;
    mid[e * 3 + 1] = (ay + by) * 0.5;
    mid[e * 3 + 2] = (az + bz) * 0.5;

    if (ax < minX) minX = ax;
    if (ay < minY) minY = ay;
    if (az < minZ) minZ = az;
    if (ax > maxX) maxX = ax;
    if (ay > maxY) maxY = ay;
    if (az > maxZ) maxZ = az;
    if (bx < minX) minX = bx;
    if (by < minY) minY = by;
    if (bz < minZ) minZ = bz;
    if (bx > maxX) maxX = bx;
    if (by > maxY) maxY = by;
    if (bz > maxZ) maxZ = bz;
  }

  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const mean = lengthSum / edgeCount;
  let cell = Math.max(mean * 1.5, Number.isFinite(diag) ? diag * 1e-4 : 0, 1e-6);
  if (!Number.isFinite(cell) || cell <= 0) cell = 1;

  // Spatial hash of midpoints: head + linked list, one bucket per occupied
  // cell hash. Hash collisions only add candidates; they never remove any.
  const head = new Map<number, number>();
  const next = new Int32Array(edgeCount);
  next.fill(-1);
  for (let e = 0; e < edgeCount; e++) {
    const ix = Math.floor(mid[e * 3] / cell);
    const iy = Math.floor(mid[e * 3 + 1] / cell);
    const iz = Math.floor(mid[e * 3 + 2] / cell);
    const h = cellHash(ix, iy, iz);
    next[e] = head.get(h) ?? -1;
    head.set(h, e);
  }

  const stamp = new Uint32Array(edgeCount);
  let queryId = 0;

  const inspectCell = (
    cx: number,
    cy: number,
    cz: number,
    e: number,
    a: number,
    b: number,
    mx: number,
    my: number,
    mz: number,
    currentBest: number,
  ): number => {
    const bucket = head.get(cellHash(cx, cy, cz));
    for (let f = bucket; f !== undefined && f >= 0; f = next[f]) {
      if (stamp[f] === queryId) continue;
      stamp[f] = queryId;
      if (f === e) continue;
      const fa = v[f * 2];
      const fb = v[f * 2 + 1];
      if (fa === a || fa === b || fb === a || fb === b) continue;
      const dx = mid[f * 3] - mx;
      const dy = mid[f * 3 + 1] - my;
      const dz = mid[f * 3 + 2] - mz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < currentBest) currentBest = d2;
    }
    return currentBest;
  };

  for (let e = 0; e < edgeCount; e++) {
    if (queryId === 0xffffffff) {
      stamp.fill(0);
      queryId = 0;
    }
    queryId++;

    const a = v[e * 2];
    const b = v[e * 2 + 1];
    const aMin = Number.isFinite(vMin[a]) ? vMin[a] : vMinAny[a];
    const bMin = Number.isFinite(vMin[b]) ? vMin[b] : vMinAny[b];
    // The edge's own length always caps its width, exactly as when the
    // unfiltered vMin included the edge itself.
    const incident = Math.min(aMin, bMin, length[e]);
    if (!Number.isFinite(incident) || incident <= 0) {
      out[e] = 0;
      continue;
    }

    let best = 0.5 * incident;
    // A midpoint farther than `incident` cannot beat the incident term, and a
    // width above 10 mm is clamped anyway.
    const radius = Math.min(incident, MAX_WIDTH * 2);
    const radius2 = radius * radius;
    let bestDist2 = radius2;

    const mx = mid[e * 3];
    const my = mid[e * 3 + 1];
    const mz = mid[e * 3 + 2];
    const ix = Math.floor(mx / cell);
    const iy = Math.floor(my / cell);
    const iz = Math.floor(mz / cell);

    const cellLimit = Math.ceil(radius / cell) + 1;
    const ringLimit = Math.min(MAX_RING, cellLimit);
    const capped = ringLimit < cellLimit;
    let stopped = false;

    for (let r = 0; r <= ringLimit; r++) {
      if (r === 0) {
        bestDist2 = inspectCell(ix, iy, iz, e, a, b, mx, my, mz, bestDist2);
      } else {
        // Visit exactly the cells on the surface of the Chebyshev cube of
        // radius r; scanning the whole cube would be O(r^3) per edge.
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            bestDist2 = inspectCell(ix + dx, iy + dy, iz - r, e, a, b, mx, my, mz, bestDist2);
            bestDist2 = inspectCell(ix + dx, iy + dy, iz + r, e, a, b, mx, my, mz, bestDist2);
          }
        }
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r + 1; dz <= r - 1; dz++) {
            bestDist2 = inspectCell(ix + dx, iy - r, iz + dz, e, a, b, mx, my, mz, bestDist2);
            bestDist2 = inspectCell(ix + dx, iy + r, iz + dz, e, a, b, mx, my, mz, bestDist2);
          }
        }
        for (let dy = -r + 1; dy <= r - 1; dy++) {
          for (let dz = -r + 1; dz <= r - 1; dz++) {
            bestDist2 = inspectCell(ix - r, iy + dy, iz + dz, e, a, b, mx, my, mz, bestDist2);
            bestDist2 = inspectCell(ix + r, iy + dy, iz + dz, e, a, b, mx, my, mz, bestDist2);
          }
        }
      }

      if (r * cell > radius) {
        stopped = true;
        break;
      }
      if (bestDist2 <= r * cell * (r * cell)) {
        stopped = true;
        break;
      }
    }

    // Pathologically sparse meshes can have a search radius larger than the
    // ring cap. Fall back to a linear scan for those rare edges so the result
    // stays exact rather than silently optimistic.
    if (capped && !stopped) {
      for (let f = 0; f < edgeCount; f++) {
        if (f === e) continue;
        const fa = v[f * 2];
        const fb = v[f * 2 + 1];
        if (fa === a || fa === b || fb === a || fb === b) continue;
        const dx = mid[f * 3] - mx;
        const dy = mid[f * 3 + 1] - my;
        const dz = mid[f * 3 + 2] - mz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDist2) bestDist2 = d2;
      }
    }

    if (bestDist2 < radius2) best = Math.min(best, 0.5 * Math.sqrt(bestDist2));
    const width = Math.min(MAX_WIDTH, Math.max(0, best));
    out[e] = Number.isFinite(width) ? width : 0;
  }

  return out;
}

function cellHash(cx: number, cy: number, cz: number): number {
  let h =
    Math.imul(cx | 0, 0x8da6b343) ^
    Math.imul(cy | 0, 0xd8163841) ^
    Math.imul(cz | 0, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) | 0;
}
