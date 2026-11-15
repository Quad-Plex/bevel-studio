import { describe, expect, it } from 'vitest';
import type { MeshData } from '../types';
import { countSelfIntersections } from './selfIntersection';

function meshOf(triangles: number[][][]): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const triangle of triangles) {
    const base = positions.length / 3;
    for (const point of triangle) positions.push(point[0], point[1], point[2]);
    indices.push(base, base + 1, base + 2);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

describe('self-intersection gate', () => {
  it('reports two triangles that genuinely cross', () => {
    const mesh = meshOf([
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[2, -5, -5], [2, 5, -5], [2, 0, 5]],
    ]);
    expect(countSelfIntersections(mesh)).toBe(1);
  });

  it('reports two coplanar triangles that overlap in area', () => {
    const mesh = meshOf([
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[2, 2, 0], [8, 2, 0], [2, 8, 0]],
    ]);
    expect(countSelfIntersections(mesh)).toBe(1);
  });

  it('does not report a sub-weld contact that only touches at a corner', () => {
    // The second triangle is within 1e-3 mm of the first plane and its
    // projection touches the first triangle at one corner, but the surfaces
    // do not overlap. The old 3-D SAT called this a crossing.
    const mesh = meshOf([
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[10, 0, -1e-7], [12, 1, 5e-4], [10, 2, 5e-4]],
    ]);
    expect(countSelfIntersections(mesh)).toBe(0);
  });
});
