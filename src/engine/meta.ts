import type { Bounds, EdgeTable, MeshData, MeshMeta } from './types';
import { EDGE_BOUNDARY, EDGE_NON_MANIFOLD } from './types';
import { buildEdgeTable } from './topo/build';
import { buildTopology, type MeshTopology } from './topo/topology';
import { UnionFind } from './topo/unionFind';

const AREA_EPS = 1e-8;

/**
 * Cheap, topology-free metadata for the viewport's first paint. Full shells /
 * genus / watertight data comes from `computeMeshMeta` once the repair pass has
 * built the edge table; keeping this path cheap is deliberate (it runs on the
 * UI thread while a file is being opened).
 */
export function computeBasicMeta(mesh: MeshData, name: string): MeshMeta {
  const { positions, indices } = mesh;
  const bbox = meshBounds(mesh);
  const volume = Math.abs(signedVolume(mesh));
  const area = surfaceArea(mesh);

  return {
    name,
    units: 'mm',
    unitsAssumed: true,
    bbox,
    volume,
    area,
    triangles: indices.length / 3,
    vertices: positions.length / 3,
    edges: 0,
    shells: indices.length > 0 ? 1 : 0,
    genus: 0,
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    flippedTriangles: 0,
    degenerateTriangles: countDegenerate(mesh),
    watertight: false,
  };
}

/**
 * Full metadata for a repaired mesh: shells, genus via Euler per shell,
 * boundary/non-manifold counts, watertightness, flipped/degenerate counts,
 * volume, area and bbox. Units are millimetres.
 *
 * `edges` and `topology` are optional so tests and callers can ask for full
 * metadata without building the edge table first; analyzeMesh passes both to
 * avoid duplicate work.
 */
