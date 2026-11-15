/**
 * Cut-solid construction for the rolling-ball bevel.
 *
 * For one convex edge A–B with adjacent outward face normals n1, n2 and radius
 * r, the solid to remove is the sweep of the 2-D sliver between the sharp edge
 * and the fillet arc. Perpendicular to the edge the sliver is bounded by the
 * two face traces (A→t1 and A→t2) and the arc of radius r centred at c, the
 * point at distance r inside both faces.
 *
 *   m1 = -n1, m2 = -n2            (inward face normals, both ⟂ edge)
 *   c  = A + r·(m1 + m2)/(1 + m1·m2)
 *   t1 = foot of the perpendicular from c onto face 1
 *   t2 = foot of the perpendicular from c onto face 2
 *
 * The feet are computed in the local (ex, ey) frame as `cx - R·cosHalf`, not
 * as `A + r·m2`: the shortcut is only correct when the two faces are
 * perpendicular. This is correction #1 from the M0 spike report.
 *
 * The sweep is a closed triangle mesh: rings of (segments + 2) vertices, quad
 * side walls split into triangles, a fan cap at each end. When a taper length
 * is given the radius falls linearly to 0 over that length and the ring
 * collapses to an apex, so the bevel fades out without leaving a wall.
 *
 * `inset` pulls the fillet arc in by that many mm (the arc radius becomes
 * r - inset while the centre stays put). It is only used by the kernel's
 * one-shot retry when a boolean result is not manifold.
 */
import type { Manifold, ManifoldToplevel } from 'manifold-3d';

export type Vec3 = [number, number, number];

