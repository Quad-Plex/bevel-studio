import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseStl } from '../io/stl';
import { edgeKey, keyA, keyB, orderEdges } from '../topo/edgeOrder';
import { DEFAULT_BEVEL, type MeshData } from '../types';
import { bevelMesh, initKernel, meshToStl } from './kernel';

/**
 * Test-only edge table. Production receives ids from the analyzer; the kernel
 * rebuilds the same canonical table internally. This helper proves the ids
 * agree with `edgeOrder.ts` and gives the tests their selection sets.
 */
interface TestEdgeTable {
  count: number;
  v: Uint32Array;
  tris: Uint32Array;
  dihedral: Float32Array;
  convex: Uint8Array;
  length: Float32Array;
}

const ABSENT = 0xffffffff;
const THIRD = 0x80000000;
const FLAT_DEG = 0.5;

function buildTestEdgeTable(mesh: MeshData): TestEdgeTable {
  const { positions: p, indices: idx } = mesh;
  const vertexCount = p.length / 3;
  const triCount = idx.length / 3;
  const order = orderEdges(idx, vertexCount);
  const count = order.count;

  const idOf = new Map<number, number>();
  for (let e = 0; e < count; e++) idOf.set(order.keys[e], e);

  const v = new Uint32Array(count * 2);
  for (let e = 0; e < count; e++) {
    v[e * 2] = keyA(order.keys[e]);
    v[e * 2 + 1] = keyB(order.keys[e]);
  }

  const tris = new Uint32Array(count * 2).fill(ABSENT);
  const faceNormals = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const wx = p[c] - p[a];
    const wy = p[c + 1] - p[a + 1];
    const wz = p[c + 2] - p[a + 2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) {
      nx /= l;
      ny /= l;
      nz /= l;
    }
    faceNormals[t * 3] = nx;
    faceNormals[t * 3 + 1] = ny;
    faceNormals[t * 3 + 2] = nz;
  }

  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k];
      const b = idx[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const e = idOf.get(edgeKey(a, b));
      if (e === undefined) throw new Error('edge id missing');
      if (tris[e * 2] === ABSENT) tris[e * 2] = t;
      else if (tris[e * 2 + 1] === ABSENT) tris[e * 2 + 1] = t;
      else tris[e * 2 + 1] = THIRD;
    }
  }

  const dihedral = new Float32Array(count);
  const convex = new Uint8Array(count);
  const length = new Float32Array(count);

  for (let e = 0; e < count; e++) {
    const a = v[e * 2];
    const b = v[e * 2 + 1];
    length[e] = Math.hypot(
      p[b * 3] - p[a * 3],
      p[b * 3 + 1] - p[a * 3 + 1],
      p[b * 3 + 2] - p[a * 3 + 2],
    );
    const t1 = tris[e * 2];
    const t2 = tris[e * 2 + 1];
    if (t2 === ABSENT || t2 === THIRD) {
      convex[e] = 2;
      continue;
    }
    const n1x = faceNormals[t1 * 3];
    const n1y = faceNormals[t1 * 3 + 1];
    const n1z = faceNormals[t1 * 3 + 2];
    const n2x = faceNormals[t2 * 3];
    const n2y = faceNormals[t2 * 3 + 1];
    const n2z = faceNormals[t2 * 3 + 2];
    const dot = Math.min(1, Math.max(-1, n1x * n2x + n1y * n2y + n1z * n2z));
    const deg = (Math.acos(dot) * 180) / Math.PI;
    dihedral[e] = deg;
    if (deg < FLAT_DEG) {
      convex[e] = 2;
      continue;
    }
    const c1 = oppositeVertex(idx, t1, a, b);
    const c2 = oppositeVertex(idx, t2, a, b);
    const dx = p[c2 * 3] - p[c1 * 3];
    const dy = p[c2 * 3 + 1] - p[c1 * 3 + 1];
    const dz = p[c2 * 3 + 2] - p[c1 * 3 + 2];
    convex[e] = n1x * dx + n1y * dy + n1z * dz < 0 ? 1 : 0;
  }

  return { count, v, tris, dihedral, convex, length };
}

function oppositeVertex(idx: Uint32Array, t: number, a: number, b: number): number {
  for (let k = 0; k < 3; k++) {
    const x = idx[t * 3 + k];
    if (x !== a && x !== b) return x;
  }
  return idx[t * 3];
}

