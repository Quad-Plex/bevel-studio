import { Vector3 } from 'three';
import type { EdgeTable } from '../engine/types';

/**
 * Screen-independent edge picking. Edges are bucketed by their midpoint into a
 * uniform 3D grid, so a click near a hit point only tests a handful of cells
 * instead of every edge in a million-triangle mesh.
 */
export class EdgePicker {
  private table: EdgeTable | null = null;
  private readonly buckets = new Map<number, number[]>();
  private cell = 1;
  private minX = 0;
  private minY = 0;
  private minZ = 0;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly p = new Vector3();

  build(table: EdgeTable): void {
    this.table = table;
    this.buckets.clear();

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < table.count; i++) {
      const o = i * 6;
      const x = table.position[o];
      const y = table.position[o + 1];
      const z = table.position[o + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      const x2 = table.position[o + 3];
      const y2 = table.position[o + 4];
      const z2 = table.position[o + 5];
      if (x2 < minX) minX = x2;
      if (y2 < minY) minY = y2;
      if (z2 < minZ) minZ = z2;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
      if (z2 > maxZ) maxZ = z2;
    }

    const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    this.cell = Math.max(diagonal / 96, 0.25);
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;

    for (let i = 0; i < table.count; i++) {
      const o = i * 6;
      const ax = table.position[o];
      const ay = table.position[o + 1];
      const az = table.position[o + 2];
      const bx = table.position[o + 3];
      const by = table.position[o + 4];
      const bz = table.position[o + 5];

      // Rasterise the segment through the grid, not just its midpoint: an edge
      // must be pickable along its whole length, not only near the middle.
      const length = Math.hypot(bx - ax, by - ay, bz - az);
      const steps = Math.max(1, Math.ceil(length / (this.cell * 0.5)));
      let lastKey = -1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const key = this.key(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
        if (key === lastKey) continue;
        lastKey = key;
        const list = this.buckets.get(key);
        if (list) list.push(i);
        else this.buckets.set(key, [i]);
      }
    }
  }

  /** Nearest edge to a world-space point within `radius` millimetres. */
  pick(point: Vector3, radius: number): number | null {
    const table = this.table;
    if (!table) return null;

    const reach = Math.max(1, Math.ceil(radius / this.cell));
    const cx = this.index(point.x);
    const cy = this.index(point.y);
    const cz = this.index(point.z);

    let best: number | null = null;
    let bestDistance = radius * radius;

    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dz = -reach; dz <= reach; dz++) {
          const list = this.buckets.get(this.keyFromIndex(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const id of list) {
            const o = id * 6;
            this.a.set(table.position[o], table.position[o + 1], table.position[o + 2]);
            this.b.set(table.position[o + 3], table.position[o + 4], table.position[o + 5]);
            const distance = this.pointSegmentSq(point, this.a, this.b);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = id;
            }
          }
        }
      }
    }

    return best;
  }

  private pointSegmentSq(point: Vector3, a: Vector3, b: Vector3): number {
    this.p.subVectors(b, a);
    const lengthSq = this.p.lengthSq();
    if (lengthSq < 1e-12) return point.distanceToSquared(a);
    const t = Math.max(0, Math.min(1, (point.clone().sub(a).dot(this.p)) / lengthSq));
    const x = a.x + this.p.x * t - point.x;
    const y = a.y + this.p.y * t - point.y;
    const z = a.z + this.p.z * t - point.z;
    return x * x + y * y + z * z;
  }

  private index(value: number): number {
    return Math.floor(value / this.cell);
  }

  private key(x: number, y: number, z: number): number {
    return this.keyFromIndex(this.index(x), this.index(y), this.index(z));
  }

  private keyFromIndex(ix: number, iy: number, iz: number): number {
    return (ix + 4096) * 16_777_216 + (iy + 4096) * 4096 + (iz + 4096);
  }
}
