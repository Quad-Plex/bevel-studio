import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMesh } from '../analyze';
import { parseStl } from '../io/stl';
import { buildEdgeTable } from './build';
import { keyA, keyB, orderEdges } from './edgeOrder';
import { EDGE_BOUNDARY, EDGE_CANDIDATE, EDGE_CONCAVE, EDGE_CONVEX, EDGE_CREASE, EDGE_NON_MANIFOLD } from '../types';
import type { EdgeTable, MeshData } from '../types';
import { makeCube, removeLastTriangles } from '../repair/testMeshes';

const FIXTURE_DIR = fileURLToPath(new URL('../../../public/fixtures/', import.meta.url));

function loadFixture(name: string) {
  const file = readFileSync(join(FIXTURE_DIR, name));
  const buffer = file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer;
  return parseStl(buffer);
}

function countFlags(flags: Uint8Array, mask: number): number {
  let count = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i] & mask) count++;
  return count;
}

/** O(E²) reference implementation of the maxWidth definition. */
function bruteForceMaxWidth(mesh: MeshData, table: EdgeTable): Float32Array {
  const edgeCount = table.count;
  const out = new Float32Array(edgeCount);
  const vertexCount = mesh.positions.length / 3;
  const length = new Float64Array(edgeCount);
  const mid = new Float64Array(edgeCount * 3);
  const vMin = new Float64Array(vertexCount);
  vMin.fill(Infinity);
  const vMinAny = new Float64Array(vertexCount);
  vMinAny.fill(Infinity);
  // mirrors the kernel's 0.05 mm micro-edge threshold in topo/build.ts
  const MIN_CLAMP_EDGE = 0.05;

  for (let e = 0; e < edgeCount; e++) {
    const a = table.v[e * 2];
    const b = table.v[e * 2 + 1];
    const ax = mesh.positions[a * 3];
    const ay = mesh.positions[a * 3 + 1];
    const az = mesh.positions[a * 3 + 2];
    const bx = mesh.positions[b * 3];
    const by = mesh.positions[b * 3 + 1];
    const bz = mesh.positions[b * 3 + 2];
    length[e] = Math.hypot(bx - ax, by - ay, bz - az);
    if (length[e] < vMinAny[a]) vMinAny[a] = length[e];
    if (length[e] < vMinAny[b]) vMinAny[b] = length[e];
    if (length[e] >= MIN_CLAMP_EDGE) {
      if (length[e] < vMin[a]) vMin[a] = length[e];
      if (length[e] < vMin[b]) vMin[b] = length[e];
    }
    mid[e * 3] = (ax + bx) * 0.5;
    mid[e * 3 + 1] = (ay + by) * 0.5;
    mid[e * 3 + 2] = (az + bz) * 0.5;
  }

  for (let e = 0; e < edgeCount; e++) {
    const a = table.v[e * 2];
    const b = table.v[e * 2 + 1];
    const aMin = Number.isFinite(vMin[a]) ? vMin[a] : vMinAny[a];
    const bMin = Number.isFinite(vMin[b]) ? vMin[b] : vMinAny[b];
    const incident = Math.min(aMin, bMin, length[e]);
    let best = 0.5 * incident;
    let bestDist2 = incident * incident;
    for (let f = 0; f < edgeCount; f++) {
      if (f === e) continue;
      const fa = table.v[f * 2];
      const fb = table.v[f * 2 + 1];
      if (fa === a || fa === b || fb === a || fb === b) continue;
      const dx = mid[f * 3] - mid[e * 3];
      const dy = mid[f * 3 + 1] - mid[e * 3 + 1];
      const dz = mid[f * 3 + 2] - mid[e * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestDist2) bestDist2 = d2;
    }
    if (bestDist2 < incident * incident) best = Math.min(best, 0.5 * Math.sqrt(bestDist2));
    out[e] = Math.min(10, Math.max(0, best));
  }
  return out;
}

