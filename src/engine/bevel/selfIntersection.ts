import type { MeshData } from '../types';

/**
 * SAT self-intersection count, ported from the M0 spike. A mesh can be
 * topologically manifold (Manifold.status() === "NoError") and still have
 * triangles passing through each other, so this is a separate release gate.
 */
export function countSelfIntersections(mesh: MeshData): number {
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
  /**
   * Positions are float32 millimetres and the kernel welds the result at
   * 1e-3 mm (WELD_TOLERANCE in kernel.ts). A vertex within that same distance
   * of the other triangle's plane is part of the welded surface, not a
   * crossing. Such pairs are classified as coplanar and go through the 2-D
   * overlap test below instead of the 3-D SAT, which cannot tell a contact
   * from a crossing. This is a classification scale, not a blanket
   * intersection tolerance: a real crossing has vertices well on both sides.
   */
  const CONTACT_EPS = 1e-3;
  const sd = [D, E, F].map((v) => dot3(subV(v, A), n1) / l1);
  const st = [A, B, C].map((v) => dot3(subV(v, D), n2) / l2);
  const coplanar =
    sd.every((s) => Math.abs(s) <= CONTACT_EPS) &&
    st.every((s) => Math.abs(s) <= CONTACT_EPS);

  if (coplanar) {
    // the 3-D axes all collapse, so test the 2-D outlines instead
    return coplanarOverlap2D([A, B, C], [D, E, F], n1);
  }

  // A real crossing needs vertices strictly on both sides of the other plane.
  // One-sided contact (an edge or vertex lying on the plane) is not a crossing.
  if (Math.max(...sd) <= CONTACT_EPS || Math.min(...sd) >= -CONTACT_EPS) return false;
  if (Math.max(...st) <= CONTACT_EPS || Math.min(...st) >= -CONTACT_EPS) return false;

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

