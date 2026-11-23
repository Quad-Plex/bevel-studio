import type { MeshData, RepairRecord } from '../types';
import { dropDegenerate, weld } from '../io/stl';
import { buildTopology, type MeshTopology } from '../topo/topology';
import { UnionFind } from '../topo/unionFind';

export const WELD_TOLERANCE = 1e-4;
/** PLAN §4.2 R6: only close holes up to this many boundary edges. */
export const MAX_HOLE_EDGES = 64;
/** PLAN §4.2 R7: drop components below this fraction of total volume. */
export const SMALL_SHELL_FRACTION = 0.001;
/**
 * A triangle whose shortest altitude is below this is a tessellation sliver,
 * not a manufacturable face. Sliver walls in STL exports are typically a few
 * hundredths of a millimetre wide; 0.05 mm is half the smallest feature the
 * bevel kernel itself resolves (MICRO_EDGE).
 */
export const SLIVER_ALTITUDE = 0.05;
/** Only edges this short are collapsed while removing sliver triangles. */
export const SLIVER_EDGE = 0.05;

export interface RepairStats {
  weldedVertices: number;
  degenerateTriangles: number;
  duplicateFaces: number;
  flippedTriangles: number;
  splitVertices: number;
  holesFilled: number;
  holesUnresolved: number;
  droppedComponents: number;
  droppedVolume: number;
  windingConflicts: number;
  /** vertices merged while collapsing sliver triangles */
  sliverVertices: number;
  /** triangles removed by the sliver collapse */
  sliverTriangles: number;
}

export interface RepairResult {
  mesh: MeshData;
  /** Topology matching `mesh`; safe to pass straight to buildEdgeTable/meta. */
  topology: MeshTopology;
  repairs: RepairRecord[];
  stats: RepairStats;
}

/**
 * Automatic repair pipeline R1–R8 from PLAN §4.2.
 *
 * The pipeline never recentres, rescales or reorders triangles. Triangles are
 * only dropped when invalid (degenerate, duplicate, tiny disconnected shell);
 * vertices may be renumbered when welding or compacting unused ones.
 *
 * R8 is a validation/reporting step, not a mutation: the repaired mesh is
 * always returned so the UI can still open it and show the exact reason when
 * it is not watertight.
 */
export function repairMesh(input: MeshData): RepairResult {
  const stats: RepairStats = {
    weldedVertices: 0,
    degenerateTriangles: 0,
    duplicateFaces: 0,
    flippedTriangles: 0,
    splitVertices: 0,
    holesFilled: 0,
    holesUnresolved: 0,
    droppedComponents: 0,
    droppedVolume: 0,
    windingConflicts: 0,
    sliverVertices: 0,
    sliverTriangles: 0,
  };

  // R1 — weld at 1e-4 mm. parseStl already does this, so on its output this is
  // a no-op; it still protects analyzeMesh when called with a raw MeshData.
  const inputVertices = input.positions.length / 3;
  let mesh = weld(input.positions, input.indices, WELD_TOLERANCE);
  stats.weldedVertices = inputVertices - mesh.positions.length / 3;

  // R1b — collapse tessellation slivers. The reference hook has a 35 mm wall
  // only 0.02 mm wide; the two sides are separate candidate edges with tiny
  // maxWidth, so the bevel used to vanish there. Merge the short edges of
  // sub-0.05 mm-altitude triangles and drop the resulting degenerates.
  const slivers = collapseSlivers(mesh);
  mesh = slivers.mesh;
  stats.sliverVertices = slivers.mergedVertices;
  stats.sliverTriangles = slivers.removedTriangles;

  // R2 — degenerate triangles: repeated indices, non-finite coordinates, or
  // area below tolerance².
  const beforeDegenerate = mesh.indices.length / 3;
  mesh = dropDegenerate(mesh, WELD_TOLERANCE);
  stats.degenerateTriangles = beforeDegenerate - mesh.indices.length / 3;

  // R3 — duplicate faces, canonical sorted-index key, first occurrence wins.
  const deduped = removeDuplicateFaces(mesh);
  mesh = deduped.mesh;
  stats.duplicateFaces = deduped.removed;

  // Orphaned vertices from dropped triangles would inflate the vertex count
  // and bbox; compact once before topology.
  mesh = compactVertices(mesh).mesh;

  let topology = buildTopology(mesh);

  // R4 — consistent winding by BFS across shared edges, then flip any closed
  // shell whose signed volume is negative.
  const orientation = orientConsistently(mesh, topology);
  stats.flippedTriangles += orientation.flipped;
  stats.windingConflicts = orientation.conflicts;

  // R5 — split bow-tie vertices: one vertex per face fan.
  const split = splitNonManifoldVertices(mesh, topology);
  if (split.vertices > 0) {
    mesh = split.mesh;
    stats.splitVertices = split.vertices;
    topology = buildTopology(mesh);
  }

  // R6 — close boundary loops up to 64 edges with a fan.
  const holes = fillHoles(mesh, topology);
  stats.holesFilled = holes.filled;
  stats.holesUnresolved = holes.unresolved;
  if (holes.filled > 0) {
    mesh = holes.mesh;
    topology = buildTopology(mesh);
  }

  // R7 — final volume orientation and removal of tiny disconnected debris.
  const components = finalizeComponents(mesh, topology);
  stats.flippedTriangles += components.flipped;
  if (components.dropped > 0) {
    mesh = components.mesh;
    stats.droppedComponents = components.dropped;
    stats.droppedVolume = components.droppedVolume;
    topology = buildTopology(mesh);
  }

  // R8 — flip away cap slivers: a vertex lying within 0.05 mm of the opposite
  // edge's interior (a T-junction or a 1 µm step between two caps). Such a
  // triangle has no short edge for R1b to collapse, and its normal is noise,
  // so it shows up as a fake 90° sharp edge across a flat face.
  const flips = flipCapSlivers(mesh);
  if (flips.flipped > 0) {
    mesh = flips.mesh;
    stats.sliverTriangles += flips.flipped;
    topology = buildTopology(mesh);
  }

  // Final compaction: R7 can leave vertices unused, and R5/R6 only append
  // vertices that are in use. Rebuild topology only if ids actually changed.
  const finalCompact = compactVertices(mesh);
  if (finalCompact.removed > 0) {
    mesh = finalCompact.mesh;
    topology = buildTopology(mesh);
  }

  return {
    mesh,
    topology,
    repairs: buildRepairRecords(stats),
    stats,
  };
}

