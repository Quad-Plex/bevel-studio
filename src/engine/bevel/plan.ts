/**
 * Bevel planning: turn a selection of edge ids into sweeps, trim planes and
 * vertex blends. Pure geometry; no Manifold calls happen here, so the plan is
 * cheap, deterministic and testable on its own.
 *
 * Model
 * -----
 * Nodes. Vertices joined by a micro edge (a sharp edge shorter than μ, the
 * irregularity scale tied to the requested width) form one node. A 0.05 mm
 * sliver step or a 1 µm offset between two caps therefore reads as a single
 * corner, and the edges on either side of it join as if it were not there.
 *
 * Features. At a node, every non-micro edge that is selected or sharper than
 * FEATURE_DEG is a feature leaving the node. Shallower unselected creases are
 * tessellation of a curved surface and are ignored.
 *
 * Widths. Each selected edge gets a geometric limit from short ray casts
 * along its two faces (wall thickness, the gap to the next wall); triangle
 * shapes play no part. Node widths are the minimum of the incident edges and
 * are then made Lipschitz along the selection graph, so a clamp ramps in and
 * out instead of stepping. Each sweep interpolates its two node widths.
 *
 * Ends. A sweep end at a node is one of
 *   - joined: it runs past the node and is trimmed by the miter (bisector)
 *     plane against every other selected edge of the same kind there, and by
 *     the planes of other features' faces (an end face, a reflex wall);
 *   - faded: the selected chain stops in the middle of a crease (the crease
 *     continues unselected) or the crease itself ends; the radius fades to 0.
 *
 * Blends. A node whose features are all selected and of one kind, and whose
 * faces span three or more directions, gets a rolling-ball vertex blend.
 * This covers cube corners and also irregular ones (an extra shallow face, a
 * split face) that a "three edges, three normals" rule rejects.
 */
import type { BevelParams, MeshData, Vec3 } from '../types';
import { EDGE_ABSENT, EDGE_THIRD, FLAT_DEGREES, type MeshTopology } from './topology';
import { raycast, type TriangleBvh } from './bvh';
import {
  add,
  arcPoints,
  cross,
  dot,
  footprintFactor,
  len,
  mul,
  sectionFrame,
  sub,
  unit,
  type Plane,
} from './sweep';

/** Unselected creases below this are smooth surface, not features. */
export const FEATURE_DEG = 20;
/** Face normals closer than this belong to the same surface at a node. */
const SAME_SURFACE_DEG = 20;
/** Band thickness as a fraction of the radius (see sweep.ts). */
export const BAND = 0.12;
/** A clamp may ramp by this many mm of radius per mm along a chain. */
const RAMP = 0.5;
const COS_CONTINUE = Math.cos((35 * Math.PI) / 180);

export interface ClipPlane {
  /** keep n·x ≤ c */
  n: Vec3;
  c: number;
}

export interface PlannedSweep {
  edge: number;
  index: number;
  concave: boolean;
  a: Vec3;
  b: Vec3;
  n1: Vec3;
  n2: Vec3;
  radiusA: number;
  radiusB: number;
  taperA: number;
  taperB: number;
  extendA: number;
  extendB: number;
  /** trim planes applied to the A / B end */
  clipsA: ClipPlane[];
  clipsB: ClipPlane[];
}

export interface PlannedBlend {
  node: number;
  point: Vec3;
  planes: Plane[];
  radius: number;
  concave: boolean;
}

export interface BevelPlan {
  sweeps: PlannedSweep[];
  blends: PlannedBlend[];
  appliedWidth: Float32Array;
  endWidths: Float32Array;
  endTapers: Uint8Array;
  unusable: number;
  micro: number;
  narrow: number;
  mixedNodes: number;
  /** irregularity scale used for this request */
  microLength: number;
}

interface Feature {
  edge: number;
  /** vertex of the edge inside the node */
  vertex: number;
  dir: Vec3;
  selected: boolean;
  concave: boolean;
  /** has a sweep (selected, usable, not micro, not too narrow) */
  job: boolean;
}

