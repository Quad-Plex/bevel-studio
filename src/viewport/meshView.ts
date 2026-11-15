import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
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

export interface MeshViewOptions {
  flat?: boolean;
  /** 0/1 per triangle of `mesh`; 1 marks a face created by a bevel solid. */
  bevelFaces?: Uint8Array | null;
}

export interface MeshViewTheme {
  /** Light purple used for the bevel band. */
  bevelColor?: string;
}

/**
 * Shaded model layer.
 *
 * The STL's coordinates are used verbatim: no recentre, no rescale, no rotation
 * into a Y-up world. The viewport is Z-up, so world space equals model space in
 * millimetres, which is what picking and the edge overlay depend on.
 *
 * Three meshes share the same transform:
 * - `object` renders the whole surface;
 * - `bevelObject` reuses the same vertex buffers and draws only the triangles
 *   the kernel attributed to a bevel solid, so the bevel band reads as a light
 *   purple insert without rebuilding the mesh;
 * - `wireObject` draws the triangle edges for the wireframe toggle.
 */
export class MeshView {
  readonly object: Mesh<BufferGeometry, MeshStandardMaterial>;
  readonly material: MeshStandardMaterial;
  readonly bevelObject: Mesh<BufferGeometry, MeshStandardMaterial>;
  readonly bevelMaterial: MeshStandardMaterial;
  readonly wireObject: Mesh<BufferGeometry, MeshBasicMaterial>;
  readonly wireMaterial: MeshBasicMaterial;

  private geometry: BufferGeometry | null = null;
  private bevelGeometry: BufferGeometry | null = null;
  private bounds: Box3 | null = null;
  private wireframe = false;

  constructor(theme: MeshViewTheme = {}) {
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

    // Negative polygon offset pulls the band fractionally towards the camera so
    // it wins the depth test against the coincident base surface.
    this.bevelMaterial = new MeshStandardMaterial({
      color: new Color(theme.bevelColor ?? '#b18cff'),
      roughness: 0.46,
      metalness: 0.04,
      emissive: new Color('#2a1a5c'),
      emissiveIntensity: 0.22,
      envMapIntensity: 0.5,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.bevelObject = new Mesh(EMPTY_GEOMETRY, this.bevelMaterial);
    this.bevelObject.name = 'bevel-faces';
    this.bevelObject.receiveShadow = true;
    this.bevelObject.renderOrder = 1;
    this.bevelObject.visible = false;

    this.wireMaterial = new MeshBasicMaterial({
      color: 0x0b1114,
      wireframe: true,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.wireObject = new Mesh(EMPTY_GEOMETRY, this.wireMaterial);
    this.wireObject.name = 'wireframe';
    this.wireObject.renderOrder = 2;
    this.wireObject.visible = false;

    this.object.add(this.bevelObject, this.wireObject);
  }

  /** World-space bounds of the current mesh, or null when empty. */
  getBounds(): Box3 | null {
    return this.bounds;
  }

  /** Show or hide the triangle-edge overlay. Cheap; no geometry rebuild. */
  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.wireObject.visible = on && this.geometry !== null;
  }

  /**
   * Replace the displayed mesh. Input buffers are uploaded directly (no copies);
   * the only new arrays are the creased normals, which three has to compute,
   * and the bevel index list.
   * Returns the world-space bounds so the controller can aim the light rig.
   */
  setMesh(mesh: MeshData | null, options: MeshViewOptions = {}): Box3 | null {
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
    this.bevelMaterial.flatShading = dense;
    this.bevelMaterial.needsUpdate = true;

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

    this.buildBevelBand(geometry, mesh, options.bevelFaces ?? null);

    this.wireObject.geometry = geometry;
    this.wireObject.visible = this.wireframe;

    return box;
  }

  dispose(): void {
    this.releaseGeometry();
    this.material.dispose();
    this.bevelMaterial.dispose();
    this.wireMaterial.dispose();
    this.object.removeFromParent();
  }

  /**
   * Subset the shared vertex buffers down to the bevel triangles. No vertex
   * data is duplicated: only the extra index list is allocated.
   */
  private buildBevelBand(
    geometry: BufferGeometry,
    mesh: MeshData,
    mask: Uint8Array | null,
  ): void {
    if (!mask) return;

    const triangles = mesh.indices.length / 3;
    if (mask.length !== triangles) return;

    const nonIndexed = geometry.getIndex() === null;
    if (nonIndexed && geometry.getAttribute('position').count !== triangles * 3) return;

    let selected = 0;
    for (let t = 0; t < triangles; t++) if (mask[t]) selected += 3;
    if (selected === 0) return;

    const indices = new Uint32Array(selected);
    let o = 0;
    for (let t = 0; t < triangles; t++) {
      if (!mask[t]) continue;
      if (nonIndexed) {
        indices[o++] = t * 3;
        indices[o++] = t * 3 + 1;
        indices[o++] = t * 3 + 2;
      } else {
        indices[o++] = mesh.indices[t * 3];
        indices[o++] = mesh.indices[t * 3 + 1];
        indices[o++] = mesh.indices[t * 3 + 2];
      }
    }

    const band = new BufferGeometry();
    band.setAttribute('position', geometry.getAttribute('position'));
    const normal = geometry.getAttribute('normal');
    if (normal) band.setAttribute('normal', normal);
    band.setIndex(new BufferAttribute(indices, 1));
    band.boundingBox = geometry.boundingBox;
    band.boundingSphere = geometry.boundingSphere;

    this.bevelGeometry = band;
    this.bevelObject.geometry = band;
    this.bevelObject.visible = true;
  }

  private releaseGeometry(): void {
    this.object.geometry = EMPTY_GEOMETRY;
    this.object.visible = false;
    this.bevelObject.geometry = EMPTY_GEOMETRY;
    this.bevelObject.visible = false;
    this.wireObject.geometry = EMPTY_GEOMETRY;
    this.wireObject.visible = false;

    if (this.bevelGeometry) {
      this.bevelGeometry.dispose();
      this.bevelGeometry = null;
    }

    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }

    this.bounds = null;
  }
}