export function computeMeshMeta(
  mesh: MeshData,
  name: string,
  edges?: EdgeTable,
  topology?: MeshTopology,
): MeshMeta {
  const topo = topology ?? buildTopology(mesh);
  const table = edges ?? buildEdgeTable(mesh, topo);
  const { positions, indices } = mesh;
  const triCount = topo.triCount;
  const vertexCount = topo.vertexCount;
  const edgeCount = topo.edgeCount;

  const bbox = meshBounds(mesh);
  const area = surfaceArea(mesh);
  const degenerateTriangles = countDegenerate(mesh);

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (let e = 0; e < table.count; e++) {
    if (table.flags[e] & EDGE_BOUNDARY) boundaryEdges++;
    if (table.flags[e] & EDGE_NON_MANIFOLD) nonManifoldEdges++;
  }

  if (triCount === 0) {
    return {
      name,
      units: 'mm',
      unitsAssumed: true,
      bbox,
      volume: 0,
      area,
      triangles: 0,
      vertices: vertexCount,
      edges: edgeCount,
      shells: 0,
      genus: 0,
      boundaryEdges,
      nonManifoldEdges,
      flippedTriangles: 0,
      degenerateTriangles,
      watertight: false,
    };
  }

  const compOf = componentIds(topo);
  let compCount = 0;
  for (let t = 0; t < triCount; t++) if (compOf[t] + 1 > compCount) compCount = compOf[t] + 1;

  const compFaces = new Uint32Array(compCount);
  const compVertices = new Uint32Array(compCount);
  const compEdges = new Uint32Array(compCount);
  const compVolume6 = new Float64Array(compCount);
  const compClosed = new Uint8Array(compCount);
  compClosed.fill(1);

  // Stamps are component id + 1; 0xffffffff is "unmarked". A vertex or edge
  // shared by several components is counted once in each.
  const markVertex = new Uint32Array(vertexCount);
  markVertex.fill(0xffffffff);
  const markEdge = new Uint32Array(edgeCount);
  markEdge.fill(0xffffffff);

  for (let t = 0; t < triCount; t++) {
    const c = compOf[t];
    const stamp = c + 1;
    const base = t * 3;
    compFaces[c]++;

    for (let k = 0; k < 3; k++) {
      const v = indices[base + k];
      if (markVertex[v] !== stamp) {
        markVertex[v] = stamp;
        compVertices[c]++;
      }
    }

    for (let k = 0; k < 3; k++) {
      const e = topo.halfEdgeEdge[base + k];
      if (e === 0xffffffff) {
        compClosed[c] = 0;
        continue;
      }
      if (markEdge[e] !== stamp) {
        markEdge[e] = stamp;
        compEdges[c]++;
      }
      if (topo.edgeOffset[e + 1] - topo.edgeOffset[e] !== 2) compClosed[c] = 0;
    }

    compVolume6[c] += signedTet6(positions, indices[base], indices[base + 1], indices[base + 2]);
  }

  let totalSigned = 0;
  for (let c = 0; c < compCount; c++) {
    compVolume6[c] /= 6;
    totalSigned += compVolume6[c];
  }

  const boundaryLoops = countBoundaryLoopsPerComponent(topo, table, compOf, compCount);

  let genus = 0;
  for (let c = 0; c < compCount; c++) {
    const chi = compVertices[c] - compEdges[c] + compFaces[c];
    const b = boundaryLoops[c];
    let g = (2 - b - chi) / 2;
    if (!Number.isFinite(g) || g < 0) g = 0;
    genus += Math.round(g);
  }

  // Flipped = triangles in a closed shell with negative volume, plus triangles
  // whose winding disagrees with a manifold neighbour. After repair this is 0.
  const flippedFlag = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const c = compOf[t];
    if (compClosed[c] && compVolume6[c] < 0) flippedFlag[t] = 1;
  }
  for (let e = 0; e < table.count; e++) {
    if (table.flags[e] & (EDGE_BOUNDARY | EDGE_NON_MANIFOLD)) continue;
    const t1 = table.tris[e * 2];
    const t2 = table.tris[e * 2 + 1];
    if (t1 === 0xffffffff || t2 === 0xffffffff) continue;
    const a = table.v[e * 2];
    const b = table.v[e * 2 + 1];
    const d1 = directionOf(indices, t1, a, b);
    const d2 = directionOf(indices, t2, a, b);
    if (d1 >= 0 && d1 === d2) {
      flippedFlag[t1] = 1;
      flippedFlag[t2] = 1;
    }
  }
  let flippedTriangles = 0;
  for (let t = 0; t < triCount; t++) if (flippedFlag[t]) flippedTriangles++;

  return {
    name,
    units: 'mm',
    unitsAssumed: true,
    bbox,
    volume: Math.abs(totalSigned),
    area,
    triangles: triCount,
    vertices: vertexCount,
    edges: edgeCount,
    shells: compCount,
    genus,
    boundaryEdges,
    nonManifoldEdges,
    flippedTriangles,
    degenerateTriangles,
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0 && degenerateTriangles === 0,
  };
}

function componentIds(topo: MeshTopology): Int32Array {
  const triCount = topo.triCount;
  const uf = new UnionFind(triCount);
  for (let e = 0; e < topo.edgeCount; e++) {
    const start = topo.edgeOffset[e];
    const end = topo.edgeOffset[e + 1];
    if (end - start < 2) continue;
    const first = topo.edgeTris[start];
    for (let i = start + 1; i < end; i++) uf.union(first, topo.edgeTris[i]);
  }

  const compOf = new Int32Array(triCount);
  const rootToComp = new Map<number, number>();
  let next = 0;
  for (let t = 0; t < triCount; t++) {
    const root = uf.find(t);
    let comp = rootToComp.get(root);
    if (comp === undefined) {
      comp = next++;
      rootToComp.set(root, comp);
    }
    compOf[t] = comp;
  }
  return compOf;
}

