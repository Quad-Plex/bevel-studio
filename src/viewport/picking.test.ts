import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EdgePicker } from './picking';
import type { EdgeTable } from '../engine/types';

function table(edges: [number[], number[]][]): EdgeTable {
  const count = edges.length;
  const position = new Float32Array(count * 6);
  const dihedral = new Float32Array(count);
  edges.forEach(([a, b], i) => {
    position.set([...a, ...b], i * 6);
    dihedral[i] = 90;
  });
  return {
    count,
    v: new Uint32Array(count * 2),
    position,
    dihedral,
    flags: new Uint8Array(count),
    maxWidth: new Float32Array(count).fill(1),
    tris: new Uint32Array(count * 2).fill(0xffffffff),
  };
}

describe('EdgePicker', () => {
  it('returns the nearest edge to a point', () => {
    const picker = new EdgePicker();
    picker.build(
      table([
        [[0, 0, 0], [10, 0, 0]],
        [[0, 5, 0], [10, 5, 0]],
        [[0, 10, 0], [10, 10, 0]],
      ]),
    );

    expect(picker.pick(new Vector3(5, 0.2, 0), 0.5)).toBe(0);
    expect(picker.pick(new Vector3(5, 4.9, 0), 0.5)).toBe(1);
    expect(picker.pick(new Vector3(5, 9.6, 0), 1)).toBe(2);
  });

  it('respects the radius and clamps to the segment ends', () => {
    const picker = new EdgePicker();
    picker.build(table([[[0, 0, 0], [10, 0, 0]]]));

    expect(picker.pick(new Vector3(5, 2, 0), 0.5)).toBeNull();
    // Beyond the end cap but within radius of the endpoint.
    expect(picker.pick(new Vector3(10.2, 0.1, 0), 0.5)).toBe(0);
    expect(picker.pick(new Vector3(10.6, 0, 0), 0.5)).toBeNull();
  });

  it('handles an empty table', () => {
    const picker = new EdgePicker();
    picker.build(table([]));
    expect(picker.pick(new Vector3(), 1)).toBeNull();
  });
});
