import type { MeshData, RepairRecord } from '../types';
import { dropDegenerate, weld } from '../io/stl';
import { buildTopology, type MeshTopology } from '../topo/topology';
import { UnionFind } from '../topo/unionFind';

export const WELD_TOLERANCE = 1e-4;
/** PLAN §4.2 R6: only close holes up to this many boundary edges. */
export const MAX_HOLE_EDGES = 64;
/** PLAN §4.2 R7: drop components below this fraction of total volume. */
export const SMALL_SHELL_FRACTION = 0.001;

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
  };

  // R1 — weld at 1e-4 mm. parseStl already does this, so on its output this is
  // a no-op; it still protects analyzeMesh when called with a raw MeshData.
  const inputVertices = input.positions.length / 3;
  let mesh = weld(input.positions, input.indices, WELD_TOLERANCE);
  stats.weldedVertices = inputVertices - mesh.positions.length / 3;

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
