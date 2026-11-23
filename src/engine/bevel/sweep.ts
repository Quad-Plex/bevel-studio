/**
 * Solids for the rolling-ball bevel: edge sweeps and vertex blends.
 *
 * Edge sweep
 * ----------
 * For an edge with outward face normals n1, n2 the cross-section is the
 * sliver between the sharp edge and a circle of radius ρ tangent to both
 * faces. A convex edge removes it (circle centre inside the material); a
 * concave edge adds it (circle centre in the air wedge). The section is the
 * same polygon in both cases, built in the frame
 *
 *   ex = bisector of m1, m2 (points at the circle centre)
 *   ey = unit(m1 − m2)
 *
 * with m = −n for convex and m = +n for concave edges.
 *
 * Unlike a plain sliver, the section carries a *band*: its outline runs a
 * distance h = band·ρ past both face planes (away from the circle). The band
 * does three things:
 *   - the boolean never sees the sweep's side walls coplanar with the faces;
 *   - irregularities thinner than h next to the edge (sliver steps, 1 µm
 *     z-offsets between two caps, a face that is a few degrees off) are
 *     swept away instead of surviving as a ridge inside the fillet;
 *   - a concave fill overlaps the material it is fused to.
 *
 * The radius may vary linearly from A to B, fade to zero over `taperA/B`, and
 * the sweep may run `extendA/B` past an endpoint at the end radius. The
 * kernel trims extended ends with planes (miter and end-face planes), so a
 * sweep never needs to know its neighbours.
 *
 * Vertex blend
 * ------------
 * Where every feature edge at a vertex is beveled, the edge sweeps alone leave
 * the intersection of their cylinders — a sharp spike. The blend is the exact
 * rolling-ball result of the local cone: with planes n_i·x = d_i,
 *
 *   region = { d_i − r − m ≤ n_i·x ≤ d_i + ε }   (inside, within reach)
 *   K      = { n_i·x ≤ d_i − r }                 (ball centres)
 *   blend  = region ∩ ball(p, ρ) − (K ⊕ B_r)
 *
 * K ⊕ B_r is convex and is built as the hull of a sphere placed at each vertex
 * of K. It works for any number of faces, so irregular corners (a near-flat
 * crease, a split face) still get a round blend. Concave corners use the
 * mirrored construction and are added.
 */
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Vec3 } from '../types';

