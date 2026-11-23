/**
 * Static triangle BVH for ray queries.
 *
 * The bevel kernel measures how much room a fillet has by casting short rays
 * along the faces next to a selected edge (see `clamp.ts`). A linear scan per
 * ray would be O(n) and make a 1 M-triangle preview unusable, so the kernel
 * builds this tree once per mesh and caches it with the topology.
 *
 * Median split on the longest centroid axis, 4 triangles per leaf, flat
 * arrays so the tree is cheap to build and walk without allocation.
 */
import type { MeshData } from '../types';

const LEAF = 4;

export interface TriangleBvh {
  /** 6 floats per node: min xyz, max xyz */
  bounds: Float64Array;
  /** per node: left child or first triangle slot */
  first: Int32Array;
  /** per node: 0 = inner node (children first, first+1), >0 = triangle count */
  count: Int32Array;
  /** triangle ids in leaf order */
  order: Uint32Array;
  positions: Float32Array;
  indices: Uint32Array;
}

export function buildBvh(mesh: MeshData): TriangleBvh {
  const { positions: p, indices: idx } = mesh;
  const triCount = idx.length / 3;
  const centroid = new Float64Array(triCount * 3);
  const triMin = new Float64Array(triCount * 3);
  const triMax = new Float64Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let c = 0; c < 3; c++) {
        const value = p[idx[t * 3 + c] * 3 + k];
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      triMin[t * 3 + k] = lo;
      triMax[t * 3 + k] = hi;
      centroid[t * 3 + k] = (lo + hi) / 2;
    }
  }

  const order = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) order[t] = t;

  const maxNodes = Math.max(1, 2 * Math.ceil(triCount / LEAF) + 1);
  const bounds = new Float64Array(maxNodes * 6);
  const first = new Int32Array(maxNodes);
  const count = new Int32Array(maxNodes);
  let nodes = 0;

  const stack: [number, number, number][] = []; // node, start, end
  const root = nodes++;
  stack.push([root, 0, triCount]);
  while (stack.length > 0) {
    const [node, start, end] = stack.pop()!;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const t = order[i];
      if (triMin[t * 3] < minX) minX = triMin[t * 3];
      if (triMin[t * 3 + 1] < minY) minY = triMin[t * 3 + 1];
      if (triMin[t * 3 + 2] < minZ) minZ = triMin[t * 3 + 2];
      if (triMax[t * 3] > maxX) maxX = triMax[t * 3];
      if (triMax[t * 3 + 1] > maxY) maxY = triMax[t * 3 + 1];
      if (triMax[t * 3 + 2] > maxZ) maxZ = triMax[t * 3 + 2];
      const cx = centroid[t * 3];
      const cy = centroid[t * 3 + 1];
      const cz = centroid[t * 3 + 2];
      if (cx < cMinX) cMinX = cx;
      if (cy < cMinY) cMinY = cy;
      if (cz < cMinZ) cMinZ = cz;
      if (cx > cMaxX) cMaxX = cx;
      if (cy > cMaxY) cMaxY = cy;
      if (cz > cMaxZ) cMaxZ = cz;
    }
    const o = node * 6;
    bounds[o] = minX;
    bounds[o + 1] = minY;
    bounds[o + 2] = minZ;
    bounds[o + 3] = maxX;
    bounds[o + 4] = maxY;
    bounds[o + 5] = maxZ;

    const n = end - start;
    const ex = cMaxX - cMinX;
    const ey = cMaxY - cMinY;
    const ez = cMaxZ - cMinZ;
    if (n <= LEAF || Math.max(ex, ey, ez) <= 0) {
      first[node] = start;
      count[node] = n;
      continue;
    }
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = (start + end) >> 1;
    nthElement(order, start, end, mid, (t) => centroid[t * 3 + axis]);

    const left = nodes++;
    const right = nodes++;
    first[node] = left;
    count[node] = 0;
    // right is always left + 1
    void right;
    stack.push([left, start, mid]);
    stack.push([left + 1, mid, end]);
  }

  return {
    bounds: bounds.subarray(0, nodes * 6),
    first: first.subarray(0, nodes),
    count: count.subarray(0, nodes),
    order,
    positions: p,
    indices: idx,
  };
}

/** Quickselect so that order[k] is the k-th smallest key within [lo, hi). */
function nthElement(
  order: Uint32Array,
  lo: number,
  hi: number,
  k: number,
  key: (t: number) => number,
): void {
  let left = lo;
  let right = hi - 1;
  while (right > left) {
    const pivot = key(order[(left + right) >> 1]);
    let i = left;
    let j = right;
    while (i <= j) {
      while (key(order[i]) < pivot) i++;
      while (key(order[j]) > pivot) j--;
      if (i <= j) {
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
        i++;
        j--;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return;
  }
}

/**
 * Distance to the first triangle hit along the ray, or `Infinity`. Triangles
 * in `skip` are ignored (the faces the ray starts on).
 */
export function raycast(
  bvh: TriangleBvh,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMax: number,
  skip?: ReadonlySet<number>,
): number {
  const { bounds, first, count, order, positions: p, indices: idx } = bvh;
  const ix = dx !== 0 ? 1 / dx : Infinity;
  const iy = dy !== 0 ? 1 / dy : Infinity;
  const iz = dz !== 0 ? 1 / dz : Infinity;
  let best = tMax;
  const stack: number[] = [0];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const o = node * 6;
    // slab test
    let t0 = 0;
    let t1 = best;
    let a = (bounds[o] - ox) * ix;
    let b = (bounds[o + 3] - ox) * ix;
    if (Number.isNaN(a) || Number.isNaN(b)) {
      if (ox < bounds[o] || ox > bounds[o + 3]) continue;
    } else {
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    a = (bounds[o + 1] - oy) * iy;
    b = (bounds[o + 4] - oy) * iy;
    if (Number.isNaN(a) || Number.isNaN(b)) {
      if (oy < bounds[o + 1] || oy > bounds[o + 4]) continue;
    } else {
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    a = (bounds[o + 2] - oz) * iz;
    b = (bounds[o + 5] - oz) * iz;
    if (Number.isNaN(a) || Number.isNaN(b)) {
      if (oz < bounds[o + 2] || oz > bounds[o + 5]) continue;
    } else {
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }

    const n = count[node];
    if (n === 0) {
      stack.push(first[node], first[node] + 1);
      continue;
    }
    for (let i = first[node]; i < first[node] + n; i++) {
      const t = order[i];
      if (skip && skip.has(t)) continue;
      const va = idx[t * 3] * 3;
      const vb = idx[t * 3 + 1] * 3;
      const vc = idx[t * 3 + 2] * 3;
      // Möller–Trumbore, two-sided
      const e1x = p[vb] - p[va];
      const e1y = p[vb + 1] - p[va + 1];
      const e1z = p[vb + 2] - p[va + 2];
      const e2x = p[vc] - p[va];
      const e2y = p[vc + 1] - p[va + 1];
      const e2z = p[vc + 2] - p[va + 2];
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det;
      const sx = ox - p[va];
      const sy = oy - p[va + 1];
      const sz = oz - p[va + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (hit > 1e-9 && hit < best) best = hit;
    }
  }
  return best;
}
