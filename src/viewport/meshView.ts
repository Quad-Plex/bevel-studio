import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
} from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MeshData } from '../engine/types';

/** Matches the "smooth by angle" shading used by the bevel preview. */
export const CREASE_ANGLE_DEGREES = 30;

/** Shared placeholder so a released mesh never keeps a disposed geometry bound. */
const EMPTY_GEOMETRY = new BufferGeometry();

/**
 * Shaded model layer.
 *
 * The STL's coordinates are used verbatim: no recentre, no rescale, no rotation
 * into a Y-up world. The viewport is Z-up, so world space equals model space in
 * millimetres, which is what picking and the edge overlay depend on.
 */
export class MeshView {
  readonly object: Mesh<BufferGeometry, MeshStandardMaterial>;
  readonly material: MeshStandardMaterial;

  private geometry: BufferGeometry | null = null;
  private bounds: Box3 | null = null;

  constructor() {
    this.material = new MeshStandardMaterial({
      color: 0x9aa5aa,
      roughness: 0.58,
      metalness: 0.06,
      envMapIntensity: 0.45,
    });

    this.object = new Mesh(EMPTY_GEOMETRY, this.material);
    this.object.name = 'model';
    this.object.castShadow = true;
    this.object.receiveShadow = true;
    this.object.visible = false;
  }

  /** World-space bounds of the current mesh, or null when empty. */
  getBounds(): Box3 | null {
    return this.bounds;
  }

  /**
   * Replace the displayed mesh. Input buffers are uploaded directly (no copies);
   * the only new arrays are the creased normals, which three has to compute.
   * Returns the world-space bounds so the controller can aim the light rig.
   */
  setMesh(mesh: MeshData | null, options: { flat?: boolean } = {}): Box3 | null {
    this.releaseGeometry();

    if (!mesh || mesh.indices.length < 3 || mesh.positions.length < 9) {
      this.bounds = null;
      this.object.visible = false;
      return null;
    }

    const source = new BufferGeometry();
    // Zero-copy: the BufferAttribute wraps the typed arrays owned by the store.
    source.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    source.setIndex(new BufferAttribute(mesh.indices, 1));
    source.computeBoundingBox();

    const box = source.boundingBox ?? new Box3();
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const radius = Math.max(size.length() * 0.5, 1e-6);

    // Creased normals merge vertices and cost seconds on a million triangles.
    // Above ~300 k triangles the facets are smaller than a pixel, so flat
    // shading (computed in the shader) looks the same and keeps import snappy.
    // The user can also force flat shading from the inspector.
    const dense = mesh.indices.length / 3 > 300_000 || options.flat === true;
    this.material.flatShading = dense;
    this.material.needsUpdate = true;

    let geometry: BufferGeometry;
    if (dense) {
      geometry = source;
      geometry.boundingSphere = new Sphere(center, radius);
      geometry.boundingBox = box;
    } else {
      geometry = toCreasedNormals(source, MathUtils.degToRad(CREASE_ANGLE_DEGREES));

      // The creased geometry is non-indexed and its bounds are known already.
      // Setting them by hand avoids another full pass over up to 3 M vertices.
      geometry.boundingSphere = new Sphere(center, radius);
      geometry.boundingBox = box;
      source.dispose();
    }

    this.geometry = geometry;
    this.bounds = box;
    this.object.geometry = geometry;
    this.object.visible = true;
    return box;
  }

  dispose(): void {
    this.releaseGeometry();
    this.material.dispose();
    this.object.removeFromParent();
  }

  private releaseGeometry(): void {
    this.object.geometry = EMPTY_GEOMETRY;
    this.object.visible = false;

    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }

    this.bounds = null;
  }
}
