import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { brushableEdges, closestBetweenSegments, edgesInBrush } from './brush';
import { EDGE_CONCAVE, EDGE_CONVEX, type EdgeTable } from '../engine/types';

/** `count` parallel vertical edges at x = (i − mid)·spacing in the z = 0 plane. */
function table(count: number, spacing: number, flags = EDGE_CONVEX, dihedral = 90): EdgeTable {
  const position = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const x = (i - (count - 1) / 2) * spacing;
    position.set([x, -20, 0, x, 20, 0], i * 6);
  }
  return {
    count,
    v: new Uint32Array(count * 2),
    position,
    dihedral: new Float32Array(count).fill(dihedral),
    flags: new Uint8Array(count).fill(flags),
    maxWidth: new Float32Array(count).fill(1),
    tris: new Uint32Array(count * 2).fill(0xffffffff),
  };
}

function camera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, 1, 0.1, 1000);
  cam.position.set(0, 0, 100);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

const SIZE = 400;
const all = (n: number) => Uint32Array.from(Array.from({ length: n }, (_, i) => i));

function query(edges: EdgeTable, x0: number, y0: number, x1: number, y1: number, radius: number) {
  return edgesInBrush(
    {
      table: edges,
      ids: all(edges.count),
      camera: camera(),
      width: SIZE,
      height: SIZE,
      x0,
      y0,
      x1,
      y1,
      radius,
      visible: () => true,
    },
    [],
  );
}

describe('selection brush', () => {
  it('hovers exactly the edges inside the ring, nearest first', () => {
    // 13 edges 4 mm apart; at 100 mm with a 50° fov one mm is ≈ 4.3 px
    const edges = table(13, 4);
    const centre = SIZE / 2;
    expect(query(edges, centre, centre, centre, centre, 5)).toEqual([6]);
    const wide = query(edges, centre, centre, centre, centre, 20);
    expect(wide[0]).toBe(6);
    expect(new Set(wide)).toEqual(new Set([5, 6, 7]));
  });

  it('sweeps every edge a fast stroke crosses', () => {
    const edges = table(13, 4);
    const hits = query(edges, 0, SIZE / 2, SIZE, SIZE / 2, 2);
    expect(new Set(hits).size).toBe(13);
  });

  it('skips edges hidden behind the part', () => {
    const edges = table(3, 4);
    const hidden = new Set([1]);
    const hits = edgesInBrush(
      {
        table: edges,
        ids: all(3),
        camera: camera(),
        width: SIZE,
        height: SIZE,
        x0: 0,
        y0: SIZE / 2,
        x1: SIZE,
        y1: SIZE / 2,
        radius: 3,
        // edge 1 sits at x = 0: report its points as occluded
        visible: (p: Vector3) => !(Math.abs(p.x) < 1e-6 && hidden.has(1)),
      },
      [],
    );
    expect(hits.sort()).toEqual([0, 2]);
  });

  it('tests visibility at the point of the edge under the ring', () => {
    const edges = table(1, 4);
    let probed: Vector3 | null = null;
    edgesInBrush(
      {
        table: edges,
        ids: all(1),
        camera: camera(),
        width: SIZE,
        height: SIZE,
        x0: SIZE / 2,
        y0: SIZE * 0.3,
        x1: SIZE / 2,
        y1: SIZE * 0.3,
        radius: 4,
        visible: (p: Vector3) => {
          probed = p.clone();
          return true;
        },
      },
      [],
    );
    // the probe is on the edge, above the centre (screen y up = world +y)
    expect(probed).not.toBeNull();
    expect(Math.abs(probed!.x)).toBeLessThan(1e-6);
    expect(probed!.y).toBeGreaterThan(5);
  });

  it('only offers feature edges of the requested kind', () => {
    const edges = table(4, 4);
    edges.flags.set([EDGE_CONVEX, EDGE_CONCAVE, EDGE_CONVEX, 0]);
    edges.dihedral.set([90, 90, 8, 0]);
    expect(Array.from(brushableEdges(edges, 'all'))).toEqual([0, 1]);
    expect(Array.from(brushableEdges(edges, 'outside'))).toEqual([0]);
    expect(Array.from(brushableEdges(edges, 'inside'))).toEqual([1]);
  });

  it('measures segment distance including crossings and end caps', () => {
    expect(closestBetweenSegments(0, 0, 10, 0, 5, -5, 5, 5).distance).toBe(0);
    expect(closestBetweenSegments(0, 0, 10, 0, 13, 4, 13, 4).distance).toBeCloseTo(5, 9);
    const mid = closestBetweenSegments(0, 0, 10, 0, 4, 3, 4, 3);
    expect(mid.distance).toBeCloseTo(3, 9);
    expect(mid.s).toBeCloseTo(0.4, 9);
  });
});