describe('edge ids', () => {
  it('match orderEdges() exactly on a cube', () => {
    const mesh = makeCube(10);
    const order = orderEdges(mesh.indices, mesh.positions.length / 3);
    const table = buildEdgeTable(mesh);
    expect(table.count).toBe(order.count);
    for (let e = 0; e < order.count; e++) {
      const key = order.keys[e];
      expect(table.v[e * 2]).toBe(keyA(key));
      expect(table.v[e * 2 + 1]).toBe(keyB(key));
    }
  });

  it('match orderEdges() exactly on hook-base.stl', () => {
    const parsed = loadFixture('hook-base.stl');
    const order = orderEdges(parsed.mesh.indices, parsed.mesh.positions.length / 3);
    const table = buildEdgeTable(parsed.mesh);
    expect(table.count).toBe(210);
    expect(table.count).toBe(order.count);
    for (let e = 0; e < order.count; e++) {
      const key = order.keys[e];
      expect(table.v[e * 2]).toBe(keyA(key));
      expect(table.v[e * 2 + 1]).toBe(keyB(key));
    }
  });
});

describe('cube classification', () => {
  it('reports 12 convex, 0 concave, 12 candidates and 12 creases', () => {
    const table = buildEdgeTable(makeCube(10));
    expect(table.count).toBe(18);
    expect(countFlags(table.flags, EDGE_CONVEX)).toBe(12);
    expect(countFlags(table.flags, EDGE_CONCAVE)).toBe(0);
    expect(countFlags(table.flags, EDGE_CANDIDATE)).toBe(12);
    expect(countFlags(table.flags, EDGE_CREASE)).toBe(12);
    expect(countFlags(table.flags, EDGE_BOUNDARY)).toBe(0);
    expect(countFlags(table.flags, EDGE_NON_MANIFOLD)).toBe(0);

    for (let e = 0; e < table.count; e++) {
      expect(table.tris[e * 2]).toBeLessThan(12);
      expect(table.tris[e * 2 + 1]).toBeLessThan(12);
      if (table.flags[e] & EDGE_CONVEX) {
        expect(table.dihedral[e]).toBeCloseTo(90, 5);
      } else {
        // The six face diagonals are coplanar.
        expect(table.dihedral[e]).toBeCloseTo(0, 5);
      }
    }
  });

  it('uses the exact per-edge maxWidth formula, not a global minimum', () => {
    const table = buildEdgeTable(makeCube(10));
    const distinct = [...new Set(Array.from(table.maxWidth, (value) => value.toFixed(4)))].sort();
    // 12 cube edges: half the nearest non-incident midpoint distance (5 or
    // 2.5·√3); 6 face diagonals: 2.5·√2. All are bounded by the incident-edge
    // term 0.5 × 10 = 5.
    expect(distinct).toEqual(['3.5355', '4.3301', '5.0000']);
    for (let e = 0; e < table.count; e++) {
      expect(Number.isFinite(table.maxWidth[e])).toBe(true);
      expect(table.maxWidth[e]).toBeGreaterThanOrEqual(0);
      expect(table.maxWidth[e]).toBeLessThanOrEqual(10);
    }
  });
});

describe('maxWidth reference', () => {
  it('matches a brute-force implementation on a cube', () => {
    const mesh = makeCube(10);
    const table = buildEdgeTable(mesh);
    const expected = bruteForceMaxWidth(mesh, table);
    for (let e = 0; e < table.count; e++) {
      expect(table.maxWidth[e]).toBeCloseTo(expected[e], 5);
    }
  });

  it('matches a brute-force implementation on hook-base.stl', () => {
    const parsed = loadFixture('hook-base.stl');
    const table = buildEdgeTable(parsed.mesh);
    const expected = bruteForceMaxWidth(parsed.mesh, table);
    expect(table.count).toBe(210);
    for (let e = 0; e < table.count; e++) {
      expect(table.maxWidth[e]).toBeCloseTo(expected[e], 5);
    }
  });
});

