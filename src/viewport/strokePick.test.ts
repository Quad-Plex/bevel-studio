import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { edgesAlongStroke } from './strokePick';
import type { EdgeTable } from '../engine/types';

function table(count: number, spacing: number): EdgeTable {
  const position = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const x = (i - (count - 1) / 2) * spacing;
    position.set([x, -20, 0, x, 20, 0], i * 6);
  }
  return {
    count,
    v: new Uint32Array(count * 2),
    position,
    dihedral: new Float32Array(count).fill(90),
    flags: new Uint8Array(count),
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

const WIDTH = 400;
const HEIGHT = 400;
const DEPTH = 100;

describe('edgesAlongStroke', () => {
  it('catches every edge a straight stroke crosses', () => {
    const edges = table(13, 4);
    const ids: number[] = [];
    const out: number[] = [];

    edgesAlongStroke(
      edges,
      Uint32Array.from(Array.from({ length: 13 }, (_, i) => i)),
      camera(),
      WIDTH,
      HEIGHT,
      0,
      HEIGHT / 2,
      WIDTH,
      HEIGHT / 2,
      3,
      5,
      DEPTH,
      DEPTH,
      out,
    );

    expect(out.length).toBe(13);
    expect(new Set(out).size).toBe(13);
    ids.length = 0;
  });

  it('rejects edges on the far side of the part', () => {
    const edges = table(13, 4);
    // Move every edge 40 mm behind the reference depth.
    for (let i = 0; i < edges.count; i++) {
      edges.position[i * 6 + 2] = -40;
      edges.position[i * 6 + 5] = -40;
    }

    const out: number[] = [];
    edgesAlongStroke(
      edges,
      Uint32Array.from(Array.from({ length: 13 }, (_, i) => i)),
      camera(),
      WIDTH,
      HEIGHT,
      0,
      HEIGHT / 2,
      WIDTH,
      HEIGHT / 2,
      3,
      5,
      DEPTH,
      DEPTH,
      out,
    );

    expect(out.length).toBe(0);
  });

  it('ignores edges the stroke does not touch', () => {
    const edges = table(3, 40);
    const out: number[] = [];
    edgesAlongStroke(
      edges,
      Uint32Array.from([0, 1, 2]),
      camera(),
      WIDTH,
      HEIGHT,
      0,
      10,
      WIDTH,
      10,
      3,
      5,
      DEPTH,
      DEPTH,
      out,
    );
    expect(out.length).toBe(0);
  });
});