function buildRepairRecords(stats: RepairStats): RepairRecord[] {
  const records: RepairRecord[] = [];
  if (stats.weldedVertices > 0) {
    records.push({
      code: 'weld',
      count: stats.weldedVertices,
      detail: `welded ${stats.weldedVertices} duplicate vertices`,
    });
  }
  if (stats.sliverTriangles > 0) {
    records.push({
      code: 'sliver',
      count: stats.sliverTriangles,
      detail: `collapsed ${stats.sliverTriangles} sliver triangles (${stats.sliverVertices} vertices merged)`,
    });
  }
  if (stats.degenerateTriangles > 0) {
    records.push({
      code: 'degenerate',
      count: stats.degenerateTriangles,
      detail: `removed ${stats.degenerateTriangles} degenerate triangles`,
    });
  }
  if (stats.duplicateFaces > 0) {
    records.push({
      code: 'duplicate',
      count: stats.duplicateFaces,
      detail: `removed ${stats.duplicateFaces} duplicate faces`,
    });
  }
  if (stats.flippedTriangles > 0) {
    records.push({
      code: 'flipped',
      count: stats.flippedTriangles,
      detail: `fixed ${stats.flippedTriangles} flipped triangles`,
    });
  }
  if (stats.splitVertices > 0) {
    records.push({
      code: 'nonManifold',
      count: stats.splitVertices,
      detail: `split ${stats.splitVertices} non-manifold vertices`,
    });
  }
  if (stats.holesFilled > 0) {
    records.push({
      code: 'hole',
      count: stats.holesFilled,
      detail: `closed ${stats.holesFilled} holes`,
    });
  }
  if (stats.droppedComponents > 0) {
    records.push({
      code: 'shell',
      count: stats.droppedComponents,
      detail: `dropped ${stats.droppedComponents} tiny components (${stats.droppedVolume.toFixed(3)} mm³)`,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// R1b — sliver triangles
// ---------------------------------------------------------------------------

/**
 * Collapse the shortest edge of triangles whose minimum altitude is below
 * SLIVER_ALTITUDE. This is a targeted weld: only vertices joined by a short
 * edge of an already-sliver triangle are merged, so unrelated surfaces that
 * happen to pass within 0.05 mm are left alone. Merged vertices use the
 * cluster centroid, then repeated-vertex triangles, duplicate faces and
 * unused vertices are dropped in that order.
 */
function collapseSlivers(mesh: MeshData): {
  mesh: MeshData;
  mergedVertices: number;
  removedTriangles: number;
} {
  const { positions, indices } = mesh;
  const vertexCount = positions.length / 3;
  const triCount = indices.length / 3;
  if (vertexCount === 0 || triCount === 0) {
    return { mesh, mergedVertices: 0, removedTriangles: 0 };
  }

  const union = new UnionFind(vertexCount);
  let sliverTriangles = 0;

  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const bx = positions[b * 3];
    const by = positions[b * 3 + 1];
    const bz = positions[b * 3 + 2];
    const cx = positions[c * 3];
    const cy = positions[c * 3 + 1];
    const cz = positions[c * 3 + 2];

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const area2 = Math.hypot(nx, ny, nz);
    if (!(area2 > 0)) continue;

    const ab = Math.hypot(bx - ax, by - ay, bz - az);
    const bc = Math.hypot(cx - bx, cy - by, cz - bz);
    const ca = Math.hypot(ax - cx, ay - cy, az - cz);
    const longest = Math.max(ab, bc, ca);
    if (!(longest > 0)) continue;
    if (area2 / longest >= SLIVER_ALTITUDE) continue;

    sliverTriangles++;
    if (ab < SLIVER_EDGE) union.union(a, b);
    if (bc < SLIVER_EDGE) union.union(b, c);
    if (ca < SLIVER_EDGE) union.union(c, a);
  }

  if (sliverTriangles === 0) return { mesh, mergedVertices: 0, removedTriangles: 0 };

  const counts = new Int32Array(vertexCount);
  const sumX = new Float64Array(vertexCount);
  const sumY = new Float64Array(vertexCount);
  const sumZ = new Float64Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const root = union.find(v);
    counts[root]++;
    sumX[root] += positions[v * 3];
    sumY[root] += positions[v * 3 + 1];
    sumZ[root] += positions[v * 3 + 2];
  }

  const rootToId = new Int32Array(vertexCount).fill(-1);
  const newPositions = new Float32Array(vertexCount * 3);
  let newVertexCount = 0;
  for (let v = 0; v < vertexCount; v++) {
    const root = union.find(v);
    if (rootToId[root] >= 0) continue;
    const id = newVertexCount++;
    rootToId[root] = id;
    const n = counts[root];
    newPositions[id * 3] = sumX[root] / n;
    newPositions[id * 3 + 1] = sumY[root] / n;
    newPositions[id * 3 + 2] = sumZ[root] / n;
  }

  const newIndices: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = rootToId[union.find(indices[t * 3])];
    const b = rootToId[union.find(indices[t * 3 + 1])];
    const c = rootToId[union.find(indices[t * 3 + 2])];
    if (a === b || b === c || a === c) continue;
    newIndices.push(a, b, c);
  }

  if (newVertexCount === vertexCount && newIndices.length === indices.length) {
    return { mesh, mergedVertices: 0, removedTriangles: 0 };
  }

  let collapsed: MeshData = {
    positions: newPositions.slice(0, newVertexCount * 3),
    indices: new Uint32Array(newIndices),
  };
  collapsed = removeDuplicateFaces(collapsed).mesh;
  collapsed = compactVertices(collapsed).mesh;

  return {
    mesh: collapsed,
    mergedVertices: vertexCount - collapsed.positions.length / 3,
    removedTriangles: triCount - collapsed.indices.length / 3,
  };
}

// ---------------------------------------------------------------------------
// R8 — cap slivers
// ---------------------------------------------------------------------------

/**
 * Edge-flip triangles whose altitude is below SLIVER_ALTITUDE but whose edges
 * are all long (a "cap": one vertex almost on the opposite edge). The flip
 * replaces the sliver and its neighbour across the long edge by two triangles
 * through the near-collinear vertex. It is only taken when both new triangles
 * are well shaped relative to the neighbour's plane, so feature edges are
 * kept (as a near-straight two-edge path).
 */
function flipCapSlivers(mesh: MeshData): { mesh: MeshData; flipped: number } {
  const p = mesh.positions;
  const idx = new Uint32Array(mesh.indices);
  const triCount = idx.length / 3;
  const edgeKey = (a: number, b: number) => (a < b ? a * 0x100000000 + b : b * 0x100000000 + a);
  const owners = new Map<number, number[]>();
  const addOwner = (t: number) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(idx[t * 3 + k], idx[t * 3 + ((k + 1) % 3)]);
      const list = owners.get(key);
      if (list) list.push(t);
      else owners.set(key, [t]);
    }
  };
  const removeOwner = (t: number) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(idx[t * 3 + k], idx[t * 3 + ((k + 1) % 3)]);
      const list = owners.get(key);
      if (!list) continue;
      const at = list.indexOf(t);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) owners.delete(key);
    }
  };
  for (let t = 0; t < triCount; t++) addOwner(t);

  const P = (v: number) => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
  const normal = (a: number, b: number, c: number) => {
    const A = P(a);
    const B = P(b);
    const C = P(c);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    return { n: l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0], area2: l };
  };
  const dist = (a: number, b: number) => {
    const A = P(a);
    const B = P(b);
    return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
  };

  let flipped = 0;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let t = 0; t < triCount; t++) {
      const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
      const lengths = [dist(v[0], v[1]), dist(v[1], v[2]), dist(v[2], v[0])];
      const longest = Math.max(...lengths);
      if (!(longest > 0)) continue;
      const { area2 } = normal(v[0], v[1], v[2]);
      if (area2 / longest >= SLIVER_ALTITUDE) continue;
      if (Math.min(...lengths) < SLIVER_EDGE) continue; // R1b's case
      const k = lengths.indexOf(longest);
      const u0 = v[k];
      const v0 = v[(k + 1) % 3];
      const w = v[(k + 2) % 3];
      const across = (owners.get(edgeKey(u0, v0)) ?? []).filter((x) => x !== t);
      if (across.length !== 1) continue;
      const t2 = across[0];
      let x = -1;
      for (let q = 0; q < 3; q++) {
        const c = idx[t2 * 3 + q];
        if (c !== u0 && c !== v0) x = c;
      }
      if (x < 0 || x === w || owners.has(edgeKey(w, x))) continue;
      const ref = normal(idx[t2 * 3], idx[t2 * 3 + 1], idx[t2 * 3 + 2]);
      const a1 = normal(u0, x, w);
      const a2 = normal(v0, w, x);
      // the flip may not tilt the neighbour face: it would create a fake crease
      const cosTilt = Math.cos((2 * Math.PI) / 180);
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      if (dot(a1.n, ref.n) < cosTilt || dot(a2.n, ref.n) < cosTilt) continue;
      const lx = Math.max(dist(u0, x), dist(x, w), dist(w, u0));
      const ly = Math.max(dist(v0, w), dist(w, x), dist(x, v0));
      if (a1.area2 / lx < SLIVER_ALTITUDE || a2.area2 / ly < SLIVER_ALTITUDE) continue;

      removeOwner(t);
      removeOwner(t2);
      idx[t * 3] = u0;
      idx[t * 3 + 1] = x;
      idx[t * 3 + 2] = w;
      idx[t2 * 3] = v0;
      idx[t2 * 3 + 1] = w;
      idx[t2 * 3 + 2] = x;
      addOwner(t);
      addOwner(t2);
      flipped++;
      changed = true;
    }
    if (!changed) break;
  }
  return flipped > 0 ? { mesh: { positions: p, indices: idx }, flipped } : { mesh, flipped: 0 };
}