function countBoundaryLoopsPerComponent(
  topo: MeshTopology,
  table: EdgeTable,
  compOf: Int32Array,
  compCount: number,
): Uint32Array {
  const loops = new Uint32Array(compCount);
  const boundary: number[] = [];
  for (let e = 0; e < table.count; e++) {
    if (table.flags[e] & EDGE_BOUNDARY) boundary.push(e);
  }
  if (boundary.length === 0) return loops;

  const adjacency = new Map<number, number[]>();
  const add = (vertex: number, edge: number) => {
    const list = adjacency.get(vertex);
    if (list) list.push(edge);
    else adjacency.set(vertex, [edge]);
  };
  for (const e of boundary) {
    add(table.v[e * 2], e);
    add(table.v[e * 2 + 1], e);
  }

  const visited = new Uint8Array(table.count);
  for (const firstEdge of boundary) {
    if (visited[firstEdge]) continue;
    visited[firstEdge] = 1;
    const t = table.tris[firstEdge * 2];
    const comp = compOf[t];

    const start = table.v[firstEdge * 2];
    let current = table.v[firstEdge * 2 + 1];
    let currentEdge = firstEdge;
    let guard = 0;
    while (current !== start && guard++ <= boundary.length + 1) {
      const list = adjacency.get(current);
      if (!list) break;
      let nextEdge = -1;
      for (const candidate of list) {
        if (candidate !== currentEdge && !visited[candidate]) {
          nextEdge = candidate;
          break;
        }
      }
      if (nextEdge < 0) break;
      visited[nextEdge] = 1;
      current =
        table.v[nextEdge * 2] === current ? table.v[nextEdge * 2 + 1] : table.v[nextEdge * 2];
      currentEdge = nextEdge;
    }
    loops[comp]++;
  }
  return loops;
}

function directionOf(indices: Uint32Array, t: number, a: number, b: number): number {
  const base = t * 3;
  for (let k = 0; k < 3; k++) {
    const x = indices[base + k];
    const y = indices[base + ((k + 1) % 3)];
    if (x === a && y === b) return 1;
    if (x === b && y === a) return 0;
  }
  return -1;
}

export function meshBounds(mesh: MeshData): Bounds {
  const p = mesh.positions;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  if (minX === Infinity) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

/** Divergence-theorem volume; positive when triangles are wound CCW outward. */
export function signedVolume(mesh: MeshData): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let volume6 = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    if (!finiteTriangle(p, a, b, c)) continue;
    volume6 += signedTet6(p, a, b, c);
  }
  return volume6 / 6;
}

export function surfaceArea(mesh: MeshData): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    if (!finiteTriangle(p, a, b, c)) continue;
    const ax = p[a * 3];
    const ay = p[a * 3 + 1];
    const az = p[a * 3 + 2];
    const ux = p[b * 3] - ax;
    const uy = p[b * 3 + 1] - ay;
    const uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax;
    const vy = p[c * 3 + 1] - ay;
    const vz = p[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    area += Math.hypot(nx, ny, nz) / 2;
  }
  return area;
}

export function countDegenerate(mesh: MeshData): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let count = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    if (a === b || b === c || a === c) {
      count++;
      continue;
    }
    if (!finiteTriangle(p, a, b, c)) {
      count++;
      continue;
    }
    const ax = p[a * 3];
    const ay = p[a * 3 + 1];
    const az = p[a * 3 + 2];
    const ux = p[b * 3] - ax;
    const uy = p[b * 3 + 1] - ay;
    const uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax;
    const vy = p[c * 3 + 1] - ay;
    const vz = p[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) * 0.5 < AREA_EPS) count++;
  }
  return count;
}

function finiteTriangle(p: Float32Array, a: number, b: number, c: number): boolean {
  return (
    Number.isFinite(p[a * 3]) &&
    Number.isFinite(p[a * 3 + 1]) &&
    Number.isFinite(p[a * 3 + 2]) &&
    Number.isFinite(p[b * 3]) &&
    Number.isFinite(p[b * 3 + 1]) &&
    Number.isFinite(p[b * 3 + 2]) &&
    Number.isFinite(p[c * 3]) &&
    Number.isFinite(p[c * 3 + 1]) &&
    Number.isFinite(p[c * 3 + 2])
  );
}

function signedTet6(p: Float32Array, a: number, b: number, c: number): number {
  const ax = p[a * 3];
  const ay = p[a * 3 + 1];
  const az = p[a * 3 + 2];
  const bx = p[b * 3];
  const by = p[b * 3 + 1];
  const bz = p[b * 3 + 2];
  const cx = p[c * 3];
  const cy = p[c * 3 + 1];
  const cz = p[c * 3 + 2];
  return ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
}