describe('hook maxWidth', () => {
  it('does not let a 0.001 mm tessellation edge clamp a 34 mm chain edge', () => {
    const parsed = loadFixture('hook-base.stl');
    const table = buildEdgeTable(parsed.mesh);
    let checked = 0;
    for (let e = 0; e < table.count; e++) {
      const a = table.v[e * 2] * 3;
      const b = table.v[e * 2 + 1] * 3;
      const length = Math.hypot(
        parsed.mesh.positions[b] - parsed.mesh.positions[a],
        parsed.mesh.positions[b + 1] - parsed.mesh.positions[a + 1],
        parsed.mesh.positions[b + 2] - parsed.mesh.positions[a + 2],
      );
      // The plate-notch rim edge is adjacent to the 0.001 mm collapsed edge.
      if (Math.abs(length - 34.308) < 0.01) {
        expect(table.maxWidth[e]).toBeGreaterThan(0.2);
        checked++;
      }
    }
    expect(checked).toBe(1);
  });

  it('is per edge and never collapses to the global minimum', () => {
    const parsed = loadFixture('hook-base.stl');
    const result = analyzeMesh(parsed.mesh, 'hook-base.stl');
    const widths = Array.from(result.edges.maxWidth).sort((a, b) => a - b);
    const min = widths[0];
    const median = widths[Math.floor(widths.length / 2)];
    const max = widths[widths.length - 1];

    for (const width of widths) {
      expect(Number.isFinite(width)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(0);
      expect(width).toBeLessThanOrEqual(10);
    }
    expect(new Set(widths.map((value) => value.toFixed(6))).size).toBeGreaterThan(10);
    expect(median).toBeGreaterThan(0.5);
    expect(max).toBeGreaterThan(1.5);
    // Sliver collapse removed the 0.001 mm wall that used to make the global
    // minimum ~100x smaller than the maximum; the spread remains per edge.
    expect(min).toBeLessThan(0.1);
    expect(max).toBeGreaterThan(min * 20);
  });

  it('has no NaN widths on the reference mesh', () => {
    const parsed = loadFixture('hook-reference.stl');
    const result = analyzeMesh(parsed.mesh, 'hook-reference.stl');
    for (let e = 0; e < result.edges.count; e++) {
      expect(Number.isFinite(result.edges.maxWidth[e])).toBe(true);
      expect(result.edges.maxWidth[e]).toBeGreaterThanOrEqual(0);
      expect(result.edges.maxWidth[e]).toBeLessThanOrEqual(10);
    }
  });
});

describe('boundary and non-manifold flags', () => {
  it('marks the three boundary edges of a triangle hole', () => {
    const table = buildEdgeTable(removeLastTriangles(makeCube(10), 1));
    expect(countFlags(table.flags, EDGE_BOUNDARY)).toBe(3);
    for (let e = 0; e < table.count; e++) {
      if (table.flags[e] & EDGE_BOUNDARY) {
        expect(table.tris[e * 2 + 1]).toBe(0xffffffff);
        expect(table.flags[e] & EDGE_CONVEX).toBe(0);
        expect(table.flags[e] & EDGE_CONCAVE).toBe(0);
      }
    }
  });

  it('flags a third face on an edge as non-manifold', () => {
    const cube = makeCube(10);
    const indices = new Uint32Array(cube.indices.length + 3);
    indices.set(cube.indices);
    indices.set(cube.indices.subarray(0, 3), cube.indices.length);
    const table = buildEdgeTable({ positions: cube.positions, indices });
    expect(countFlags(table.flags, EDGE_NON_MANIFOLD)).toBe(3);
    for (let e = 0; e < table.count; e++) {
      if (table.flags[e] & EDGE_NON_MANIFOLD) {
        expect(table.flags[e] & EDGE_CONVEX).toBe(0);
        expect(table.flags[e] & EDGE_CONCAVE).toBe(0);
        expect(table.tris[e * 2]).toBeLessThan(13);
        expect(table.tris[e * 2 + 1]).toBeLessThan(13);
      }
    }
  });
});