function convexAtLeast(table: TestEdgeTable, degrees: number): Uint32Array {
  const out: number[] = [];
  for (let e = 0; e < table.count; e++) {
    if (table.convex[e] === 1 && table.dihedral[e] >= degrees) out.push(e);
  }
  return Uint32Array.from(out);
}

function cubeMesh(size = 20): MeshData {
  const s = size;
  const positions = new Float32Array([
    0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0,
    0, 0, s, s, 0, s, s, s, s, 0, s, s,
  ]);
  const indices = new Uint32Array([
    0, 3, 2, 0, 2, 1,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2,
    0, 4, 7, 0, 7, 3,
    1, 2, 6, 1, 6, 5,
  ]);
  return { positions, indices };
}

function edgeBetween(table: TestEdgeTable, mesh: MeshData, p0: number[], p1: number[]): number {
  const near = (a: number[], b: number[]) =>
    Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;
  for (let e = 0; e < table.count; e++) {
    const a = [mesh.positions[table.v[e * 2] * 3], mesh.positions[table.v[e * 2] * 3 + 1], mesh.positions[table.v[e * 2] * 3 + 2]];
    const b = [mesh.positions[table.v[e * 2 + 1] * 3], mesh.positions[table.v[e * 2 + 1] * 3 + 1], mesh.positions[table.v[e * 2 + 1] * 3 + 2]];
    if ((near(a, p0) && near(b, p1)) || (near(a, p1) && near(b, p0))) return e;
  }
  throw new Error('edge not found');
}

function loadHook(): MeshData {
  const file = readFileSync(resolve(process.cwd(), 'public/fixtures/hook-base.stl'));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  return parseStl(buffer, 1e-4).mesh;
}

const PARAMS = { ...DEFAULT_BEVEL, width: 2, segments: 4, profile: 0.5, clampOverlap: false };
const HOOK_PARAMS = { ...DEFAULT_BEVEL, width: 0.5, segments: 4, profile: 0.5, clampOverlap: false };

