/**
 * Canonical edge ordering — FROZEN CONTRACT between topology (workstream E)
 * and the bevel kernel (workstream B).
 *
 * Edge id = index of first encounter while walking triangles in index order,
 * each triangle contributing (a,b), (b,c), (c,a). Both sides must enumerate
 * edges exactly this way or selection ids point at the wrong geometry.
 *
 * Vertex ids are packed as `min * 2^21 + max`, so keys stay exact integers
 * below 2^53 while a mesh has fewer than 2^21 (2 097 152) vertices — roughly
 * four million triangles. Larger meshes are rejected explicitly rather than
 * silently colliding.
 */
export const VERTEX_LIMIT = 2 ** 21;

export function edgeKey(a: number, b: number): number {
  return a < b ? a * VERTEX_LIMIT + b : b * VERTEX_LIMIT + a;
}

export function keyA(key: number): number {
  return Math.floor(key / VERTEX_LIMIT);
}

export function keyB(key: number): number {
  return key - keyA(key) * VERTEX_LIMIT;
}

export interface EdgeOrder {
  keys: Float64Array;
  count: number;
}

/** Enumerate unique edges in canonical order. O(triangles), no allocations per edge. */
export function orderEdges(indices: Uint32Array, vertexCount: number): EdgeOrder {
  if (vertexCount > VERTEX_LIMIT) {
    throw new Error(
      `Mesh has ${vertexCount} vertices; the edge-id packing supports ${VERTEX_LIMIT}.`,
    );
  }

  const map = new Map<number, number>();
  const keys: number[] = [];

  const add = (u: number, v: number) => {
    // Degenerate triangles contribute a self-edge; skip it so this enumeration
    // matches the topology pass exactly.
    if (u === v) return;
    const k = u < v ? u * VERTEX_LIMIT + v : v * VERTEX_LIMIT + u;
    if (!map.has(k)) {
      map.set(k, keys.length);
      keys.push(k);
    }
  };

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    add(a, b);
    add(b, c);
    add(c, a);
  }

  return { keys: Float64Array.from(keys), count: keys.length };
}
