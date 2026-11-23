import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMesh, analyzeParsedStl } from './analyze';
import { parseStl } from './io/stl';
import { signedVolume } from './meta';
import { EDGE_CANDIDATE, EDGE_CONCAVE, EDGE_CONVEX } from './types';
import {
  combineMeshes,
  duplicateVertices,
  flipTriangle,
  invertMesh,
  makeCube,
  makeGrid,
  removeLastTriangles,
} from './repair/testMeshes';

const FIXTURE_DIR = fileURLToPath(new URL('../../public/fixtures/', import.meta.url));

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

describe('hook-base.stl', () => {
  it('matches the measured reference numbers', () => {
    const parsed = loadFixture('hook-base.stl');
    expect(parsed.format).toBe('binary');
    expect(parsed.triangles).toBe(140);
    expect(parsed.mesh.positions.length / 3).toBe(72);
    expect(parsed.weldedVertices).toBe(348);

    const result = analyzeMesh(parsed.mesh, 'hook-base.stl');
    // R1b collapses the 0.02 mm-wide, 35 mm-long wall at the notch.
    expect(result.meta.triangles).toBe(126);
    expect(result.meta.vertices).toBe(65);
    expect(result.meta.edges).toBe(189);
    expect(result.edges.count).toBe(189);

    expect(countFlags(result.edges.flags, EDGE_CONVEX)).toBe(79);
    // R8 flips the 1 µm cap step at the wall junction: its fake concave edge
    // across the flat top is gone (13 → 12).
    expect(countFlags(result.edges.flags, EDGE_CONCAVE)).toBe(12);
    expect(countFlags(result.edges.flags, EDGE_CANDIDATE)).toBe(68);

    expect(Math.abs(result.meta.volume - 12871.36)).toBeLessThanOrEqual(0.05);
    expect(result.meta.bbox.size[0]).toBeCloseTo(47.88, 2);
    expect(result.meta.bbox.size[1]).toBeCloseTo(62.15, 2);
    expect(result.meta.bbox.size[2]).toBeCloseTo(35.0, 2);

    expect(result.meta.watertight).toBe(true);
    expect(result.meta.shells).toBe(1);
    expect(result.meta.genus).toBe(0);
    expect(result.meta.boundaryEdges).toBe(0);
    expect(result.meta.nonManifoldEdges).toBe(0);
    expect(result.meta.degenerateTriangles).toBe(0);
    expect(result.meta.flippedTriangles).toBe(0);
    expect(result.repairs.map((record) => record.code)).toEqual(['sliver']);
    expect(result.repairs[0].count).toBe(15);
    expect(result.warnings).toEqual([]);
  });

  it('reports the parse-time weld through analyzeParsedStl', () => {
    const parsed = loadFixture('hook-base.stl');
    const result = analyzeParsedStl(parsed, 'hook-base.stl');
    const weld = result.repairs.find((record) => record.code === 'weld');
    expect(weld?.count).toBe(348);
    expect(weld?.detail).toContain('welded 348');
  });
});