export interface RawSolid {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface SweepSpec {
  a: Vec3;
  b: Vec3;
  n1: Vec3;
  n2: Vec3;
  concave: boolean;
  radiusA: number;
  radiusB: number;
  /** linear fade to zero ending at A / B, mm (0 = none) */
  taperA: number;
  taperB: number;
  /** sweep overshoot past A / B at the end radius, mm */
  extendA: number;
  extendB: number;
  segments: number;
  /** 0 = chamfer chord, 0.5 = circle, 1 = boxy */
  profile: number;
  /** band thickness as a fraction of the local radius */
  band: number;
  /** pulls the arc in by this many mm (retry only) */
  inset: number;
}

// --- vector helpers ---------------------------------------------------------

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

// --- section ----------------------------------------------------------------

export interface SectionFrame {
  ex: Vec3;
  ey: Vec3;
  half: number;
  cosHalf: number;
  sinHalf: number;
}

export function sectionFrame(n1: Vec3, n2: Vec3, d: Vec3, concave: boolean): SectionFrame | null {
  const sign = concave ? 1 : -1;
  let m1 = mul(n1, sign);
  let m2 = mul(n2, sign);
  m1 = unit(sub(m1, mul(d, dot(m1, d))));
  m2 = unit(sub(m2, mul(d, dot(m2, d))));
  const c = dot(m1, m2);
  if (1 + c < 1e-4) return null; // folded back on itself
  const bis = add(m1, m2);
  if (len(bis) < 1e-6) return null;
  const ex = unit(bis);
  const diff = sub(m1, m2);
  if (len(diff) < 1e-9) return null; // coplanar faces: nothing to round
  const ey = unit(diff);
  const half = Math.acos(clamp(c, -1, 1)) / 2;
  const cosHalf = Math.cos(half);
  if (cosHalf < 1e-3) return null;
  return { ex, ey, half, cosHalf, sinHalf: Math.sin(half) };
}

/** Footprint of a radius-1 fillet on either face: tan(half). */
export function footprintFactor(n1: Vec3, n2: Vec3): number {
  const c = clamp(dot(n1, n2), -1, 1);
  return Math.tan(Math.acos(c) / 2);
}

/**
 * Section outline at radius ρ as (x, y) pairs in the frame: band corner,
 * band foot on face 1, the arc from face 1 to face 2, band foot on face 2.
 * Star-shaped from point 0, so caps can be fans.
 */
function section(
  rho: number,
  frame: SectionFrame,
  segments: number,
  profile: number,
  inset: number,
  band: number,
): number[] {
  const { cosHalf: ch, sinHalf: sh } = frame;
  const h = band * rho + Math.min(1e-3, 0.05 * rho);
  const out: number[] = [-h / ch, 0];
  const arc = arcPoints(rho, frame, segments, profile, inset);
  // band foot on face 1: arc start pushed out along −m1 = −(ch, sh)
  out.push(arc[0] - h * ch, arc[1] - h * sh);
  out.push(...arc);
  const last = arc.length - 2;
  out.push(arc[last] - h * ch, arc[last + 1] + h * sh);
  return out;
}

/** The fillet curve from face 1 to face 2 as (x, y) pairs in the frame. */
export function arcPoints(
  rho: number,
  frame: SectionFrame,
  segments: number,
  profile: number,
  inset: number,
): number[] {
  const { cosHalf: ch, sinHalf: sh, half } = frame;
  const R = Math.max(rho - inset, rho * 0.3);
  const cx = rho / ch;
  const arc: number[] = [];
  const xTan = cx - R * ch;
  const yTan = R * sh;
  for (let j = 0; j <= segments; j++) {
    const f = j / segments;
    const alpha = half - 2 * half * f;
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
    arc.push(x, y);
  }
  return arc;
}

// --- sweep ------------------------------------------------------------------

export function buildSweep(spec: SweepSpec): RawSolid | null {
  return buildChainSweep([spec]);
}

type Ring = Vec3[] | Vec3; // full section, or the apex of a fade

/**
 * Rings for one edge sweep, from its A end (or A extension) to its B end.
 * `joinA` / `joinB` drop the fade and extension at that end because a chain
 * neighbour continues there.
 */
function edgeRings(spec: SweepSpec, joinA: boolean, joinB: boolean): { rings: Ring[]; d: Vec3 } | null {
  const ab = sub(spec.b, spec.a);
  const L = len(ab);
  if (!(L > 1e-6)) return null;
  const d = unit(ab);
  const frame = sectionFrame(spec.n1, spec.n2, d, spec.concave);
  if (!frame) return null;
  const segments = Math.max(1, Math.round(spec.segments));

  let taperA = joinA ? 0 : Math.max(0, spec.taperA);
  let taperB = joinB ? 0 : Math.max(0, spec.taperB);
  if (taperA + taperB > 0.95 * L) {
    const s = (0.95 * L) / (taperA + taperB);
    taperA *= s;
    taperB *= s;
  }
  const extendA = joinA || taperA > 0 ? 0 : Math.max(0, spec.extendA);
  const extendB = joinB || taperB > 0 ? 0 : Math.max(0, spec.extendB);
  const rA = Math.max(0, spec.radiusA);
  const rB = Math.max(0, spec.radiusB);

  const rho = (t: number): number => {
    const base = rA + (rB - rA) * clamp(t / L, 0, 1);
    let fade = 1;
    if (taperA > 0 && t < taperA) fade = Math.min(fade, Math.max(0, t) / taperA);
    if (taperB > 0 && t > L - taperB) fade = Math.min(fade, Math.max(0, L - t) / taperB);
    return base * fade;
  };

  const ts = [-extendA, 0, taperA, L - taperB, L, L + extendB].sort((x, y) => x - y);
  const stations: number[] = [];
  for (const t of ts) {
    if (stations.length === 0 || t - stations[stations.length - 1] > 1e-7) stations.push(t);
  }
  if (stations.length < 2) return null;

  const M = segments + 4;
  const rings: Ring[] = [];
  for (const t of stations) {
    const o: Vec3 = [spec.a[0] + d[0] * t, spec.a[1] + d[1] * t, spec.a[2] + d[2] * t];
    const r = rho(t);
    if (r <= 1e-7) {
      rings.push(o);
      continue;
    }
    const pts = section(r, frame, segments, spec.profile, spec.inset, spec.band);
    const ring: Vec3[] = new Array(M);
    for (let k = 0; k < M; k++) {
      const x = pts[k * 2];
      const y = pts[k * 2 + 1];
      ring[k] = [
        o[0] + frame.ex[0] * x + frame.ey[0] * y,
        o[1] + frame.ex[1] * x + frame.ey[1] * y,
        o[2] + frame.ex[2] * x + frame.ey[2] * y,
      ];
    }
    rings.push(ring);
  }
  return { rings, d };
}

const isFull = (ring: Ring): ring is Vec3[] => Array.isArray(ring[0]);

/**
 * One closed sweep along a chain of edges. Consecutive specs must share their
 * joint point (spec[i].b === spec[i + 1].a), carry matching n1/n2 sides and
 * the same segment count. At each joint the two neighbouring sections are
 * projected onto the miter (bisector) plane along their own edge directions
 * and averaged, so the chain is one seamless solid instead of a row of
 * separately trimmed pieces.
 */
export function buildChainSweep(specs: SweepSpec[]): RawSolid | null {
  if (specs.length === 0) return null;
  const parts: { rings: Ring[]; d: Vec3 }[] = [];
  for (let i = 0; i < specs.length; i++) {
    const part = edgeRings(specs[i], i > 0, i < specs.length - 1);
    if (!part) return null;
    parts.push(part);
  }

  const rings: Ring[] = [];
  for (let i = 0; i < parts.length; i++) {
    const own = parts[i].rings;
    if (i === 0) {
      rings.push(...own);
      continue;
    }
    // merge the previous end ring with this start ring on the miter plane
    const prev = rings.pop()!;
    const next = own[0];
    if (!isFull(prev) || !isFull(next) || prev.length !== next.length) return null;
    const joint = specs[i].a;
    const d0 = parts[i - 1].d;
    const d1 = parts[i].d;
    const nb = unit(add(d0, d1));
    const c0 = dot(d0, nb);
    const c1 = dot(d1, nb);
    if (c0 < 0.3 || c1 < 0.3) return null;
    const merged: Vec3[] = prev.map((p0, k) => {
      const p1 = next[k];
      const q0 = add(p0, mul(d0, dot(sub(joint, p0), nb) / c0));
      const q1 = add(p1, mul(d1, dot(sub(joint, p1), nb) / c1));
      return mul(add(q0, q1), 0.5);
    });
    rings.push(merged, ...own.slice(1));
  }
  if (!rings.some(isFull)) return null;

  const verts: number[] = [];
  const ids: (number[] | number)[] = [];
  for (const ring of rings) {
    if (isFull(ring)) {
      const list: number[] = [];
      for (const p of ring) {
        list.push(verts.length / 3);
        verts.push(p[0], p[1], p[2]);
      }
      ids.push(list);
    } else {
      ids.push(verts.length / 3);
      verts.push(ring[0], ring[1], ring[2]);
    }
  }
  const M = (ids.find((x) => typeof x !== 'number') as number[]).length;

  const tris: number[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const A = ids[i];
    const B = ids[i + 1];
    if (typeof A === 'number' && typeof B === 'number') continue;
    if (typeof A === 'number') {
      const b = B as number[];
      for (let k = 0; k < M; k++) tris.push(A, b[k], b[(k + 1) % M]);
    } else if (typeof B === 'number') {
      for (let k = 0; k < M; k++) tris.push(A[k], B, A[(k + 1) % M]);
    } else {
      for (let k = 0; k < M; k++) {
        const k2 = (k + 1) % M;
        tris.push(A[k], B[k], B[k2]);
        tris.push(A[k], B[k2], A[k2]);
      }
    }
  }
  const first = ids[0];
  const last = ids[ids.length - 1];
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

export function orientOutward(solid: RawSolid): void {
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

// --- vertex blend -----------------------------------------------------------

export interface Plane {
  /** unit outward normal */
  n: Vec3;
  /** n·x = d on the plane */
  d: number;
}

export function vertsOf(m: Manifold): Vec3[] {
  const mesh = m.getMesh();
  const out: Vec3[] = [];
  try {
    const np = mesh.numProp;
    for (let i = 0; i < mesh.vertProperties.length; i += np) {
      out.push([mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]]);
    }
  } finally {
    (mesh as unknown as { delete?: () => void }).delete?.();
  }
  return out;
}

/** Keep { n·x ≤ c }. */
export function keepBelow(m: Manifold, n: Vec3, c: number): Manifold {
  return m.trimByPlane([-n[0], -n[1], -n[2]], -c);
}

/** Keep { n·x ≥ c }. */
export function keepAbove(m: Manifold, n: Vec3, c: number): Manifold {
  return m.trimByPlane(n, c);
}

export interface BlendResult {
  solid: Manifold;
  /** distance from the node point to the nearest ball centre */
  apexDistance: number;
}

/**
 * Rolling-ball blend of a corner formed by `planes` (≥ 3, spanning 3-D) near
 * point `p`. Convex corners return material to subtract; concave corners
 * return material to add.
 */
export function buildVertexBlend(
  wasm: ManifoldToplevel,
  planes: Plane[],
  p: Vec3,
  radius: number,
  concave: boolean,
  sphereSegments: number,
  inset = 0,
): BlendResult | null {
  if (planes.length < 3 || !(radius > 1e-6)) return null;
  const r = radius;
  const eps = Math.min(1e-3, 0.02 * r);
  const margin = 0.05 * r;
  const sign = concave ? -1 : 1; // flip planes so the corner is always "convex"
  const flipped: Plane[] = planes.map((plane) => ({ n: mul(plane.n, sign), d: sign * plane.d }));

  // K: ball centres. Its vertices are enumerated directly (a handful of
  // planes), which is far cheaper than trimming a Manifold cube.
  const H = 12 * r;
  const kFar = polytopeVertices(
    flipped.map((plane) => ({ n: plane.n, d: plane.d - r })),
    p,
    H,
  );
  if (kFar.length === 0) return null;
  let apexDistance = Infinity;
  for (const v of kFar) apexDistance = Math.min(apexDistance, len(sub(v, p)));
  // Only the bounding cube produced vertices: the cone is not pointed near p.
  if (!(apexDistance < H * 0.5)) return null;

  // Every region point within r of K has its nearest centre inside
  // ball(p, reach + r), so K clipped to that cube gives the exact K ⊕ B there.
  const reach = apexDistance + 2.5 * r;
  const kv = polytopeVertices(
    flipped.map((plane) => ({ n: plane.n, d: plane.d - r })),
    p,
    reach + 1.5 * r,
  );
  if (kv.length === 0) return null;

  const R = Math.max(r - inset, r * 0.5);
  const segs = Math.max(12, Math.min(32, Math.round(sphereSegments)));
  const sv = spherePoints(wasm, R, segs);
  const points: Vec3[] = [];
  for (const v of kv) {
    for (const s of sv) points.push([v[0] + s[0], v[1] + s[1], v[2] + s[2]]);
  }
  if (points.length < 4) return null;
  const kb = wasm.Manifold.hull(points);

  // Region within reach of every face: slabs ∩ cube, again by enumeration.
  const slabs: Plane[] = [];
  for (const plane of flipped) {
    slabs.push({ n: plane.n, d: plane.d + eps });
    slabs.push({ n: mul(plane.n, -1), d: -(plane.d - r - margin) });
  }
  const rv = polytopeVertices(slabs, p, reach);
  if (rv.length < 4) return null;
  const region = wasm.Manifold.hull(rv);
  return { solid: region.subtract(kb), apexDistance };
}

const sphereCache = new Map<string, Vec3[]>();

function spherePoints(wasm: ManifoldToplevel, radius: number, segments: number): Vec3[] {
  const key = `${radius}|${segments}`;
  let points = sphereCache.get(key);
  if (!points) {
    points = vertsOf(wasm.Manifold.sphere(radius, segments));
    if (sphereCache.size > 64) sphereCache.clear();
    sphereCache.set(key, points);
  }
  return points;
}

/**
 * Vertices of { n_i·x ≤ d_i } ∩ cube(center, half), by testing every triple of
 * bounding planes. Meant for the few planes of one corner.
 */
export function polytopeVertices(planes: Plane[], center: Vec3, half: number): Vec3[] {
  const all: Plane[] = [...planes];
  for (let axis = 0; axis < 3; axis++) {
    const n: Vec3 = [0, 0, 0];
    n[axis] = 1;
    all.push({ n, d: center[axis] + half });
    all.push({ n: mul(n, -1), d: -(center[axis] - half) });
  }
  const tol = 1e-7 * Math.max(1, half);
  const out: Vec3[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      for (let k = j + 1; k < all.length; k++) {
        const x = solve3([all[i].n, all[j].n, all[k].n], [all[i].d, all[j].d, all[k].d]);
        if (!x) continue;
        let inside = true;
        for (const plane of all) {
          if (dot(plane.n, x) > plane.d + tol) {
            inside = false;
            break;
          }
        }
        if (!inside) continue;
        if (out.some((y) => Math.abs(y[0] - x[0]) + Math.abs(y[1] - x[1]) + Math.abs(y[2] - x[2]) < tol)) continue;
        out.push(x);
      }
    }
  }
  return out;
}

/** Cramer's rule for a 3×3 system; null when (nearly) singular. */
export function solve3(rows: Vec3[], b: number[]): Vec3 | null {
  const [a0, a1, a2] = rows;
  const det = dot(a0, cross(a1, a2));
  if (Math.abs(det) < 1e-9) return null;
  const c12 = cross(a1, a2);
  const c20 = cross(a2, a0);
  const c01 = cross(a0, a1);
  return [
    (b[0] * c12[0] + b[1] * c20[0] + b[2] * c01[0]) / det,
    (b[0] * c12[1] + b[1] * c20[1] + b[2] * c01[1]) / det,
    (b[0] * c12[2] + b[1] * c20[2] + b[2] * c01[2]) / det,
  ];
}