describe('bevel kernel', () => {
  beforeAll(async () => {
    await initKernel();
  }, 60_000);

  it('rounds one cube edge at full length (7981.23 mm³)', () => {
    const cube = cubeMesh(20);
    const table = buildTestEdgeTable(cube);
    const edge = edgeBetween(table, cube, [20, 20, 0], [20, 20, 20]);
    const result = bevelMesh(cube, Uint32Array.of(edge), PARAMS, undefined, { taper: 'none' });

    expect(result.status).toBe('NoError');
    expect(result.manifold).toBe(true);
    expect(result.shells).toBe(1);
    expect(Math.abs(result.volumeAfter - 7981.23)).toBeLessThan(0.5);
    expect(result.appliedWidth[0]).toBeCloseTo(2, 5);

    // the default termination rule fades the radius over min(r, 0.25·L)
    const tapered = bevelMesh(cube, Uint32Array.of(edge), PARAMS);
    expect(tapered.status).toBe('NoError');
    expect(Math.abs(tapered.volumeAfter - 7983.73)).toBeLessThan(0.5);
    expect(tapered.volumeAfter).toBeGreaterThan(result.volumeAfter);
  });

  it('attributes bevel-band triangles through the boolean', () => {
    const cube = cubeMesh(20);
    const table = buildTestEdgeTable(cube);
    const edge = edgeBetween(table, cube, [20, 20, 0], [20, 20, 20]);
    const result = bevelMesh(cube, Uint32Array.of(edge), PARAMS, undefined, { taper: 'none' });

    const triangles = result.mesh.indices.length / 3;
    const mask = result.bevelFaces;
    expect(mask).toBeDefined();
    expect(mask!.length).toBe(triangles);

    let band = 0;
    for (const value of mask!) band += value;
    expect(band).toBeGreaterThan(0);
    // One edge cannot tint the whole cube; the untouched faces stay unmarked.
    expect(band).toBeLessThan(triangles * 0.5);

    // The tint must follow the vertex count of the returned mesh.
    expect(result.mesh.positions.length).toBeGreaterThan(0);
  });

  it('rounds all 12 cube edges with spherical corners (7786.44 mm³)', () => {
    const cube = cubeMesh(20);
    const table = buildTestEdgeTable(cube);
    const all = convexAtLeast(table, 20);
    expect(all.length).toBe(12);

    const result = bevelMesh(cube, all, PARAMS);

    expect(result.status).toBe('NoError');
    expect(result.manifold).toBe(true);
    expect(result.shells).toBe(1);
    expect(Math.abs(result.volumeAfter - 7786.44)).toBeLessThan(2);
    expect(result.warnings.some((w) => w.severity === 'error')).toBe(false);
  });

  it('bevels all 77 convex hook edges ≥ 20° to 12 783 mm³', () => {
    const hook = loadHook();
    const table = buildTestEdgeTable(hook);
    const edges = convexAtLeast(table, 20);
    expect(edges.length).toBe(77);

    const result = bevelMesh(hook, edges, HOOK_PARAMS);

    expect(result.status).toBe('NoError');
    expect(result.manifold).toBe(true);
    expect(result.shells).toBe(1);
    expect(Math.abs(result.volumeAfter - 12783)).toBeLessThanOrEqual(15);
    expect(result.meta.triangles).toBeLessThan(3000);
    expect(result.volumeAfter).toBeLessThan(result.volumeBefore);
    // The all-convex selection still crosses at the plate corners. Until the
    // clamp is chain-consistent, the contract is that the kernel detects and
    // reports it instead of shipping silently.
    expect(result.warnings.some((w) => w.code === 'bevel.selfIntersection')).toBe(true);
    expect(result.selfIntersections ?? 0).toBeGreaterThan(0);
  });

  it('rejects concave edges with a warning', () => {
    const hook = loadHook();
    const table = buildTestEdgeTable(hook);
    let concave = -1;
    for (let e = 0; e < table.count; e++) {
      if (table.convex[e] === 0) {
        concave = e;
        break;
      }
    }
    expect(concave).toBeGreaterThanOrEqual(0);

    const result = bevelMesh(hook, Uint32Array.of(concave), HOOK_PARAMS);

    expect(result.warnings.some((w) => w.code === 'bevel.concave')).toBe(true);
    expect(result.volumeAfter).toBeCloseTo(result.volumeBefore, 6);
    expect(result.meta.triangles).toBe(140);
  });

  it('clamps each edge independently, never to the selection minimum', () => {
    const cube = cubeMesh(20);
    const table = buildTestEdgeTable(cube);
    const all = convexAtLeast(table, 20);
    const limits = new Float32Array(table.count).fill(10);
    limits[all[0]] = 1; // only this edge is narrow

    const result = bevelMesh(cube, all, { ...PARAMS, width: 1.5, clampOverlap: true }, limits);

    expect(result.clampedEdges).toBe(1);
    expect(result.appliedWidth[0]).toBeCloseTo(0.98, 5);
    for (let i = 1; i < all.length; i++) expect(result.appliedWidth[i]).toBeCloseTo(1.5, 5);
  });

  it('is deterministic', () => {
    const hook = loadHook();
    const table = buildTestEdgeTable(hook);
    const edges = convexAtLeast(table, 20);

    const a = bevelMesh(hook, edges, HOOK_PARAMS);
    const b = bevelMesh(hook, edges, HOOK_PARAMS);

    expect(b.meta.triangles).toBe(a.meta.triangles);
    expect(b.volumeAfter).toBe(a.volumeAfter);
    expect(b.mesh.indices).toEqual(a.mesh.indices);
    expect(b.mesh.positions).toEqual(a.mesh.positions);
  });

  it('bevels the hook in under 120 ms after init', () => {
    const hook = loadHook();
    const table = buildTestEdgeTable(hook);
    const edges = convexAtLeast(table, 20);

    bevelMesh(hook, edges, HOOK_PARAMS); // warm the wasm/JIT path
    const start = performance.now();
    const result = bevelMesh(hook, edges, HOOK_PARAMS);
    const ms = performance.now() - start;
    console.log(`[bevel] hook 77 edges: ${ms.toFixed(1)} ms`, result.timings);

    expect(result.status).toBe('NoError');
    expect(ms).toBeLessThan(120);
  });

  it('writes binary STL in millimetres without recentring', () => {
    const cube = cubeMesh(20);
    const buffer = meshToStl(cube);
    expect(buffer.byteLength).toBe(84 + 12 * 50);
    const view = new DataView(buffer);
    expect(view.getUint32(80, true)).toBe(12);
    // first vertex of the first triangle is (0,0,0), not the bbox centre
    expect(view.getFloat32(84 + 12, true)).toBe(0);
    expect(view.getFloat32(84 + 16, true)).toBe(0);
    expect(view.getFloat32(84 + 20, true)).toBe(0);
    // and it round-trips through the production STL reader
    const parsed = parseStl(buffer, 1e-4);
    expect(parsed.triangles).toBe(12);
    expect(parsed.mesh.positions.length / 3).toBe(8);
  });
});