export interface RawSolid {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface EdgeCutParams {
  radius: number;
  segments: number;
  profile: number;
  /** mm the arc is pulled in; 0 = exact tangency with the faces */
  inset: number;
  /** taper length at A, 0 = full radius to the end of the edge */
  taperA: number;
  /** taper length at B */
  taperB: number;
  /** stations used across each taper */
  taperStations: number;
  /** mm the section corner is pushed outside the two face planes */
  extend: number;
}

// --- tiny vector helpers ----------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

// --- cross-section ----------------------------------------------------------

interface SectionFrame {
  ex: Vec3; // bisector of the two inward normals, points at the arc centre
  ey: Vec3; // in-plane, ⟂ ex
  half: number; // half the angle between the inward normals
  cosHalf: number;
}

function sectionFrame(n1: Vec3, n2: Vec3, dRaw: Vec3): SectionFrame | null {
  const d = unit(dRaw);
  let m1 = mul(n1, -1);
  let m2 = mul(n2, -1);
  // guard against float drift: both must be exactly perpendicular to the edge
  m1 = unit(sub(m1, mul(d, dot(m1, d))));
  m2 = unit(sub(m2, mul(d, dot(m2, d))));
  const c = dot(m1, m2);
  const denom = 1 + c;
  if (denom < 1e-4) return null; // faces nearly co-planar: nothing to remove
  const bis = add(m1, m2);
  if (len(bis) < 1e-6) return null; // folded back on itself
  const ex = unit(bis);
  const ey = unit(sub(m1, m2));
  const half = Math.acos(clamp(c, -1, 1)) / 2;
  const cosHalf = Math.cos(half);
  if (cosHalf < 1e-4) return null;
  return { ex, ey, half, cosHalf };
}

/**
 * Local 2-D outline of the section at radius `rho`, as a flat array of (x, y)
 * pairs in the (ex, ey) frame: index 0 is the corner, 1..segments+1 are the
 * fillet from t1 to t2.
 *
 * `sideExtend` pushes the corner point ε outside both face planes while the
 * fillet arc stays exact. The extra triangle is outside the solid, so the
 * removed volume is unchanged, but the cut's side faces are no longer coplanar
 * with the base faces.
 */
function section2D(
  rho: number,
  frame: SectionFrame,
  segments: number,
  profile: number,
  inset: number,
  sideExtend: number,
): number[] {
  const R = Math.max(rho - inset, rho * 0.3);
  const cx = rho / frame.cosHalf;
  const xTan = cx - R * frame.cosHalf;
  const yTan = R * Math.sin(frame.half);
  const ext = Math.min(sideExtend, rho * 0.25);
  const out: number[] = [-ext / frame.cosHalf, 0];
  for (let j = 0; j <= segments; j++) {
    const f = j / segments;
    const alpha = frame.half - 2 * frame.half * f;
    let x = cx - R * Math.cos(alpha);
    let y = -R * Math.sin(alpha);
    if (profile !== 0.5) {
      const chordX = xTan;
      const chordY = -yTan + 2 * yTan * f;
      if (profile < 0.5) {
        const t = profile / 0.5;
        x = chordX + (x - chordX) * t;
        y = chordY + (y - chordY) * t;
      } else {
        const t = (profile - 0.5) / 0.5;
        x += (x - chordX) * t;
        y += (y - chordY) * t;
      }
    }
    out.push(x, y);
  }
  return out;
}

// --- sweep ------------------------------------------------------------------

export function buildEdgeCutSolid(
  a: Vec3,
  b: Vec3,
  n1: Vec3,
  n2: Vec3,
  params: EdgeCutParams,
): RawSolid | null {
  const ab = sub(b, a);
  const L = len(ab);
  if (!(L > 1e-6)) return null;
  const d = unit(ab);
  const frame = sectionFrame(n1, n2, d);
  if (!frame) return null;

  const r = params.radius;
  if (!(r > 1e-6)) return null;

  const stations = stationList(L, r, params);
  if (stations.length < 2) return null;

  const segments = Math.max(1, Math.round(params.segments));
  const M = segments + 2;
  const verts: number[] = [];
  const rings: (number[] | number)[] = [];

  for (const s of stations) {
    const o = add(a, mul(d, s.t));
    if (s.rho <= 1e-9) {
      const id = verts.length / 3;
      verts.push(o[0], o[1], o[2]);
      rings.push(id);
      continue;
    }
    const pts = section2D(s.rho, frame, segments, params.profile, params.inset, params.extend);
    const ids: number[] = new Array(M);
    for (let k = 0; k < M; k++) {
      const x = pts[k * 2];
      const y = pts[k * 2 + 1];
      const p = add(o, add(mul(frame.ex, x), mul(frame.ey, y)));
      ids[k] = verts.length / 3;
      verts.push(p[0], p[1], p[2]);
    }
    rings.push(ids);
  }

  const tris: number[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i];
    const B = rings[i + 1];
    if (typeof A === 'number' && typeof B === 'number') continue;
    if (typeof A === 'number') {
      for (let k = 0; k < M; k++) tris.push(A, (B as number[])[k], (B as number[])[(k + 1) % M]);
    } else if (typeof B === 'number') {
      for (let k = 0; k < M; k++) tris.push((A as number[])[k], B, (A as number[])[(k + 1) % M]);
    } else {
      for (let k = 0; k < M; k++) {
        const k2 = (k + 1) % M;
        tris.push(A[k], B[k], B[k2]);
        tris.push(A[k], B[k2], A[k2]);
      }
    }
  }

  const first = rings[0];
  const last = rings[rings.length - 1];
  if (typeof first !== 'number') {
    for (let k = 1; k < M - 1; k++) tris.push(first[0], first[k], first[k + 1]);
  }
  if (typeof last !== 'number') {
    for (let k = 1; k < M - 1; k++) tris.push(last[0], last[k + 1], last[k]);
  }

  const solid: RawSolid = { positions: new Float32Array(verts), indices: new Uint32Array(tris) };
  orientOutward(solid);
  return solid;
}

interface Station {
  t: number;
  rho: number;
}