// ---------------------------------------------------------------------------
// R3 — duplicate faces
// ---------------------------------------------------------------------------

function removeDuplicateFaces(mesh: MeshData): { mesh: MeshData; removed: number } {
  const { indices } = mesh;
  const seen = new Set<string>();
  const keep: number[] = [];

  for (let i = 0; i < indices.length; i += 3) {
    let a = indices[i];
    let b = indices[i + 1];
    let c = indices[i + 2];
    // sort three ids without allocating an array per triangle
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (b > c) {
      const t = b;
      b = c;
      c = t;
    }
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    const key = `${a},${b},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(indices[i], indices[i + 1], indices[i + 2]);
  }

  const removed = (indices.length - keep.length) / 3;
  if (removed === 0) return { mesh, removed: 0 };
  return { mesh: { positions: mesh.positions, indices: new Uint32Array(keep) }, removed };
}

// ---------------------------------------------------------------------------
// R4 — orientation
// ---------------------------------------------------------------------------

function orientConsistently(
  mesh: MeshData,
  topology: MeshTopology,
): { flipped: number; conflicts: number } {
  const { indices, positions } = mesh;
  const triCount = topology.triCount;
  if (triCount === 0) return { flipped: 0, conflicts: 0 };

  const parity = new Uint8Array(triCount);
  parity.fill(255);
  const queue = new Int32Array(triCount);
  const conflictEdge = new Uint8Array(topology.edgeCount);
  const shellTris: number[] = [];
  let flipped = 0;

  for (let seed = 0; seed < triCount; seed++) {
    if (parity[seed] !== 255) continue;

    parity[seed] = 0;
    queue[0] = seed;
    let head = 0;
    let tail = 1;
    shellTris.length = 0;
    shellTris.push(seed);
    let closed = true;

    while (head < tail) {
      const t = queue[head++];
      const base = t * 3;
      for (let k = 0; k < 3; k++) {
        const he = base + k;
        const e = topology.halfEdgeEdge[he];
        if (e === 0xffffffff) {
          closed = false;
          continue;
        }
        const start = topology.edgeOffset[e];
        const end = topology.edgeOffset[e + 1];
        const incidence = end - start;
        if (incidence !== 2) closed = false;

        const dirT = indices[he] < indices[base + ((k + 1) % 3)] ? 1 : 0;
        for (let i = start; i < end; i++) {
          const n = topology.edgeTris[i];
          if (n === t) continue;
          const dirN = topology.edgeDir[i];
          const need = parity[t] ^ (dirT === dirN ? 1 : 0);
          if (parity[n] === 255) {
            parity[n] = need;
            queue[tail++] = n;
            shellTris.push(n);
          } else if (incidence === 2 && parity[n] !== need) {
            conflictEdge[e] = 1;
          }
        }
      }
    }

    let volume6 = 0;
    for (let s = 0; s < shellTris.length; s++) {
      const t = shellTris[s];
      const base = t * 3;
      let b = indices[base + 1];
      let c = indices[base + 2];
      if (parity[t]) {
        const tmp = b;
        b = c;
        c = tmp;
      }
      volume6 += signedTet6(positions, indices[base], b, c);
    }

    if (closed && volume6 < 0) {
      for (let s = 0; s < shellTris.length; s++) parity[shellTris[s]] ^= 1;
    }

    for (let s = 0; s < shellTris.length; s++) {
      const t = shellTris[s];
      if (!parity[t]) continue;
      const base = t * 3;
      const tmp = indices[base + 1];
      indices[base + 1] = indices[base + 2];
      indices[base + 2] = tmp;
      flipped++;
    }
  }

  let conflicts = 0;
  for (let e = 0; e < conflictEdge.length; e++) if (conflictEdge[e]) conflicts++;
  return { flipped, conflicts };
}

// ---------------------------------------------------------------------------
// R5 — non-manifold (bow-tie) vertices
// ---------------------------------------------------------------------------

function splitNonManifoldVertices(
  mesh: MeshData,
  topology: MeshTopology,
): { mesh: MeshData; vertices: number; added: number } {
  const triCount = topology.triCount;
  if (triCount === 0) return { mesh, vertices: 0, added: 0 };

  const cornerCount = triCount * 3;
  const fans = new UnionFind(cornerCount);

  // Two corners at the same vertex belong to the same fan when their triangles
  // share an edge incident to that vertex. Union both endpoints of every edge.
  for (let e = 0; e < topology.edgeCount; e++) {
    const start = topology.edgeOffset[e];
    const end = topology.edgeOffset[e + 1];
    if (end - start < 2) continue;

    const firstCorner = topology.edgeCorner[start];
    const firstK = firstCorner % 3;
    const firstNext = firstCorner - firstK + ((firstK + 1) % 3);
    const firstStart = mesh.indices[firstCorner];

    for (let i = start + 1; i < end; i++) {
      const corner = topology.edgeCorner[i];
      const k = corner % 3;
      const next = corner - k + ((k + 1) % 3);
      if (mesh.indices[corner] === firstStart) {
        fans.union(corner, firstCorner);
        fans.union(next, firstNext);
      } else {
        fans.union(corner, firstNext);
        fans.union(next, firstCorner);
      }
    }
  }

  const newPositions: number[] = [];
  const indices = mesh.indices;
  let splitVertices = 0;

  for (let v = 0; v < topology.vertexCount; v++) {
    const start = topology.vertexOffset[v];
    const end = topology.vertexOffset[v + 1];
    if (end - start < 2) continue;

    const roots: number[] = [];
    for (let i = start; i < end; i++) {
      const r = fans.find(topology.vertexCorners[i]);
      let known = false;
      for (let j = 0; j < roots.length; j++) {
        if (roots[j] === r) {
          known = true;
          break;
        }
      }
      if (!known) roots.push(r);
    }
    if (roots.length <= 1) continue;

    splitVertices++;
    const x = mesh.positions[v * 3];
    const y = mesh.positions[v * 3 + 1];
    const z = mesh.positions[v * 3 + 2];
    const replacement = new Map<number, number>();
    replacement.set(roots[0], v);

    for (let j = 1; j < roots.length; j++) {
      const id = topology.vertexCount + newPositions.length / 3;
      newPositions.push(x, y, z);
      replacement.set(roots[j], id);
    }

    for (let i = start; i < end; i++) {
      const corner = topology.vertexCorners[i];
      const id = replacement.get(fans.find(corner));
      if (id !== undefined && id !== v) indices[corner] = id;
    }
  }

  if (splitVertices === 0) return { mesh, vertices: 0, added: 0 };

  const added = newPositions.length / 3;
  const positions = new Float32Array(mesh.positions.length + newPositions.length);
  positions.set(mesh.positions);
  positions.set(newPositions, mesh.positions.length);
  return { mesh: { positions, indices }, vertices: splitVertices, added };
}

// ---------------------------------------------------------------------------
// R6 — hole closing
// ---------------------------------------------------------------------------

function fillHoles(
  mesh: MeshData,
  topology: MeshTopology,
): { mesh: MeshData; filled: number; unresolved: number; addedTriangles: number } {
  const boundary: number[] = [];
  for (let e = 0; e < topology.edgeCount; e++) {
    if (topology.edgeOffset[e + 1] - topology.edgeOffset[e] === 1) boundary.push(e);
  }
  if (boundary.length === 0) {
    return { mesh, filled: 0, unresolved: 0, addedTriangles: 0 };
  }

  const adjacency = new Map<number, number[]>();
  const addAdjacent = (vertex: number, edge: number) => {
    const list = adjacency.get(vertex);
    if (list) list.push(edge);
    else adjacency.set(vertex, [edge]);
  };
  for (const e of boundary) {
    addAdjacent(topology.edgeV[e * 2], e);
    addAdjacent(topology.edgeV[e * 2 + 1], e);
  }

  const visited = new Uint8Array(topology.edgeCount);
  const newTriangles: number[] = [];
  const newPositions: number[] = [];
  let filled = 0;
  let unresolved = 0;

  for (const firstEdge of boundary) {
    if (visited[firstEdge]) continue;
    visited[firstEdge] = 1;

    const start = topology.edgeV[firstEdge * 2];
    let current = topology.edgeV[firstEdge * 2 + 1];
    let currentEdge = firstEdge;
    const loop: number[] = [start, current];

    let guard = 0;
    while (current !== start && guard++ <= boundary.length + 1) {
      const nextEdge = findNextBoundary(adjacency, current, currentEdge, visited);
      if (nextEdge < 0) break;
      visited[nextEdge] = 1;
      const other =
        topology.edgeV[nextEdge * 2] === current
          ? topology.edgeV[nextEdge * 2 + 1]
          : topology.edgeV[nextEdge * 2];
      if (other === start) {
        current = start;
        break;
      }
      loop.push(other);
      current = other;
      currentEdge = nextEdge;
    }

    if (current !== start || loop.length < 3) {
      unresolved++;
      continue;
    }
    if (loop.length > MAX_HOLE_EDGES) {
      unresolved++;
      continue;
    }

    // The cap must traverse each boundary edge opposite to the existing
    // triangle, otherwise the new face would face into the solid.
    const corner = topology.edgeCorner[topology.edgeOffset[firstEdge]];
    const k = corner % 3;
    const nextCorner = corner - k + ((k + 1) % 3);
    const directedA = mesh.indices[corner];
    const directedB = mesh.indices[nextCorner];
    let cap = loop;
    if (directedA === loop[0] && directedB === loop[1]) cap = loop.slice().reverse();

    const capTriangles: number[] = [];
    let centerId = -1;
    let centerX = 0;
    let centerY = 0;
    let centerZ = 0;

    if (cap.length === 3) {
      capTriangles.push(cap[0], cap[1], cap[2]);
    } else {
      for (const vertex of cap) {
        centerX += mesh.positions[vertex * 3];
        centerY += mesh.positions[vertex * 3 + 1];
        centerZ += mesh.positions[vertex * 3 + 2];
      }
      const inv = 1 / cap.length;
      centerX *= inv;
      centerY *= inv;
      centerZ *= inv;
      centerId = topology.vertexCount + newPositions.length / 3;
      for (let i = 0; i < cap.length; i++) {
        capTriangles.push(cap[i], cap[(i + 1) % cap.length], centerId);
      }
    }

    // Never trade a hole for a degenerate cap: leave it open and let R8 report
    // the exact reason instead.
    let valid = true;
    const areaEps = WELD_TOLERANCE * WELD_TOLERANCE;
    for (let i = 0; i < capTriangles.length; i += 3) {
      const area = triangleArea(
        mesh.positions,
        capTriangles[i],
        capTriangles[i + 1],
        capTriangles[i + 2],
        centerId,
        centerX,
        centerY,
        centerZ,
      );
      if (!(area >= areaEps)) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      unresolved++;
      continue;
    }

    if (centerId >= 0) newPositions.push(centerX, centerY, centerZ);
    for (let i = 0; i < capTriangles.length; i++) newTriangles.push(capTriangles[i]);
    filled++;
  }

  if (filled === 0) {
    return { mesh, filled: 0, unresolved, addedTriangles: 0 };
  }

  const positions = new Float32Array(mesh.positions.length + newPositions.length);
  positions.set(mesh.positions);
  positions.set(newPositions, mesh.positions.length);
  const indices = new Uint32Array(mesh.indices.length + newTriangles.length);
  indices.set(mesh.indices);
  indices.set(newTriangles, mesh.indices.length);

  return {
    mesh: { positions, indices },
    filled,
    unresolved,
    addedTriangles: newTriangles.length / 3,
  };
}

function findNextBoundary(
  adjacency: Map<number, number[]>,
  vertex: number,
  currentEdge: number,
  visited: Uint8Array,
): number {
  const list = adjacency.get(vertex);
  if (!list) return -1;
  for (const edge of list) {
    if (edge !== currentEdge && !visited[edge]) return edge;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// R7 — shells: volume orientation and tiny-component removal
// ---------------------------------------------------------------------------

function finalizeComponents(
  mesh: MeshData,
  topology: MeshTopology,
): { mesh: MeshData; dropped: number; droppedVolume: number; flipped: number } {
  const triCount = topology.triCount;
  if (triCount === 0) return { mesh, dropped: 0, droppedVolume: 0, flipped: 0 };

  const shells = new UnionFind(triCount);
  for (let e = 0; e < topology.edgeCount; e++) {
    const start = topology.edgeOffset[e];
    const end = topology.edgeOffset[e + 1];
    if (end - start < 2) continue;
    const first = topology.edgeTris[start];
    for (let i = start + 1; i < end; i++) shells.union(first, topology.edgeTris[i]);
  }

  const compOf = new Int32Array(triCount);
  const rootToComp = new Map<number, number>();
  let compCount = 0;
  for (let t = 0; t < triCount; t++) {
    const root = shells.find(t);
    let comp = rootToComp.get(root);
    if (comp === undefined) {
      comp = compCount++;
      rootToComp.set(root, comp);
    }
    compOf[t] = comp;
  }

  const compFaces = new Uint32Array(compCount);
  for (let t = 0; t < triCount; t++) compFaces[compOf[t]]++;
  const compOffset = new Uint32Array(compCount + 1);
  for (let c = 0; c < compCount; c++) compOffset[c + 1] = compOffset[c] + compFaces[c];
  const compTris = new Uint32Array(triCount);
  const cursor = compOffset.slice();
  for (let t = 0; t < triCount; t++) compTris[cursor[compOf[t]]++] = t;

  const compVolume = new Float64Array(compCount);
  const compClosed = new Uint8Array(compCount);

  for (let c = 0; c < compCount; c++) {
    let volume6 = 0;
    let closed = 1;
    for (let i = compOffset[c]; i < compOffset[c + 1]; i++) {
      const t = compTris[i];
      const base = t * 3;
      volume6 += signedTet6(mesh.positions, mesh.indices[base], mesh.indices[base + 1], mesh.indices[base + 2]);
      for (let k = 0; k < 3; k++) {
        const e = topology.halfEdgeEdge[base + k];
        if (e === 0xffffffff || topology.edgeOffset[e + 1] - topology.edgeOffset[e] !== 2) {
          closed = 0;
        }
      }
    }
    compVolume[c] = volume6 / 6;
    compClosed[c] = closed;
  }

  let totalAbs = 0;
  let largest = 0;
  let largestAbs = -1;
  for (let c = 0; c < compCount; c++) {
    const abs = Math.abs(compVolume[c]);
    totalAbs += abs;
    if (abs > largestAbs) {
      largestAbs = abs;
      largest = c;
    }
  }

  const threshold = totalAbs * SMALL_SHELL_FRACTION;
  const drop = new Uint8Array(compCount);
  let dropped = 0;
  let droppedVolume = 0;
  if (totalAbs > 0) {
    for (let c = 0; c < compCount; c++) {
      if (c === largest) continue;
      const abs = Math.abs(compVolume[c]);
      if (abs < threshold) {
        drop[c] = 1;
        dropped++;
        droppedVolume += abs;
      }
    }
  }

  // Flip closed, kept shells that are still inside-out. Open shells have no
  // meaningful signed volume, so they are left for R8 to report.
  let flipped = 0;
  for (let c = 0; c < compCount; c++) {
    if (drop[c] || !compClosed[c] || compVolume[c] >= 0) continue;
    for (let i = compOffset[c]; i < compOffset[c + 1]; i++) {
      const base = compTris[i] * 3;
      const tmp = mesh.indices[base + 1];
      mesh.indices[base + 1] = mesh.indices[base + 2];
      mesh.indices[base + 2] = tmp;
    }
    flipped += compFaces[c];
  }

  if (dropped === 0) {
    return { mesh, dropped: 0, droppedVolume: 0, flipped };
  }

  let droppedFaces = 0;
  for (let c = 0; c < compCount; c++) if (drop[c]) droppedFaces += compFaces[c];
  const keepFaces = triCount - droppedFaces;
  const indices = new Uint32Array(keepFaces * 3);
  let write = 0;
  for (let t = 0; t < triCount; t++) {
    if (drop[compOf[t]]) continue;
    const base = t * 3;
    indices[write++] = mesh.indices[base];
    indices[write++] = mesh.indices[base + 1];
    indices[write++] = mesh.indices[base + 2];
  }

  const compacted = compactVertices({ positions: mesh.positions, indices });
  return { mesh: compacted.mesh, dropped, droppedVolume, flipped };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Remove vertices no triangle references. Preserves triangle order and ids. */
export function compactVertices(mesh: MeshData): { mesh: MeshData; removed: number } {
  const { positions, indices } = mesh;
  const vertexCount = positions.length / 3;
  if (vertexCount === 0) return { mesh, removed: 0 };

  const used = new Uint8Array(vertexCount);
  for (let i = 0; i < indices.length; i++) used[indices[i]] = 1;

  let count = 0;
  const remap = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    if (used[v]) remap[v] = count++;
  }
  if (count === vertexCount) return { mesh, removed: 0 };

  const newPositions = new Float32Array(count * 3);
  for (let v = 0; v < vertexCount; v++) {
    if (!used[v]) continue;
    const dst = remap[v] * 3;
    newPositions[dst] = positions[v * 3];
    newPositions[dst + 1] = positions[v * 3 + 1];
    newPositions[dst + 2] = positions[v * 3 + 2];
  }
  const newIndices = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) newIndices[i] = remap[indices[i]];

  return { mesh: { positions: newPositions, indices: newIndices }, removed: vertexCount - count };
}

/** a · (b × c), the six-times-signed-tetrahedron term. */
function signedTet6(positions: Float32Array, a: number, b: number, c: number): number {
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const bx = positions[b * 3];
  const by = positions[b * 3 + 1];
  const bz = positions[b * 3 + 2];
  const cx = positions[c * 3];
  const cy = positions[c * 3 + 1];
  const cz = positions[c * 3 + 2];
  return ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
}

/**
 * Area of a triangle, with an optional not-yet-appended vertex (the centroid
 * of a hole fan) supplied explicitly.
 */
function triangleArea(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
  extraId: number,
  extraX: number,
  extraY: number,
  extraZ: number,
): number {
  const ax = a === extraId ? extraX : positions[a * 3];
  const ay = a === extraId ? extraY : positions[a * 3 + 1];
  const az = a === extraId ? extraZ : positions[a * 3 + 2];
  const bx = b === extraId ? extraX : positions[b * 3];
  const by = b === extraId ? extraY : positions[b * 3 + 1];
  const bz = b === extraId ? extraZ : positions[b * 3 + 2];
  const cx = c === extraId ? extraX : positions[c * 3];
  const cy = c === extraId ? extraY : positions[c * 3 + 1];
  const cz = c === extraId ? extraZ : positions[c * 3 + 2];

  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return Math.hypot(nx, ny, nz) * 0.5;
}
