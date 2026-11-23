import { Vector3, type Ray } from 'three';
import { buildBvh, raycast, type TriangleBvh } from '../engine/bevel/bvh';
import type { MeshData } from '../engine/types';

/**
 * Ray queries against the source mesh for the selection brush: the surface
 * point under the cursor and per-edge occlusion. Uses the engine's triangle
 * BVH, so hovering a million-triangle part stays interactive (three's
 * Raycaster would test every triangle on every pointer move).
 *
 * The tree is built lazily on the first query after `setMesh`. Edges live on
 * the source mesh, so occlusion is tested against it even while the beveled
 * preview is shown.
 */
export class SurfaceIndex {
  private mesh: MeshData | null = null;
  private bvh: TriangleBvh | null = null;
  private readonly dir = new Vector3();

  setMesh(mesh: MeshData | null): void {
    if (mesh === this.mesh) return;
    this.mesh = mesh;
    this.bvh = null;
  }

  get ready(): boolean {
    return this.mesh !== null;
  }

  private tree(): TriangleBvh | null {
    if (!this.bvh && this.mesh && this.mesh.indices.length > 0) this.bvh = buildBvh(this.mesh);
    return this.bvh;
  }

  /** First hit along the ray, or null. */
  pick(ray: Ray, target = new Vector3()): Vector3 | null {
    const bvh = this.tree();
    if (!bvh) return null;
    const { origin: o, direction: d } = ray;
    const t = raycast(bvh, o.x, o.y, o.z, d.x, d.y, d.z, Infinity);
    if (!Number.isFinite(t)) return null;
    return target.copy(d).multiplyScalar(t).add(o);
  }

  /**
   * True when nothing on the mesh lies between `eye` and `point` (a point on
   * the surface), allowing `tolerance` mm for grazing hits on the faces next
   * to an edge.
   */
  visible(eye: Vector3, point: Vector3, tolerance: number): boolean {
    const bvh = this.tree();
    if (!bvh) return true;
    this.dir.subVectors(point, eye);
    const distance = this.dir.length();
    if (!(distance > 0)) return true;
    this.dir.multiplyScalar(1 / distance);
    const t = raycast(bvh, eye.x, eye.y, eye.z, this.dir.x, this.dir.y, this.dir.z, distance - tolerance);
    return !Number.isFinite(t) || t >= distance - tolerance;
  }
}