function stationList(L: number, r: number, p: EdgeCutParams): Station[] {
  let taperA = Math.max(0, Math.min(p.taperA, L * 0.45));
  let taperB = Math.max(0, Math.min(p.taperB, L * 0.45));
  if (taperA + taperB > L * 0.9) {
    const s = (L * 0.9) / (taperA + taperB);
    taperA *= s;
    taperB *= s;
  }
  const n = Math.max(1, Math.round(p.taperStations));
  const out: Station[] = [];

  if (taperA > 1e-9) {
    for (let k = 0; k <= n; k++) out.push({ t: (taperA * k) / n, rho: (r * k) / n });
  } else {
    out.push({ t: 0, rho: r });
  }

  const bodyStart = taperA;
  const bodyEnd = L - taperB;
  if (bodyEnd - bodyStart > 1e-9) {
    if (Math.abs(out[out.length - 1].t - bodyStart) > 1e-9) out.push({ t: bodyStart, rho: r });
    out.push({ t: bodyEnd, rho: r });
  }

  if (taperB > 1e-9) {
    for (let k = 1; k <= n; k++) out.push({ t: L - taperB + (taperB * k) / n, rho: r * (1 - k / n) });
  }

  // strictly increasing t, last station at L
  const clean: Station[] = [];
  for (const s of out) {
    if (clean.length && s.t - clean[clean.length - 1].t < 1e-9) {
      clean[clean.length - 1] = s;
    } else clean.push(s);
  }
  return clean;
}

/** Flip all windings when the closed mesh encloses negative volume. */
function orientOutward(solid: RawSolid): void {
  const p = solid.positions;
  const idx = solid.indices;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
      p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (v >= 0) return;
  for (let t = 0; t < idx.length; t += 3) {
    const tmp = idx[t + 1];
    idx[t + 1] = idx[t + 2];
    idx[t + 2] = tmp;
  }
}

// --- round corners ----------------------------------------------------------

/**
 * Rolling-ball volume at a vertex where exactly three convex faces meet.
 * `cut = box(q, 4r) − sphere(q, r)` restricted to the octant at the corner:
 * the box spans from the sphere centre q to the vertex in each face normal
 * direction, which is exactly the region where the sphere is the nearest part
 * of the eroded solid. Outside that octant the edge sweeps already cover it.
 *
 * `cornerSegments` is the 8..12 value from PLAN §4.4.5; the sphere is built
 * with twice that many circular segments, matching the M0 spike. Manifold
 * rounds the result to a multiple of four.
 */
export function buildCornerCut(
  wasm: ManifoldToplevel,
  v: Vec3,
  normals: Vec3[],
  radius: number,
  cornerSegments: number,
  inset: number,
  extend = 1e-3,
): Manifold | null {
  if (normals.length !== 3) return null;
  const delta = solve3(normals, [-radius, -radius, -radius]);
  if (!delta) return null;
  const q = add(v, delta);

  // the three outer planes sit `extend` outside the solid so the cut's faces
  // are not coplanar with the base faces
  const dV = normals.map((n) => dot(n, v) + extend);
  const dQ = normals.map((n) => dot(n, q));
  const pts: Vec3[] = [];
  for (let m = 0; m < 8; m++) {
    const d: Vec3 = [m & 1 ? dV[0] : dQ[0], m & 2 ? dV[1] : dQ[1], m & 4 ? dV[2] : dQ[2]];
    const p = solve3(normals, d);
    if (!p) return null;
    pts.push(p);
  }
  const box = wasm.Manifold.hull(pts);
  const R = Math.max(radius - inset, radius * 0.5);
  const segments = Math.max(8, Math.min(24, Math.round(cornerSegments) * 2));
  const sphere = wasm.Manifold.sphere(R, segments).translate(q);
  return box.subtract(sphere);
}

/** Cramer's rule for a 3×3 system; null when singular. */
export function solve3(rows: Vec3[], b: number[]): Vec3 | null {
  const [a, e, i] = rows[0];
  const [c, f, j] = rows[1];
  const [d, g, h] = rows[2];
  // matrix, row major:  | a e i |  | b0 |
  //                     | c f j |  | b1 |
  //                     | d g h |  | b2 |
  const det = a * (f * h - j * g) - e * (c * h - j * d) + i * (c * g - f * d);
  if (Math.abs(det) < 1e-9) return null;
  const x = a;
  const y = e;
  const z = i;
  const det0 = b[0] * (f * h - j * g) - y * (b[1] * h - j * b[2]) + z * (b[1] * g - f * b[2]);
  const det1 = x * (b[1] * h - j * b[2]) - b[0] * (c * h - j * d) + z * (c * b[2] - b[1] * d);
  const det2 = x * (f * b[2] - b[1] * g) - y * (c * b[2] - b[1] * d) + b[0] * (c * g - f * d);
  return [det0 / det, det1 / det, det2 / det];
}
