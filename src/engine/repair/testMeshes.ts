import type { MeshData } from '../types';

/**
 * Synthetic meshes for the repair/topology tests. These are deliberately
 * small and readable; the fixture STLs are the real-world reference.
 */
export function makeCube(
  size = 10,
  offset: [number, number, number] = [0, 0, 0],
): MeshData {
  const [ox, oy, oz] = offset;
  const positions = new Float32Array([
    ox, oy, oz,
    ox + size, oy, oz,
    ox + size, oy + size, oz,
    ox, oy + size, oz,
    ox, oy, oz + size,
    ox + size, oy, oz + size,
    ox + size, oy + size, oz + size,
    ox, oy + size, oz + size,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom -Z
    4, 5, 6, 4, 6, 7, // top +Z
    0, 1, 5, 0, 5, 4, // front -Y
    3, 7, 6, 3, 6, 2, // back +Y
    0, 4, 7, 0, 7, 3, // left -X
    1, 2, 6, 1, 6, 5, // right +X
  ]);
  return { positions, indices };
}

/** Reverse every triangle's winding. */
export function invertMesh(mesh: MeshData): MeshData {
  const indices = mesh.indices.slice();
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1];
    indices[t + 1] = indices[t + 2];
    indices[t + 2] = tmp;
  }
  return { positions: mesh.positions.slice(), indices };
}

/** Reverse one triangle's winding, leaving the rest consistent. */
export function flipTriangle(mesh: MeshData, triangle: number): MeshData {
  const indices = mesh.indices.slice();
  const base = triangle * 3;
  const tmp = indices[base + 1];
  indices[base + 1] = indices[base + 2];
  indices[base + 2] = tmp;
  return { positions: mesh.positions.slice(), indices };
}

/** Concatenate two meshes, offsetting the second mesh's vertex ids. */
export function combineMeshes(a: MeshData, b: MeshData): MeshData {
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  const offset = a.positions.length / 3;
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i] + offset;
  }
  return { positions, indices };
}

/** Triangle soup: every corner gets its own vertex. */
export function duplicateVertices(mesh: MeshData): MeshData {
  const triCount = mesh.indices.length / 3;
  const positions = new Float32Array(mesh.indices.length * 3);
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const src = mesh.indices[t * 3 + k] * 3;
      const dst = t * 9 + k * 3;
      positions[dst] = mesh.positions[src];
      positions[dst + 1] = mesh.positions[src + 1];
      positions[dst + 2] = mesh.positions[src + 2];
      indices[t * 3 + k] = t * 3 + k;
    }
  }
  return { positions, indices };
}

/** Remove the last `triangles` triangles, preserving the rest. */
export function removeLastTriangles(mesh: MeshData, triangles: number): MeshData {
  const indices = mesh.indices.slice(0, mesh.indices.length - triangles * 3);
  return { positions: mesh.positions.slice(), indices };
}

/** Flat triangulated grid: nx * ny * 2 triangles, shared vertices. */
export function makeGrid(nx: number, ny: number): MeshData {
  const positions = new Float32Array((nx + 1) * (ny + 1) * 3);
  for (let y = 0; y <= ny; y++) {
    for (let x = 0; x <= nx; x++) {
      const i = (y * (nx + 1) + x) * 3;
      positions[i] = x;
      positions[i + 1] = y;
      positions[i + 2] = 0;
    }
  }
  const indices = new Uint32Array(nx * ny * 6);
  let w = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const a = y * (nx + 1) + x;
      const b = a + 1;
      const c = a + (nx + 1);
      const d = c + 1;
      indices[w++] = a;
      indices[w++] = b;
      indices[w++] = c;
      indices[w++] = b;
      indices[w++] = d;
      indices[w++] = c;
    }
  }
  return { positions, indices };
}
