import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseStl } from '../io/stl';
import { edgeKey, keyA, keyB, orderEdges } from '../topo/edgeOrder';
import { analyzeParsedStl } from '../analyze';
import { DEFAULT_BEVEL, EDGE_CANDIDATE, EDGE_CONCAVE, EDGE_CONVEX, type MeshData } from '../types';
import { bevelMesh, initKernel, manifoldToMesh, meshToManifold, meshToStl } from './kernel';
import { buildTopology } from './topology';

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

/**
 * An L-shaped prism: [0,6]×[0,3] ∪ [0,3]×[0,6] extruded 10 mm. Its only
 * concave edge is the vertical at (3, 3), 10 mm long, with a 90° air wedge.
 * Volume = 27 mm² × 10 mm = 270 mm³.
 */
function lPrismMesh(): MeshData {
  const outline = [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]];
  const z0 = 0;
  const z1 = 10;
  const positions: number[] = [];
  for (const [x, y] of outline) positions.push(x, y, z0);
  for (const [x, y] of outline) positions.push(x, y, z1);
  const indices: number[] = [];
  const n = outline.length;
  // two quads split at the (0,0)-(3,3) diagonal, shared by both caps
  const top = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5];
  for (let t = 0; t < top.length; t += 3) {
    indices.push(top[t] + n, top[t + 1] + n, top[t + 2] + n);
    indices.push(top[t], top[t + 2], top[t + 1]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, j + n, i, j + n, i + n);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * A 20 mm cube whose top-front edge (y = z = 20) is split at x = 5, 10, 15.
 * The extra vertices are shared by the top and front faces, so the edge is a
 * real four-segment chain, not four independent edges.
 */
function segmentedBoxMesh(): MeshData {
  const s = 20;
  const p: number[] = [];
  const v = (x: number, y: number, z: number) => {
    p.push(x, y, z);
    return p.length / 3 - 1;
  };
  const b00 = v(0, 0, 0);
  const b10 = v(s, 0, 0);
  const b11 = v(s, s, 0);
  const b01 = v(0, s, 0);
  const t00 = v(0, 0, s);
  const t10 = v(s, 0, s);
  const t11 = v(s, s, s);
  const t01 = v(0, s, s);
  const topFront = [v(5, s, s), v(10, s, s), v(15, s, s)];
  const indices: number[] = [];
  const tri = (a: number, b: number, c: number) => indices.push(a, b, c);

  tri(b00, b01, b11);
  tri(b00, b11, b10);
  const topRing = [t00, t10, t11, ...topFront.slice().reverse(), t01];
  for (let i = 1; i < topRing.length - 1; i++) tri(topRing[0], topRing[i], topRing[i + 1]);
  const frontRing = [b01, t01, ...topFront, t11, b11];
  for (let i = 1; i < frontRing.length - 1; i++) tri(frontRing[0], frontRing[i], frontRing[i + 1]);
  tri(b00, b10, t10);
  tri(b00, t10, t00);
  tri(b00, t00, t01);
  tri(b00, t01, b01);
  tri(b10, b11, t11);
  tri(b10, t11, t10);
  return { positions: new Float32Array(p), indices: new Uint32Array(indices) };
}

function volumeOf(mesh: MeshData): number {
  const { positions: p, indices: idx } = mesh;
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    v +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return Math.abs(v);
}

/** Distance from the mesh's nearest vertex to `point`. */
function nearestVertex(mesh: MeshData, point: number[]): number {
  let best = Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    best = Math.min(
      best,
      Math.hypot(
        mesh.positions[i] - point[0],
        mesh.positions[i + 1] - point[1],
        mesh.positions[i + 2] - point[2],
      ),
    );
  }
  return best;
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

/** The hook as the app sees it: parsed and repaired. */
function loadHook(): MeshData {
  return loadAnalyzedHook().mesh;
}

/** Closed prism over a star-shaped, counter-clockwise polygon, z from 0 to h. */
function extrudeProfile(profile: number[][], h: number): MeshData {
  const n = profile.length;
  const positions: number[] = [];
  for (const [x, y] of profile) positions.push(x, y, 0);
  for (const [x, y] of profile) positions.push(x, y, h);
  let cx = 0;
  let cy = 0;
  for (const [x, y] of profile) {
    cx += x / n;
    cy += y / n;
  }
  const c0 = positions.length / 3;
  positions.push(cx, cy, 0);
  const c1 = positions.length / 3;
  positions.push(cx, cy, h);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(c0, j, i); // bottom, facing down
    indices.push(c1, n + i, n + j); // top, facing up
    indices.push(i, j, n + j, i, n + j, n + i); // side
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Boolean union through the kernel's own Manifold instance. */
function unionMeshes(a: MeshData, b: MeshData): MeshData {
  return manifoldToMesh(meshToManifold(a).add(meshToManifold(b)));
}

/**
 * 20 mm cube with a 10 mm cube removed at its (20, 20, 20) corner: three
 * concave edges meet at the inside corner (10, 10, 10).
 */
function notchedCubeMesh(): MeshData {
  const slab = extrudeProfile(
    [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ],
    10,
  );
  const ell = extrudeProfile(
    [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10, 20],
      [0, 20],
    ],
    10,
  );
  for (let i = 2; i < ell.positions.length; i += 3) ell.positions[i] += 10;
  return unionMeshes(slab, ell);
}

function loadAnalyzedHook() {
  const file = readFileSync(resolve(process.cwd(), 'public/fixtures/hook-base.stl'));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  return analyzeParsedStl(parseStl(buffer, 1e-4), 'hook-base.stl');
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

    // A bevel that ends at a corner runs into the end faces at full radius
    // (the CAD result), so the default rule matches the untapered volume.
    const ended = bevelMesh(cube, Uint32Array.of(edge), PARAMS);
    expect(ended.status).toBe('NoError');
    expect(Math.abs(ended.volumeAfter - 7981.23)).toBeLessThan(0.5);
    expect(Array.from(ended.endTapers!)).toEqual([0, 0]);
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

  it('bevels every convex hook candidate at the full requested width', () => {
    const hook = loadHook();
    const table = buildTestEdgeTable(hook);
    const edges = convexAtLeast(table, 20);
    expect(edges.length).toBe(68);

    const result = bevelMesh(hook, edges, HOOK_PARAMS);

    expect(result.status).toBe('NoError');
    expect(result.manifold).toBe(true);
    expect(result.shells).toBe(1);
    expect(result.selfIntersections).toBe(0);
    expect(result.warnings.some((w) => w.severity === 'error')).toBe(false);
    // No tessellation-driven clamp: a 0.1 mm sliver triangle next to a 45 mm
    // edge used to limit it to 0.05 mm.
    for (const width of result.appliedWidth) expect(width).toBeCloseTo(HOOK_PARAMS.width, 5);
    // Every fully selected corner gets a rolling-ball blend, including the
    // irregular plate/hook corner with its 3.3° extra crease.
    expect(result.corners).toBeGreaterThanOrEqual(14);
    // The hand-made Blender reference is 12 788.47 mm³.
    expect(Math.abs(result.volumeAfter - 12788.47)).toBeLessThan(40);
  });

  it('runs the outer hook rim through the plate corner without thinning', () => {
    const hook = loadHook();
    const table = buildTestEdgeTable(hook);
    const result = bevelMesh(hook, convexAtLeast(table, 20), {
      ...HOOK_PARAMS,
      width: 1,
      clampOverlap: true,
    });
    expect(result.manifold).toBe(true);
    expect(result.selfIntersections).toBe(0);

    // Original vertices of the top outer rim from the plate corner around the
    // bend. Each one is a sharp rim point that a continuous bevel removes.
    const rim = [
      [-32.735, -0.071, 35],
      [-32.712, -3.071, 35],
      [-32.507, -6.228, 35],
      [-31.946, -9.436, 35],
      [-31.022, -12.534, 35],
    ];
    for (const point of rim) expect(nearestVertex(result.mesh, point)).toBeGreaterThan(0.2);
    // The three-way corner is a round blend, not a point: a sphere of radius 1
    // keeps (√3 − 1) ≈ 0.73 mm away from a cube-like corner.
    expect(nearestVertex(result.mesh, [-32.735, -0.071, 35])).toBeGreaterThan(0.5);
  });

  it('bevels every sharp hook edge, inside and outside, at any width', () => {
    const analyzed = loadAnalyzedHook();
    const ids: number[] = [];
    for (let i = 0; i < analyzed.edges.count; i++) {
      if (analyzed.edges.dihedral[i] >= 20 && analyzed.edges.flags[i] & (EDGE_CONVEX | EDGE_CONCAVE)) ids.push(i);
    }
    expect(ids.length).toBe(71);
    for (const width of [0.3, 1, 2]) {
      const result = bevelMesh(analyzed.mesh, Uint32Array.from(ids), {
        ...HOOK_PARAMS,
        width,
        clampOverlap: true,
      });
      expect(result.manifold, "width " + width).toBe(true);
      expect(result.shells, "width " + width).toBe(1);
      expect(result.selfIntersections, "width " + width).toBe(0);
      expect(result.warnings.some((w) => w.code === 'bevel.fillet')).toBe(true);
    }
  });

  it('wraps the rim around an inside fillet at the wall junction', () => {
    const analyzed = loadAnalyzedHook();
    const ids: number[] = [];
    for (let i = 0; i < analyzed.edges.count; i++) {
      if (analyzed.edges.dihedral[i] >= 20 && analyzed.edges.flags[i] & (EDGE_CONVEX | EDGE_CONCAVE)) ids.push(i);
    }
    const result = bevelMesh(analyzed.mesh, Uint32Array.from(ids), { ...HOOK_PARAMS, width: 1, clampOverlap: true });
    expect(result.manifold).toBe(true);
    // The reflex top corner where the plate meets the wall: the fillet fills
    // it and the rim bevel follows the fillet, so no material is left at the
    // old sharp point and nothing sticks up above the cap.
    // With equal fillet and rim radii the rim's ball centre sits behind the
    // old corner, which therefore ends ≈ 0.2 mm below the rounded surface.
    const corner = [12.265, -0.071, 35];
    expect(nearestVertex(result.mesh, corner)).toBeGreaterThan(0.15);
    let maxZ = -Infinity;
    for (let i = 2; i < result.mesh.positions.length; i += 3) maxZ = Math.max(maxZ, result.mesh.positions[i]);
    expect(maxZ).toBeLessThan(35.01);
  });

  it('removes the 1 µm cap step at the wall junction during repair', () => {
    const analyzed = loadAnalyzedHook();
    const { edges } = analyzed;
    // The wall cap sits 0.001 mm above the plate cap. A sliver triangle used
    // to fill the step and read as a 90° concave edge across the flat top.
    for (let i = 0; i < edges.count; i++) {
      if (!(edges.flags[i] & EDGE_CONCAVE) || edges.dihedral[i] < 20) continue;
      const z0 = edges.position[i * 6 + 2];
      const z1 = edges.position[i * 6 + 5];
      const onTop = Math.abs(z0 - 35) < 0.01 && Math.abs(z1 - 35) < 0.01;
      const onBottom = Math.abs(z0) < 0.01 && Math.abs(z1) < 0.01;
      expect(onTop || onBottom).toBe(false);
    }
  });

  it('keeps the bevel band connected across the hook notch', () => {
    const hook = loadHook();
    const table = buildTestEdgeTable(hook);
    const edges = convexAtLeast(table, 20);
    const result = bevelMesh(hook, edges, HOOK_PARAMS);
    const mask = result.bevelFaces;
    expect(mask).toBeDefined();

    const p = result.mesh.positions;
    const idx = result.mesh.indices;
    const center = [12.1, 31.9, 34.8];
    const local = new Set<number>();
    for (let t = 0; t < idx.length / 3; t++) {
      if (mask![t] !== 1) continue;
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k] * 3;
        if (Math.hypot(p[v] - center[0], p[v + 1] - center[1], p[v + 2] - center[2]) < 2) {
          local.add(t);
          break;
        }
      }
    }
    // The bend chain, the short V and the long vertical edge all meet here.
    expect(local.size).toBeGreaterThan(50);

    const edgesOf = new Map<string, number[]>();
    for (const t of local) {
      for (let k = 0; k < 3; k++) {
        const a = idx[t * 3 + k];
        const b = idx[t * 3 + ((k + 1) % 3)];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const list = edgesOf.get(key);
        if (list) list.push(t);
        else edgesOf.set(key, [t]);
      }
    }
    const adj = new Map<number, number[]>();
    for (const list of edgesOf.values()) {
      if (list.length < 2) continue;
      for (const a of list) {
        for (const b of list) {
          if (a === b) continue;
          const next = adj.get(a);
          if (next) next.push(b);
          else adj.set(a, [b]);
        }
      }
    }
    const seen = new Set<number>();
    let components = 0;
    for (const start of local) {
      if (seen.has(start)) continue;
      components++;
      const stack = [start];
      seen.add(start);
      while (stack.length > 0) {
        const t = stack.pop()!;
        for (const next of adj.get(t) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
    }
    expect(components).toBe(1);
  });

  it('bevels a chain of four short edges continuously without dropping a segment', () => {
    const mesh = segmentedBoxMesh();
    const table = buildTestEdgeTable(mesh);
    const chain: number[] = [];
    for (let e = 0; e < table.count; e++) {
      const a = table.v[e * 2];
      const b = table.v[e * 2 + 1];
      if (
        Math.abs(mesh.positions[a * 3 + 1] - 20) < 1e-6 &&
        Math.abs(mesh.positions[b * 3 + 1] - 20) < 1e-6 &&
        Math.abs(mesh.positions[a * 3 + 2] - 20) < 1e-6 &&
        Math.abs(mesh.positions[b * 3 + 2] - 20) < 1e-6 &&
        table.dihedral[e] > 20
      ) {
        chain.push(e);
      }
    }
    // Four 5 mm segments; each is shorter than 4 × width = 8 mm.
    expect(chain.length).toBe(4);

    const result = bevelMesh(mesh, Uint32Array.from(chain), PARAMS, undefined, { taper: 'none' });

    expect(result.status).toBe('NoError');
    expect(result.manifold).toBe(true);
    expect(result.shells).toBe(1);
    for (const width of result.appliedWidth) expect(width).toBeCloseTo(2, 5);
    // A continuous 20 mm bevel removes the same material as one long edge; a
    // chain with gaps would remove less and leave the sharp line in place.
    expect(Math.abs(volumeOf(result.mesh) - 7981.23)).toBeLessThan(0.5);

    for (let i = 0; i < result.mesh.positions.length; i += 3) {
      const x = result.mesh.positions[i];
      const y = result.mesh.positions[i + 1];
      const z = result.mesh.positions[i + 2];
      if (x > 1e-3 && x < 20 - 1e-3) {
        expect(Math.abs(y - 20) < 1e-3 && Math.abs(z - 20) < 1e-3).toBe(false);
      }
    }
  });

  it('joins two 90° bevels at a corner instead of tapering to a sharp ridge', () => {
    const cube = cubeMesh(20);
    const table = buildTestEdgeTable(cube);
    const e1 = edgeBetween(table, cube, [20, 20, 20], [0, 20, 20]);
    const e2 = edgeBetween(table, cube, [20, 20, 20], [20, 0, 20]);

    const result = bevelMesh(cube, Uint32Array.of(e1, e2), PARAMS);

    expect(result.status).toBe('NoError');
    expect(result.manifold).toBe(true);
    expect(result.shells).toBe(1);
    expect(result.warnings.some((w) => w.severity === 'error')).toBe(false);

    // With the old per-edge taper both sweeps vanished at the shared vertex and
    // that sharp corner survived. A joined bevel removes it.
    expect(nearestVertex(result.mesh, [20, 20, 20])).toBeGreaterThan(0.5);
    let onRim = 0;
    for (let i = 0; i < result.mesh.positions.length; i += 3) {
      const x = result.mesh.positions[i];
      const y = result.mesh.positions[i + 1];
      const z = result.mesh.positions[i + 2];
      if (x > 0.5 && x < 19.5 && Math.abs(y - 20) < 1e-3 && Math.abs(z - 20) < 1e-3) onRim++;
      if (y > 0.5 && y < 19.5 && Math.abs(x - 20) < 1e-3 && Math.abs(z - 20) < 1e-3) onRim++;
    }
    expect(onRim).toBe(0);
  });

  it('adds the analytic fillet volume on a concave 90° edge', () => {
    const mesh = lPrismMesh();
    const table = buildTestEdgeTable(mesh);
    let concave = -1;
    for (let e = 0; e < table.count; e++) {
      if (table.convex[e] === 0) concave = e;
    }
    expect(concave).toBeGreaterThanOrEqual(0);

    const baseVolume = volumeOf(mesh);
    expect(baseVolume).toBeCloseTo(270, 6);
    const result = bevelMesh(
      mesh,
      Uint32Array.of(concave),
      { ...PARAMS, width: 1, segments: 8 },
      undefined,
      { taper: 'none' },
    );

    expect(result.status).toBe('NoError');
    expect(result.manifold).toBe(true);
    expect(result.shells).toBe(1);
    expect(result.warnings.some((w) => w.code === 'bevel.fillet')).toBe(true);
    expect(result.volumeAfter).toBeGreaterThan(result.volumeBefore);

    // r²(1 − π/4)·L = 2.146 mm³; the 8-chord arc approximates the quarter
    // circle from the material side, so the fill is ~2.3 % larger.
    const analytic = 1 * (1 - Math.PI / 4) * 10;
    const added = volumeOf(result.mesh) - baseVolume;
    expect(Math.abs(added - analytic)).toBeLessThan(analytic * 0.05);
  });

  it('marks added concave fillet faces in bevelFaces', () => {
    const mesh = lPrismMesh();
    const table = buildTestEdgeTable(mesh);
    let concave = -1;
    for (let e = 0; e < table.count; e++) {
      if (table.convex[e] === 0) concave = e;
    }
    const result = bevelMesh(
      mesh,
      Uint32Array.of(concave),
      { ...PARAMS, width: 1, segments: 8 },
      undefined,
      { taper: 'none' },
    );

    const triangles = result.mesh.indices.length / 3;
    const mask = result.bevelFaces;
    expect(mask).toBeDefined();
    expect(mask!.length).toBe(triangles);

    let band = 0;
    let base = 0;
    for (let t = 0; t < triangles; t++) {
      const a = result.mesh.indices[t * 3] * 3;
      const b = result.mesh.indices[t * 3 + 1] * 3;
      const c = result.mesh.indices[t * 3 + 2] * 3;
      const x = (result.mesh.positions[a] + result.mesh.positions[b] + result.mesh.positions[c]) / 3;
      const y =
        (result.mesh.positions[a + 1] + result.mesh.positions[b + 1] + result.mesh.positions[c + 1]) /
        3;
      if (mask![t] === 1) {
        band++;
        // The added fillet lives in the 1 mm × 1 mm corner at (3,3).
        expect(Math.hypot(x - 3, y - 3)).toBeLessThan(1.5);
      } else {
        base++;
      }
    }
    expect(band).toBeGreaterThan(0);
    expect(base).toBeGreaterThan(0);
  });

  it('mitres two rims at an inside corner without a spike', () => {
    // L-shaped prism: the top rims of the two inner walls meet at the reflex
    // corner (3, 3, 10). The inside vertical edge stays unselected. Each wall
    // is two triangles, so the wall the other rim runs along must still be
    // recognised as that rim's face, not as an end face that cuts this rim.
    const mesh = lPrismMesh();
    const table = buildTestEdgeTable(mesh);
    const rims = [
      edgeBetween(table, mesh, [6, 3, 10], [3, 3, 10]),
      edgeBetween(table, mesh, [3, 3, 10], [3, 6, 10]),
    ];
    const result = bevelMesh(mesh, Uint32Array.from(rims), { ...PARAMS, width: 1 });
    expect(result.manifold).toBe(true);
    expect(result.selfIntersections).toBe(0);
    // A clean miter removes the corner point; the old flat end cuts left it
    // standing as a spike between the two fillets.
    expect(nearestVertex(result.mesh, [3, 3, 10])).toBeGreaterThan(0.3);
  });

  it('limits one edge without shrinking the rest of the selection', () => {
    const cube = cubeMesh(20);
    const table = buildTestEdgeTable(cube);
    const all = convexAtLeast(table, 20);
    const limits = new Float32Array(table.count).fill(10);
    limits[all[0]] = 1; // only this edge is narrow

    const result = bevelMesh(cube, all, { ...PARAMS, width: 1.5, clampOverlap: true }, limits);
    expect(result.manifold).toBe(true);
    expect(result.appliedWidth[0]).toBeCloseTo(0.98, 5);
    const a = table.v[all[0] * 2];
    const b = table.v[all[0] * 2 + 1];
    for (let i = 1; i < all.length; i++) {
      const ends = [result.endWidths![i * 2], result.endWidths![i * 2 + 1]];
      const touches = [a, b].includes(table.v[all[i] * 2]) || [a, b].includes(table.v[all[i] * 2 + 1]);
      if (touches) {
        // a neighbour ramps from the narrow corner back up to the full width
        expect(Math.min(...ends)).toBeCloseTo(0.98, 5);
        expect(Math.max(...ends)).toBeCloseTo(1.5, 5);
      } else {
        expect(result.appliedWidth[i]).toBeCloseTo(1.5, 5);
      }
    }
  });

  it('bridges a 0.02 mm step in a rim instead of interrupting the bevel', () => {
    // 20 × 10 profile whose front face jogs out by 0.02 mm halfway along
    const mesh = extrudeProfile(
      [
        [0, 0],
        [10, 0],
        [10, -0.02],
        [20, -0.02],
        [20, 10],
        [0, 10],
      ],
      10,
    );
    const table = buildTestEdgeTable(mesh);
    const p = mesh.positions;
    const rim: number[] = [];
    for (let e = 0; e < table.count; e++) {
      const pa = table.v[e * 2] * 3;
      const pb = table.v[e * 2 + 1] * 3;
      if (p[pa + 2] === 10 && p[pb + 2] === 10 && p[pa + 1] <= 0 && p[pb + 1] <= 0 && table.dihedral[e] > 20) {
        rim.push(e);
      }
    }
    expect(rim.length).toBe(3);
    const result = bevelMesh(mesh, Uint32Array.from(rim), { ...PARAMS, width: 1, clampOverlap: true });
    expect(result.manifold).toBe(true);
    expect(result.selfIntersections).toBe(0);
    expect(result.warnings.some((w) => w.code === 'bevel.short')).toBe(true);
    // no sharp rim point survives along the front top edge
    const q = result.mesh.positions;
    for (let i = 0; i < q.length; i += 3) {
      if (q[i] > 0.5 && q[i] < 19.5 && Math.abs(q[i + 2] - 10) < 1e-3) expect(q[i + 1]).toBeGreaterThan(0.5);
    }
  });

  it('fades a chain that stops in the middle of a crease', () => {
    const mesh = segmentedBoxMesh();
    const table = buildTestEdgeTable(mesh);
    const p = mesh.positions;
    const chain: { e: number; x: number }[] = [];
    for (let e = 0; e < table.count; e++) {
      const a = table.v[e * 2] * 3;
      const b = table.v[e * 2 + 1] * 3;
      if (
        Math.abs(p[a + 1] - 20) < 1e-6 &&
        Math.abs(p[b + 1] - 20) < 1e-6 &&
        Math.abs(p[a + 2] - 20) < 1e-6 &&
        Math.abs(p[b + 2] - 20) < 1e-6 &&
        table.dihedral[e] > 20
      ) {
        chain.push({ e, x: (p[a] + p[b]) / 2 });
      }
    }
    chain.sort((u, v) => u.x - v.x);
    const result = bevelMesh(mesh, Uint32Array.of(chain[1].e, chain[2].e), { ...PARAMS, width: 1 });
    expect(result.manifold).toBe(true);
    // the outer ends fade out (the crease goes on unselected); the joint does not
    expect(Array.from(result.endTapers!).filter((t) => t === 1).length).toBe(2);
  });

  it('blends a concave three-face corner with an inside sphere', () => {
    const mesh = notchedCubeMesh();
    const table = buildTestEdgeTable(mesh);
    const concave: number[] = [];
    for (let e = 0; e < table.count; e++) if (table.convex[e] === 0) concave.push(e);
    expect(concave.length).toBe(3);

    const result = bevelMesh(mesh, Uint32Array.from(concave), { ...PARAMS, width: 2 });
    expect(result.manifold).toBe(true);
    expect(result.selfIntersections).toBe(0);
    expect(result.corners).toBe(1);
    expect(result.volumeAfter).toBeGreaterThan(result.volumeBefore);
    // the inside corner point is buried under the fillet
    expect(nearestVertex(result.mesh, [10, 10, 10])).toBeGreaterThan(0.5);
  });

  it('bevels every edge of a notched cube, mixing inside and outside', () => {
    const mesh = notchedCubeMesh();
    const table = buildTestEdgeTable(mesh);
    const sharp: number[] = [];
    for (let e = 0; e < table.count; e++) if (table.convex[e] === 0 || table.convex[e] === 1) sharp.push(e);
    for (const width of [0.5, 2]) {
      const result = bevelMesh(mesh, Uint32Array.from(sharp), { ...PARAMS, width, clampOverlap: true });
      expect(result.manifold, 'width ' + width).toBe(true);
      expect(result.shells, 'width ' + width).toBe(1);
      expect(result.selfIntersections, 'width ' + width).toBe(0);
    }
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