export function microLengthFor(width: number): number {
  return Math.min(0.1, Math.max(0.002, 0.2 * width));
}

export function planBevel(
  mesh: MeshData,
  topo: MeshTopology,
  edgeIds: Uint32Array,
  params: BevelParams,
  requested: number,
  bvh: TriangleBvh | null,
  taperMode: 'auto' | 'none' = 'auto',
  maxWidth?: Float32Array,
): BevelPlan {
  const pos = mesh.positions;
  const vertexCount = pos.length / 3;
  const selectionCount = edgeIds.length;
  const appliedWidth = new Float32Array(selectionCount);
  const endWidths = new Float32Array(selectionCount * 2);
  const endTapers = new Uint8Array(selectionCount * 2);
  const mu = microLengthFor(requested);

  const P = (v: number): Vec3 => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  const edgeNormal = (e: number, side: 0 | 1): Vec3 => [
    topo.normals[e * 6 + side * 3],
    topo.normals[e * 6 + side * 3 + 1],
    topo.normals[e * 6 + side * 3 + 2],
  ];
  const isSharp = (e: number) => topo.convex[e] === 0 || topo.convex[e] === 1;

  // --- selection --------------------------------------------------------------
  let unusable = 0;
  let micro = 0;
  let narrow = 0;
  const selectedIndex = new Map<number, number>();
  for (let i = 0; i < selectionCount; i++) {
    const e = edgeIds[i];
    if (!Number.isInteger(e) || e < 0 || e >= topo.edgeCount || !isSharp(e)) {
      unusable++;
      continue;
    }
    if (!selectedIndex.has(e)) selectedIndex.set(e, i);
  }

  // --- nodes: union vertices across micro sharp edges -------------------------
  const parent = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) parent[v] = v;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.length[e] >= mu) continue;
    if (topo.dihedral[e] < FLAT_DEGREES && !selectedIndex.has(e)) continue;
    const ra = find(topo.v[e * 2]);
    const rb = find(topo.v[e * 2 + 1]);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  const isMicro = (e: number) => find(topo.v[e * 2]) === find(topo.v[e * 2 + 1]);

  // --- width limits ---------------------------------------------------------
  const limit = new Map<number, number>();
  for (const e of selectedIndex.keys()) {
    if (isMicro(e)) continue;
    let r = requested;
    if (params.clampOverlap && bvh) r = Math.min(r, geometricLimit(bvh, mesh, topo, e, requested));
    if (maxWidth && e < maxWidth.length && Number.isFinite(maxWidth[e]) && maxWidth[e] >= 0) {
      r = Math.min(r, 0.98 * maxWidth[e]);
    }
    limit.set(e, r);
  }

  // Node widths, then a Lipschitz pass along the selection graph.
  const nodeWidth = new Map<number, number>();
  const adjacency = new Map<number, { node: number; length: number }[]>();
  for (const [e, r] of limit) {
    const na = find(topo.v[e * 2]);
    const nb = find(topo.v[e * 2 + 1]);
    nodeWidth.set(na, Math.min(nodeWidth.get(na) ?? Infinity, r));
    nodeWidth.set(nb, Math.min(nodeWidth.get(nb) ?? Infinity, r));
    const L = topo.length[e];
    (adjacency.get(na) ?? adjacency.set(na, []).get(na)!).push({ node: nb, length: L });
    (adjacency.get(nb) ?? adjacency.set(nb, []).get(nb)!).push({ node: na, length: L });
  }
  {
    // Dijkstra-style relaxation from the narrowest nodes outwards.
    const order = [...nodeWidth.keys()].sort((x, y) => nodeWidth.get(x)! - nodeWidth.get(y)! || x - y);
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const node of order) {
        const w = nodeWidth.get(node)!;
        for (const { node: other, length } of adjacency.get(node) ?? []) {
          const bound = w + RAMP * length;
          if (bound < nodeWidth.get(other)! - 1e-9) {
            nodeWidth.set(other, bound);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  }

  // --- features per node ------------------------------------------------------
  const features = new Map<number, Feature[]>();
  const addFeature = (node: number, f: Feature) => {
    const list = features.get(node);
    if (list) list.push(f);
    else features.set(node, [f]);
  };
  const jobEdges = new Set<number>();
  for (const [e] of limit) {
    const na = find(topo.v[e * 2]);
    const nb = find(topo.v[e * 2 + 1]);
    const w = Math.min(nodeWidth.get(na)!, nodeWidth.get(nb)!);
    if (!(w > requested * 0.01)) {
      narrow++;
      continue;
    }
    jobEdges.add(e);
  }
  for (const e of selectedIndex.keys()) if (isMicro(e)) micro++;

  for (let e = 0; e < topo.edgeCount; e++) {
    if (!isSharp(e) || isMicro(e)) continue;
    const selected = selectedIndex.has(e);
    if (!selected && topo.dihedral[e] < FEATURE_DEG) continue;
    const a = topo.v[e * 2];
    const b = topo.v[e * 2 + 1];
    const da = unit(sub(P(b), P(a)));
    const concave = topo.convex[e] === 0;
    const job = jobEdges.has(e);
    addFeature(find(a), { edge: e, vertex: a, dir: da, selected, concave, job });
    addFeature(find(b), { edge: e, vertex: b, dir: mul(da, -1), selected, concave, job });
  }

  // Node points: centroid of the member vertices that carry features.
  const nodePoint = new Map<number, Vec3>();
  for (const [node, list] of features) {
    const seen = new Set<number>();
    let s: Vec3 = [0, 0, 0];
    for (const f of list) {
      if (seen.has(f.vertex)) continue;
      seen.add(f.vertex);
      s = add(s, P(f.vertex));
    }
    nodePoint.set(node, mul(s, 1 / seen.size));
  }

  const facePlane = (t: number): Plane => {
    const n: Vec3 = [topo.faceNormals[t * 3], topo.faceNormals[t * 3 + 1], topo.faceNormals[t * 3 + 2]];
    return { n, d: dot(n, P(mesh.indices[t * 3])) };
  };
  const trisOf = (e: number): number[] => {
    const out: number[] = [];
    for (let s = 0; s < 2; s++) {
      const t = topo.tris[e * 2 + s];
      if (t !== EDGE_ABSENT && t !== EDGE_THIRD) out.push(t);
    }
    return out;
  };
  const cosSame = Math.cos((SAME_SURFACE_DEG * Math.PI) / 180);

  // --- blends -----------------------------------------------------------------
  const blendNodes = new Set<number>();
  const blends: PlannedBlend[] = [];
  let mixedNodes = 0;
  for (const [node, list] of features) {
    const active = list.filter((f) => f.job);
    if (active.length === 0) continue;
    const kinds = new Set(active.map((f) => f.concave));
    if (kinds.size > 1) mixedNodes++;
    if (active.length < 2 || kinds.size > 1) continue;
    if (list.some((f) => !f.job)) continue; // an unselected or skipped feature stays sharp
    // plane groups from the faces of the beveled edges
    const groups: { plane: Plane; area: number }[] = [];
    for (const f of active) {
      for (const t of trisOf(f.edge)) {
        const plane = facePlane(t);
        const area = triangleArea(mesh, t);
        const g = groups.find((x) => dot(x.plane.n, plane.n) > cosSame);
        if (!g) groups.push({ plane, area });
        else if (area > g.area) {
          g.plane = plane;
          g.area = area;
        }
      }
    }
    if (groups.length < 3 || !spans(groups.map((g) => g.plane.n))) continue;
    const radius = nodeWidth.get(node)!;
    blendNodes.add(node);
    blends.push({
      node,
      point: nodePoint.get(node)!,
      planes: groups.map((g) => g.plane),
      radius,
      concave: active[0].concave,
    });
  }

  // --- sweeps -----------------------------------------------------------------
  const sweeps: PlannedSweep[] = [];
  const eps = 0;
  // Two sweeps trimmed by the same miter plane meet exactly; any overlap
  // leaves a µm sliver that the 1e-3 weld folds into a self-intersection.
  const miter = 0;
  const arcSegments = Math.max(1, Math.min(12, Math.round(params.segments) || 1));
  const arcProfile = Number.isFinite(params.profile) ? Math.max(0, Math.min(1, params.profile)) : 0.5;

  /**
   * Convex rim sweeps along the arc an inside fillet leaves on a cap face,
   * joined to the two beveled rims on either side. The rims are re-targeted to
   * start at the arc's ends. Returns null (keep the mitre) when the corner is
   * not the simple "fillet between two beveled rims" case.
   */
  const rimAroundFill = (
    fill: PlannedSweep,
    end: 0 | 1,
    rims: Feature[],
    r: number,
  ): PlannedSweep[] | null => {
    const dFill = unit(sub(fill.b, fill.a));
    const frame = sectionFrame(fill.n1, fill.n2, dFill, true);
    if (!frame) return null;
    let cap: Plane | null = null;
    for (const f of rims) {
      for (const t of trisOf(f.edge)) {
        const plane = facePlane(t);
        if (dot(plane.n, fill.n1) > cosSame || dot(plane.n, fill.n2) > cosSame) continue;
        if (!cap) cap = plane;
        else if (dot(cap.n, plane.n) < cosSame) return null;
      }
    }
    if (!cap) return null;
    const nd = dot(cap.n, dFill);
    if (Math.abs(nd) < 0.3) return null;
    const toCap = (x: Vec3): Vec3 => add(x, mul(dFill, (cap!.d - dot(cap!.n, x)) / nd));
    const endPoint = end === 0 ? fill.a : fill.b;
    const rho = end === 0 ? fill.radiusA : fill.radiusB;
    if (!(rho > 0) || !(r > 0)) return null;
    const o = toCap(endPoint);
    const local = arcPoints(rho, frame, arcSegments, arcProfile, 0);
    const q: Vec3[] = [];
    for (let j = 0; j < local.length; j += 2) {
      q.push(toCap(add(o, add(mul(frame.ex, local[j]), mul(frame.ey, local[j + 1])))));
    }
    const center = toCap(add(o, mul(frame.ex, rho / frame.cosHalf)));
    const rimOn = (n: Vec3) =>
      rims.find((f) => trisOf(f.edge).some((t) => dot(facePlane(t).n, n) > cosSame));
    const rimStart = rimOn(fill.n1);
    const rimEnd = rimOn(fill.n2);
    if (!rimStart || !rimEnd || rimStart.edge === rimEnd.edge) return null;
    // each rim must be long enough to give up the stretch the fillet covers
    for (const [rim, point] of [
      [rimStart, q[0]],
      [rimEnd, q[q.length - 1]],
    ] as const) {
      const s = sweepByEdge.get(rim.edge)!;
      const far = rim.vertex === topo.v[rim.edge * 2] ? s.b : s.a;
      const near = rim.vertex === topo.v[rim.edge * 2] ? s.a : s.b;
      if (len(sub(far, point)) < 0.25 * len(sub(far, near))) return null;
      if (dot(sub(point, near), rim.dir) < -1e-6) return null;
    }

    const out: PlannedSweep[] = [];
    const last = q.length - 1;
    for (let j = 0; j < last; j++) {
      const a = q[j];
      const b = q[j + 1];
      const L = len(sub(b, a));
      if (!(L > 1e-6)) return null;
      const dir = mul(sub(b, a), 1 / L);
      const mid = mul(add(a, b), 0.5);
      let m = unit(cross(dFill, dir));
      if (dot(m, sub(center, mid)) < 0) m = mul(m, -1);
      const k = footprintFactor(cap.n, m);
      const ext = 2.5 * (k + BAND + 1) * r + eps;
      const prev = j === 0 ? rimStart.dir : unit(sub(q[j - 1], a));
      const next = j === last - 1 ? rimEnd.dir : unit(sub(q[j + 2], b));
      const nA = unit(sub(prev, dir));
      const nB = unit(sub(next, mul(dir, -1)));
      out.push({
        edge: fill.edge,
        index: fill.index,
        concave: false,
        a,
        b,
        n1: cap.n,
        n2: m,
        radiusA: r,
        radiusB: r,
        taperA: 0,
        taperB: 0,
        extendA: ext,
        extendB: ext,
        clipsA: [{ n: nA, c: dot(nA, a) + miter }],
        clipsB: [{ n: nB, c: dot(nB, b) + miter }],
      });
    }

    for (const [rim, point, arcDir] of [
      [rimStart, q[0], unit(sub(q[1], q[0]))],
      [rimEnd, q[last], unit(sub(q[last - 1], q[last]))],
    ] as const) {
      const s = sweepByEdge.get(rim.edge)!;
      const atA = rim.vertex === topo.v[rim.edge * 2];
      const n = unit(sub(arcDir, rim.dir));
      const k = footprintFactor(s.n1, s.n2);
      const clip = [{ n, c: dot(n, point) + miter }];
      const ext = 2.5 * (k + BAND + 1) * r + eps;
      if (atA) {
        s.a = point;
        s.clipsA = clip;
        s.taperA = 0;
        s.extendA = ext;
      } else {
        s.b = point;
        s.clipsB = clip;
        s.taperB = 0;
        s.extendB = ext;
      }
    }
    return out;
  };
  for (const e of [...jobEdges].sort((x, y) => x - y)) {
    const index = selectedIndex.get(e)!;
    const av = topo.v[e * 2];
    const bv = topo.v[e * 2 + 1];
    const na = find(av);
    const nb = find(bv);
    const concave = topo.convex[e] === 0;
    const n1 = edgeNormal(e, 0);
    const n2 = edgeNormal(e, 1);
    const a = P(av);
    const b = P(bv);
    const L = len(sub(b, a));
    const rA = nodeWidth.get(na)!;
    const rB = nodeWidth.get(nb)!;
    const rMax = Math.max(rA, rB);
    const k = footprintFactor(n1, n2);
    const mid = mul(add(a, b), 0.5);
    const ownTris = new Set(trisOf(e));

    const sweep: PlannedSweep = {
      edge: e,
      index,
      concave,
      a,
      b,
      n1,
      n2,
      radiusA: rA,
      radiusB: rB,
      taperA: 0,
      taperB: 0,
      extendA: 0,
      extendB: 0,
      clipsA: [],
      clipsB: [],
    };

    for (const end of [0, 1] as const) {
      const node = end === 0 ? na : nb;
      const r = end === 0 ? rA : rB;
      const point = nodePoint.get(node) ?? (end === 0 ? a : b);
      const dirOut = unit(end === 0 ? sub(b, a) : sub(a, b));
      const list = features.get(node) ?? [];
      const siblings = list.filter(
        (f) => f.edge !== e && f.job && f.concave === concave && dot(f.dir, dirOut) < Math.cos((5 * Math.PI) / 180),
      );
      const others = list.filter((f) => f.edge !== e && !siblings.includes(f));
      const clips: ClipPlane[] = [];

      for (const f of siblings) {
        const n = unit(sub(f.dir, dirOut));
        clips.push({ n, c: dot(n, point) + miter });
      }

      // A face that a sibling rim runs along is not an end face for this
      // sweep: the two meet at their miter. Compared by surface normal, not by
      // triangle id, because one flat face is usually several triangles.
      const siblingNormals: Vec3[] = [];
      for (const f of siblings) {
        siblingNormals.push(edgeNormal(f.edge, 0), edgeNormal(f.edge, 1));
      }
      const seen: Vec3[] = [];
      for (const f of others) {
        for (const t of trisOf(f.edge)) {
          if (ownTris.has(t)) continue;
          const plane = facePlane(t);
          if (dot(plane.n, n1) > cosSame || dot(plane.n, n2) > cosSame) continue;
          if (siblingNormals.some((n) => dot(plane.n, n) > cosSame)) continue;
          if (Math.abs(dot(plane.n, dirOut)) < Math.sin((10 * Math.PI) / 180)) continue;
          if (seen.some((s) => dot(s, plane.n) > 0.9999)) continue;
          seen.push(plane.n);
          const side = dot(plane.n, mid) - plane.d;
          const margin = concave ? -eps : eps;
          if (side <= 0) clips.push({ n: plane.n, c: plane.d + margin });
          else clips.push({ n: mul(plane.n, -1), c: -plane.d + margin });
        }
      }

      // The crease goes on, unselected: fade out inside this edge.
      const continues = list.some(
        (f) =>
          f.edge !== e &&
          !f.job &&
          f.concave === concave &&
          dot(f.dir, dirOut) < -COS_CONTINUE,
      );
      const blended = blendNodes.has(node);
      let taper = false;
      if (taperMode === 'none') taper = false;
      else if (blended) taper = false;
      else if (continues) taper = true;
      else if (clips.length === 0) taper = true;

      if (taper) {
        const length = Math.min(rMax, 0.45 * L);
        if (end === 0) sweep.taperA = length;
        else sweep.taperB = length;
        endTapers[index * 2 + end] = 1;
        endWidths[index * 2 + end] = 0;
      } else {
        const extend = clips.length > 0 ? 2.5 * (k + BAND + 1) * r + eps : 0;
        if (end === 0) sweep.extendA = extend;
        else sweep.extendB = extend;
        (end === 0 ? sweep.clipsA : sweep.clipsB).push(...clips);
        endWidths[index * 2 + end] = r;
      }
    }

    appliedWidth[index] = Math.min(rA, rB);
    sweeps.push(sweep);
  }

  // --- rims around inside fillets ---------------------------------------------
  // An inside fillet that ends on a cap face whose rim edges are beveled too
  // would stand as a sharp post between the two rounded rims. The rim instead
  // follows the fillet's arc on that face (close-then-open), so it wraps
  // around the inside corner.
  const sweepByEdge = new Map<number, PlannedSweep>();
  for (const s of sweeps) sweepByEdge.set(s.edge, s);
  const arcSweeps: PlannedSweep[] = [];
  const handledMixed = new Set<number>();
  for (const fill of sweeps) {
    if (!fill.concave) continue;
    for (const end of [0, 1] as const) {
      if ((end === 0 ? fill.taperA : fill.taperB) > 0) continue;
      const node = find(topo.v[fill.edge * 2 + end]);
      const list = features.get(node) ?? [];
      const rims = list.filter((f) => f.job && !f.concave && sweepByEdge.has(f.edge));
      if (rims.length === 0 || list.some((f) => f.job && f.concave && f.edge !== fill.edge)) continue;
      const chain = rimAroundFill(fill, end, rims, nodeWidth.get(node)!);
      if (chain) {
        arcSweeps.push(...chain);
        handledMixed.add(node);
      }
    }
  }
  sweeps.push(...arcSweeps);

  // Selected duplicates and micro edges report the width of their chain.
  for (let i = 0; i < selectionCount; i++) {
    const e = edgeIds[i];
    if (appliedWidth[i] > 0 || !selectedIndex.has(e)) continue;
    const first = selectedIndex.get(e)!;
    if (first !== i) appliedWidth[i] = appliedWidth[first];
    else if (isMicro(e)) appliedWidth[i] = nodeWidth.get(find(topo.v[e * 2])) ?? 0;
  }

  mixedNodes = Math.max(0, mixedNodes - handledMixed.size);

  return {
    sweeps,
    blends,
    appliedWidth,
    endWidths,
    endTapers,
    unusable,
    micro,
    narrow,
    mixedNodes,
    microLength: mu,
  };
}

function triangleArea(mesh: MeshData, t: number): number {
  const p = mesh.positions;
  const i = mesh.indices;
  const A: Vec3 = [p[i[t * 3] * 3], p[i[t * 3] * 3 + 1], p[i[t * 3] * 3 + 2]];
  const B: Vec3 = [p[i[t * 3 + 1] * 3], p[i[t * 3 + 1] * 3 + 1], p[i[t * 3 + 1] * 3 + 2]];
  const C: Vec3 = [p[i[t * 3 + 2] * 3], p[i[t * 3 + 2] * 3 + 1], p[i[t * 3 + 2] * 3 + 2]];
  return len(cross(sub(B, A), sub(C, A))) / 2;
}

function spans(normals: Vec3[]): boolean {
  for (let i = 0; i < normals.length; i++) {
    for (let j = i + 1; j < normals.length; j++) {
      for (let k = j + 1; k < normals.length; k++) {
        if (Math.abs(dot(normals[i], cross(normals[j], normals[k]))) > 0.05) return true;
      }
    }
  }
  return false;
}

/**
 * Largest radius edge `e` can carry without its fillet (plus band) running
 * more than halfway across either adjacent face or wall. Rays are cast just
 * below and just above each face, perpendicular to the edge, at three
 * stations along it.
 */
export function geometricLimit(
  bvh: TriangleBvh,
  mesh: MeshData,
  topo: MeshTopology,
  e: number,
  requested: number,
): number {
  const p = mesh.positions;
  const av = topo.v[e * 2];
  const bv = topo.v[e * 2 + 1];
  const a: Vec3 = [p[av * 3], p[av * 3 + 1], p[av * 3 + 2]];
  const b: Vec3 = [p[bv * 3], p[bv * 3 + 1], p[bv * 3 + 2]];
  const L = len(sub(b, a));
  if (!(L > 0)) return 0;
  const d = mul(sub(b, a), 1 / L);
  const n1: Vec3 = [topo.normals[e * 6], topo.normals[e * 6 + 1], topo.normals[e * 6 + 2]];
  const n2: Vec3 = [topo.normals[e * 6 + 3], topo.normals[e * 6 + 4], topo.normals[e * 6 + 5]];
  const k = footprintFactor(n1, n2) + BAND;
  const skip = new Set<number>();
  const tris: number[] = [];
  for (let s = 0; s < 2; s++) {
    const t = topo.tris[e * 2 + s];
    if (t !== EDGE_ABSENT && t !== EDGE_THIRD) {
      skip.add(t);
      tris.push(t);
    }
  }
  const delta = Math.min(0.01, Math.max(1e-4, 0.01 * requested));
  const tMax = 2 * k * requested + 4 * delta;
  let best = requested;
  const normals = [n1, n2];
  for (let side = 0; side < tris.length; side++) {
    const t = tris[side];
    const n = normals[side];
    let u = unit(cross(n, d));
    // point u into the face: towards the triangle's third vertex
    let c = -1;
    for (let q = 0; q < 3; q++) {
      const x = mesh.indices[t * 3 + q];
      if (x !== av && x !== bv) c = x;
    }
    if (c >= 0) {
      const cv: Vec3 = [p[c * 3], p[c * 3 + 1], p[c * 3 + 2]];
      if (dot(u, sub(cv, a)) < 0) u = mul(u, -1);
    }
    for (const s of [0.2, 0.5, 0.8]) {
      const base = add(add(a, mul(d, s * L)), mul(u, 2 * delta));
      for (const sign of [-1, 1]) {
        const o = add(base, mul(n, sign * delta));
        const hit = raycast(bvh, o[0], o[1], o[2], u[0], u[1], u[2], tMax, skip);
        if (!Number.isFinite(hit) || hit >= tMax) continue;
        const extent = hit + 2 * delta;
        best = Math.min(best, (0.5 * extent) / k);
      }
    }
  }
  return Math.max(0, best);
}

/**
 * Group sweeps into chains that can be built as one seamless sweep. Two ends
 * link when they meet at the same point, each is trimmed only by the other's
 * miter, the turn is below 45° and the faces correspond. Returned chains are
 * oriented copies (A → B along the chain, n1/n2 sides matched); a sweep that
 * links nowhere is a chain of one.
 */
export function linkChains(sweeps: PlannedSweep[]): PlannedSweep[][] {
  const key = (p: Vec3) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
  const ends = new Map<string, { s: number; end: 0 | 1 }[]>();
  sweeps.forEach((s, i) => {
    for (const end of [0, 1] as const) {
      const k = key(end === 0 ? s.a : s.b);
      (ends.get(k) ?? ends.set(k, []).get(k)!).push({ s: i, end });
    }
  });
  const cosTurn = Math.cos((45 * Math.PI) / 180);
  const link: [number, number][] = sweeps.map(() => [-1, -1]); // partner sweep at A / B
  const linkEnd: [0 | 1, 0 | 1][] = sweeps.map(() => [0, 0]);
  for (const list of ends.values()) {
    if (list.length !== 2) continue;
    const [x, y] = list;
    if (x.s === y.s) continue;
    const sx = sweeps[x.s];
    const sy = sweeps[y.s];
    if (sx.concave !== sy.concave) continue;
    const clipsX = x.end === 0 ? sx.clipsA : sx.clipsB;
    const clipsY = y.end === 0 ? sy.clipsA : sy.clipsB;
    if (clipsX.length !== 1 || clipsY.length !== 1) continue;
    if (dot(clipsX[0].n, clipsY[0].n) > -0.999) continue;
    if ((x.end === 0 ? sx.taperA : sx.taperB) > 0 || (y.end === 0 ? sy.taperA : sy.taperB) > 0) continue;
    // incoming direction of x into the joint, outgoing direction of y
    const dx = unit(x.end === 1 ? sub(sx.b, sx.a) : sub(sx.a, sx.b));
    const dy = unit(y.end === 0 ? sub(sy.b, sy.a) : sub(sy.a, sy.b));
    if (dot(dx, dy) < cosTurn) continue;
    const same = Math.max(dot(sx.n1, sy.n1), dot(sx.n2, sy.n2));
    const swapped = Math.max(dot(sx.n1, sy.n2), dot(sx.n2, sy.n1));
    if (Math.max(same, swapped) < Math.cos((40 * Math.PI) / 180)) continue;
    const rx = x.end === 0 ? sx.radiusA : sx.radiusB;
    const ry = y.end === 0 ? sy.radiusA : sy.radiusB;
    if (Math.abs(rx - ry) > 1e-6 * Math.max(1, rx)) continue;
    link[x.s][x.end] = y.s;
    link[y.s][y.end] = x.s;
    linkEnd[x.s][x.end] = y.end;
    linkEnd[y.s][y.end] = x.end;
  }

  const reversed = (s: PlannedSweep): PlannedSweep => ({
    ...s,
    a: s.b,
    b: s.a,
    radiusA: s.radiusB,
    radiusB: s.radiusA,
    taperA: s.taperB,
    taperB: s.taperA,
    extendA: s.extendB,
    extendB: s.extendA,
    clipsA: s.clipsB,
    clipsB: s.clipsA,
  });

  const used = new Uint8Array(sweeps.length);
  const chains: PlannedSweep[][] = [];
  const walk = (start: number) => {
    // go back to the chain head (or around a closed loop once)
    let head = start;
    let headEnd: 0 | 1 = 0; // the free end of `head`
    for (let guard = 0; guard < sweeps.length; guard++) {
      const prev = link[head][headEnd];
      if (prev < 0 || prev === start) break;
      const via: 0 | 1 = linkEnd[head][headEnd];
      head = prev;
      headEnd = via === 0 ? 1 : 0;
    }
    const chain: PlannedSweep[] = [];
    let current = head;
    let entry: 0 | 1 = headEnd;
    let closed = false;
    while (current >= 0 && !used[current]) {
      used[current] = 1;
      let s = entry === 0 ? sweeps[current] : reversed(sweeps[current]);
      if (chain.length > 0) {
        const prev = chain[chain.length - 1];
        const same = dot(prev.n1, s.n1) + dot(prev.n2, s.n2);
        const swapped = dot(prev.n1, s.n2) + dot(prev.n2, s.n1);
        if (swapped > same) s = { ...s, n1: s.n2, n2: s.n1 };
        s = { ...s, a: prev.b };
      }
      chain.push(s);
      const exit: 0 | 1 = entry === 0 ? 1 : 0;
      const next = link[current][exit];
      if (next >= 0 && used[next]) closed = true;
      entry = linkEnd[current][exit];
      current = next;
    }
    // A closed loop cannot be one open sweep; keep its first joint trimmed.
    void closed;
    chains.push(chain);
  };
  for (let i = 0; i < sweeps.length; i++) if (!used[i]) walk(i);
  return chains;
}