describe('hook-reference.stl', () => {
  it('is watertight with the measured volume and topology', () => {
    const parsed = loadFixture('hook-reference.stl');
    expect(parsed.format).toBe('binary');
    expect(parsed.triangles).toBe(654);
    expect(parsed.mesh.positions.length / 3).toBe(329);

    const result = analyzeMesh(parsed.mesh, 'hook-reference.stl');
    expect(result.meta.triangles).toBe(650);
    expect(result.meta.vertices).toBe(327);
    expect(result.meta.edges).toBe(975);
    expect(result.edges.count).toBe(975);
    expect(countFlags(result.edges.flags, EDGE_CONVEX)).toBe(580);
    expect(countFlags(result.edges.flags, EDGE_CONCAVE)).toBe(175);
    expect(Math.abs(result.meta.volume - 12788.03)).toBeLessThanOrEqual(0.05);
    expect(result.meta.watertight).toBe(true);
    expect(result.meta.shells).toBe(1);
    expect(result.meta.genus).toBe(0);
    expect(result.meta.boundaryEdges).toBe(0);
    expect(result.meta.nonManifoldEdges).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});

describe('synthetic cube', () => {
  it('is classified as 12 convex edges, 0 concave, 12 candidates', () => {
    const result = analyzeMesh(makeCube(10), 'cube');
    expect(result.meta.triangles).toBe(12);
    expect(result.meta.vertices).toBe(8);
    expect(result.meta.edges).toBe(18);
    expect(result.edges.count).toBe(18);

    expect(countFlags(result.edges.flags, EDGE_CONVEX)).toBe(12);
    expect(countFlags(result.edges.flags, EDGE_CONCAVE)).toBe(0);
    expect(countFlags(result.edges.flags, EDGE_CANDIDATE)).toBe(12);

    expect(result.meta.volume).toBeCloseTo(1000, 6);
    expect(result.meta.area).toBeCloseTo(600, 6);
    expect(result.meta.bbox.size[0]).toBeCloseTo(10, 6);
    expect(result.meta.bbox.size[1]).toBeCloseTo(10, 6);
    expect(result.meta.bbox.size[2]).toBeCloseTo(10, 6);
    expect(result.meta.watertight).toBe(true);
    expect(result.meta.shells).toBe(1);
    expect(result.meta.genus).toBe(0);
    expect(result.meta.flippedTriangles).toBe(0);
    expect(result.meta.degenerateTriangles).toBe(0);
    expect(result.repairs).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('repairs an inverted cube to positive volume', () => {
    const result = analyzeMesh(invertMesh(makeCube(10)), 'cube-inverted');
    expect(result.meta.volume).toBeCloseTo(1000, 6);
    expect(signedVolume(result.mesh)).toBeGreaterThan(0);
    expect(result.meta.watertight).toBe(true);
    expect(result.meta.shells).toBe(1);
    expect(result.meta.flippedTriangles).toBe(0);
    const flipped = result.repairs.find((record) => record.code === 'flipped');
    expect(flipped?.count).toBe(12);
  });

  it('fixes a single flipped triangle without touching the rest', () => {
    const result = analyzeMesh(flipTriangle(makeCube(10), 0), 'cube-one-flipped');
    expect(result.meta.volume).toBeCloseTo(1000, 6);
    expect(signedVolume(result.mesh)).toBeGreaterThan(0);
    expect(result.meta.watertight).toBe(true);
    const flipped = result.repairs.find((record) => record.code === 'flipped');
    expect(flipped?.count).toBe(1);
  });

  it('closes a square hole and restores the cube volume', () => {
    const result = analyzeMesh(removeLastTriangles(makeCube(10), 2), 'cube-open-face');
    expect(result.meta.triangles).toBe(14);
    expect(result.meta.watertight).toBe(true);
    expect(result.meta.boundaryEdges).toBe(0);
    expect(result.meta.volume).toBeCloseTo(1000, 6);
    expect(result.meta.shells).toBe(1);
    expect(result.meta.genus).toBe(0);
    const hole = result.repairs.find((record) => record.code === 'hole');
    expect(hole?.count).toBe(1);
  });

  it('closes a triangular hole with a single cap triangle', () => {
    const result = analyzeMesh(removeLastTriangles(makeCube(10), 1), 'cube-open-triangle');
    expect(result.meta.triangles).toBe(12);
    expect(result.meta.watertight).toBe(true);
    expect(result.meta.volume).toBeCloseTo(1000, 6);
    const hole = result.repairs.find((record) => record.code === 'hole');
    expect(hole?.count).toBe(1);
  });

  it('repairs an inverted open box through cap + final volume orientation', () => {
    const result = analyzeMesh(
      removeLastTriangles(invertMesh(makeCube(10)), 2),
      'cube-inverted-open',
    );
    expect(result.meta.watertight).toBe(true);
    expect(result.meta.volume).toBeCloseTo(1000, 6);
    expect(signedVolume(result.mesh)).toBeGreaterThan(0);
  });

  it('welds a triangle-soup cube back to 8 vertices', () => {
    const result = analyzeMesh(duplicateVertices(makeCube(10)), 'cube-soup');
    expect(result.meta.vertices).toBe(8);
    expect(result.meta.triangles).toBe(12);
    expect(result.meta.volume).toBeCloseTo(1000, 6);
    expect(result.meta.watertight).toBe(true);
    const weld = result.repairs.find((record) => record.code === 'weld');
    expect(weld?.count).toBe(28);
  });

  it('removes a duplicate face', () => {
    const cube = makeCube(10);
    const indices = new Uint32Array(cube.indices.length + 3);
    indices.set(cube.indices);
    indices.set(cube.indices.subarray(0, 3), cube.indices.length);
    const result = analyzeMesh({ positions: cube.positions, indices }, 'cube-duplicate-face');
    expect(result.meta.triangles).toBe(12);
    expect(result.meta.watertight).toBe(true);
    expect(result.meta.volume).toBeCloseTo(1000, 6);
    const duplicate = result.repairs.find((record) => record.code === 'duplicate');
    expect(duplicate?.count).toBe(1);
  });

  it('drops a degenerate triangle', () => {
    const cube = makeCube(10);
    const indices = new Uint32Array(cube.indices.length + 3);
    indices.set(cube.indices);
    indices[cube.indices.length] = 0;
    indices[cube.indices.length + 1] = 0;
    indices[cube.indices.length + 2] = 0;
    const result = analyzeMesh({ positions: cube.positions, indices }, 'cube-degenerate');
    expect(result.meta.triangles).toBe(12);
    expect(result.meta.watertight).toBe(true);
    const degenerate = result.repairs.find((record) => record.code === 'degenerate');
    expect(degenerate?.count).toBe(1);
  });
});

describe('synthetic repair cases', () => {
  it('splits a bow-tie vertex into two shells', () => {
    const mesh = combineMeshes(makeCube(10, [0, 0, 0]), makeCube(10, [10, 10, 10]));
    const result = analyzeMesh(mesh, 'bow-tie');
    expect(result.meta.shells).toBe(2);
    expect(result.meta.volume).toBeCloseTo(2000, 6);
    expect(result.meta.watertight).toBe(true);
    expect(result.meta.genus).toBe(0);
    const split = result.repairs.find((record) => record.code === 'nonManifold');
    expect(split?.count).toBe(1);
    expect(result.warnings.some((warning) => warning.code === 'shells')).toBe(true);
  });

  it('drops a tiny disconnected component and its bbox', () => {
    const mesh = combineMeshes(makeCube(10, [0, 0, 0]), makeCube(0.5, [20, 0, 0]));
    const result = analyzeMesh(mesh, 'tiny-component');
    expect(result.meta.shells).toBe(1);
    expect(result.meta.volume).toBeCloseTo(1000, 6);
    expect(result.meta.vertices).toBe(8);
    expect(result.meta.bbox.size[0]).toBeCloseTo(10, 6);
    expect(result.meta.bbox.size[1]).toBeCloseTo(10, 6);
    expect(result.meta.bbox.size[2]).toBeCloseTo(10, 6);
    const dropped = result.repairs.find((record) => record.code === 'shell');
    expect(dropped?.count).toBe(1);
    expect(result.warnings.some((warning) => warning.code === 'shellDropped')).toBe(true);
  });

  it('leaves a boundary loop above the 64-edge limit open and reports it', () => {
    const result = analyzeMesh(makeGrid(20, 20), 'grid-20');
    expect(result.meta.triangles).toBe(800);
    expect(result.meta.boundaryEdges).toBe(80);
    expect(result.meta.watertight).toBe(false);
    expect(result.warnings.some((warning) => warning.code === 'holes')).toBe(true);
    expect(result.warnings.some((warning) => warning.code === 'watertight')).toBe(true);
  });
});

describe('analysis contract', () => {
  it('is deterministic and does not mutate the input mesh', () => {
    const parsed = loadFixture('hook-base.stl');
    const positionsBefore = Array.from(parsed.mesh.positions);
    const indicesBefore = Array.from(parsed.mesh.indices);

    const first = analyzeMesh(parsed.mesh, 'hook-base.stl');
    const second = analyzeMesh(parsed.mesh, 'hook-base.stl');

    expect(Array.from(parsed.mesh.positions)).toEqual(positionsBefore);
    expect(Array.from(parsed.mesh.indices)).toEqual(indicesBefore);

    expect(Array.from(first.mesh.positions)).toEqual(Array.from(second.mesh.positions));
    expect(Array.from(first.mesh.indices)).toEqual(Array.from(second.mesh.indices));
    expect(Array.from(first.edges.dihedral)).toEqual(Array.from(second.edges.dihedral));
    expect(Array.from(first.edges.maxWidth)).toEqual(Array.from(second.edges.maxWidth));
    expect(first.meta).toEqual(second.meta);
    expect(first.repairs).toEqual(second.repairs);
    expect(first.warnings).toEqual(second.warnings);
  });

  it('handles an empty mesh without throwing', () => {
    const result = analyzeMesh(
      { positions: new Float32Array(0), indices: new Uint32Array(0) },
      'empty',
    );
    expect(result.meta.triangles).toBe(0);
    expect(result.meta.edges).toBe(0);
    expect(result.meta.shells).toBe(0);
    expect(result.meta.watertight).toBe(false);
    expect(result.warnings.some((warning) => warning.code === 'empty')).toBe(true);
  });
});
