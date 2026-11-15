import type { MeshData } from '../types';
import { edgeKey, VERTEX_LIMIT } from './edgeOrder';

/**
 * Half-edge-ish topology built once per mesh. Edge ids follow the frozen
 * `edgeOrder.ts` contract exactly: the id is assigned on first encounter while
 * walking triangles in index order, each triangle contributing (a,b), (b,c),
 * (c,a).
 *
 * The incidence arrays are CSR, not arrays of arrays: a 1 M triangle mesh has
 * ~1.5 M edges and 3 M incidences, and must not allocate per edge.
 */
export interface MeshTopology {
  vertexCount: number;
  triCount: number;
  edgeCount: number;
  /** Edge endpoints, min/max, 2 per edge. */
  edgeV: Uint32Array;
  /** CSR offsets into edgeTris/edgeCorner/edgeDir, length edgeCount + 1. */
  edgeOffset: Uint32Array;
  /** Triangle ids incident to each edge. */
  edgeTris: Uint32Array;
  /** Half-edge index (3 * tri + k) for each incidence. */
  edgeCorner: Uint32Array;
  /** 1 when the half-edge runs min -> max, 0 otherwise. */
  edgeDir: Uint8Array;
  /** Half-edge -> edge id, 3 per triangle; 0xffffffff for a skipped (a===b) edge. */
  halfEdgeEdge: Uint32Array;
  /** CSR offsets into vertexCorners, length vertexCount + 1. */
  vertexOffset: Uint32Array;
  /** Corner element ids (3 * tri + k) incident to each vertex. */
  vertexCorners: Uint32Array;
}

export function buildTopology(mesh: MeshData): MeshTopology {
  const { positions, indices } = mesh;
  const vertexCount = positions.length / 3;
  const triCount = indices.length / 3;

  if (vertexCount > VERTEX_LIMIT) {
    throw new Error(
      `Mesh has ${vertexCount} vertices; the edge-id packing supports ${VERTEX_LIMIT}.`,
    );
  }

  const edgeMap = new Map<number, number>();
  const edgeVList: number[] = [];
  const halfEdgeEdge = new Uint32Array(indices.length);

  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    for (let k = 0; k < 3; k++) {
      const he = base + k;
      const a = indices[he];
      const b = indices[base + ((k + 1) % 3)];
      if (a === b) {
        halfEdgeEdge[he] = 0xffffffff;
        continue;
      }
      const key = edgeKey(a, b);
      let e = edgeMap.get(key);
      if (e === undefined) {
        e = edgeVList.length >> 1;
        edgeMap.set(key, e);
        edgeVList.push(a < b ? a : b, a < b ? b : a);
      }
      halfEdgeEdge[he] = e;
    }
  }

  const edgeCount = edgeVList.length >> 1;
  const edgeV = new Uint32Array(edgeVList);

  const edgeCounts = new Uint32Array(edgeCount);
  for (let i = 0; i < halfEdgeEdge.length; i++) {
    const e = halfEdgeEdge[i];
    if (e !== 0xffffffff) edgeCounts[e]++;
  }

  const edgeOffset = new Uint32Array(edgeCount + 1);
  for (let e = 0; e < edgeCount; e++) edgeOffset[e + 1] = edgeOffset[e] + edgeCounts[e];

  const incidenceCount = edgeOffset[edgeCount];
  const edgeTris = new Uint32Array(incidenceCount);
  const edgeCorner = new Uint32Array(incidenceCount);
  const edgeDir = new Uint8Array(incidenceCount);
  const edgeCursor = edgeOffset.slice();

  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    for (let k = 0; k < 3; k++) {
      const he = base + k;
      const e = halfEdgeEdge[he];
      if (e === 0xffffffff) continue;
      const slot = edgeCursor[e]++;
      edgeTris[slot] = t;
      edgeCorner[slot] = he;
      edgeDir[slot] = indices[he] < indices[base + ((k + 1) % 3)] ? 1 : 0;
    }
  }

  const vertexOffset = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < indices.length; i++) vertexOffset[indices[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) vertexOffset[v + 1] += vertexOffset[v];

  const vertexCorners = new Uint32Array(indices.length);
  const vertexCursor = vertexOffset.slice();
  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    for (let k = 0; k < 3; k++) {
      const he = base + k;
      const v = indices[he];
      vertexCorners[vertexCursor[v]++] = he;
    }
  }

  return {
    vertexCount,
    triCount,
    edgeCount,
    edgeV,
    edgeOffset,
    edgeTris,
    edgeCorner,
    edgeDir,
    halfEdgeEdge,
    vertexOffset,
    vertexCorners,
  };
}
