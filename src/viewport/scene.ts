import {
  ACESFilmicToneMapping,
  Box3,
  CanvasTexture,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MOUSE,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Ray,
  Raycaster,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Bounds, EdgeTable, MeshData } from '../engine/types';
import { EdgeView } from './edgeView';
import { MeshView } from './meshView';
import { readColorToken } from './theme';

/** Viewing direction from the model, in model space (STL: Z up, millimetres). */
const FIT_DIRECTION = new Vector3(1, -0.85, 0.6).normalize();
const WORLD_UP = new Vector3(0, 0, 1);
const FIT_MARGIN = 1.2;
const DEFAULT_FIT_MS = 300;

const KEY_DIRECTION = new Vector3(-0.45, -0.62, 0.86).normalize();
const RIM_DIRECTION = new Vector3(0.55, 0.78, 0.35).normalize();

interface CameraAnimation {
  fromPosition: Vector3;
  toPosition: Vector3;
  fromTarget: Vector3;
  toTarget: Vector3;
  start: number;
  duration: number;
}

/**
 * Imperative three.js viewport. One instance owns one WebGL context and renders
 * on demand — nothing ticks unless the camera, the mesh or the selection moved.
 *
 * Coordinates are deliberately Z-up and unscaled: an STL vertex at
 * (12, -4, 35) is rendered at world (12, -4, 35) mm. Picking therefore shares
 * model space and needs no matrix gymnastics beyond the camera.
 */
export class SceneController {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly meshView: MeshView;
  readonly edgeView: EdgeView;
  readonly domElement: HTMLCanvasElement;

  private readonly host: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly keyLight: DirectionalLight;
  private readonly rimLight: DirectionalLight;
  private readonly hemiLight: HemisphereLight;
  private readonly ground: Mesh<PlaneGeometry, ShadowMaterial>;
  private readonly contact: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly contactTexture: CanvasTexture;
  private readonly floor: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly floorTexture: CanvasTexture;
  private readonly envTarget: WebGLRenderTarget;

  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly tmpSize = new Vector3();
  private readonly tmpCenter = new Vector3();
  private readonly tmpTarget = new Vector3();

  private bounds: Box3 | null = null;
  private cameraAnimation: CameraAnimation | null = null;
  private frameHandle = 0;
  private width = 0;
  private height = 0;
  private disposed = false;
  private readonly reduceMotion: boolean;

  constructor(host: HTMLElement) {
    this.host = host;
    this.reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    // The scene is static between mesh changes; orbit never re-renders the shadow map.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setClearColor(0x000000, 0);

    this.domElement = this.renderer.domElement;
    this.domElement.className = 'vp-canvas';
    host.appendChild(this.domElement);

    this.scene = new Scene();

    this.camera = new PerspectiveCamera(32, 1, 0.1, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -100, 80);

    this.controls = new OrbitControls(this.camera, this.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.75;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.8;
    this.controls.minDistance = 0.01;
    this.controls.maxPolarAngle = Math.PI * 0.995;
    // CAD-style mouse map: middle drag pans, right button belongs to selection.
    this.controls.mouseButtons = {
      LEFT: MOUSE.ROTATE,
      MIDDLE: MOUSE.PAN,
      RIGHT: null as unknown as MOUSE,
    };

    this.edgeView = new EdgeView(this.invalidate, readColorToken('--selection', '#ffb65c'));
    this.meshView = new MeshView({
      bevelColor: readColorToken('--bevel-face', '#b18cff'),
    });
    this.scene.add(this.meshView.object, this.edgeView.group);

    this.keyLight = new DirectionalLight(0xfff2e4, 1.25);
    this.keyLight.name = 'key-light';
    this.keyLight.castShadow = false;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0002;
    this.keyLight.shadow.normalBias = 0.6;
    this.keyLight.shadow.radius = 2.5;
    this.scene.add(this.keyLight, this.keyLight.target);

    this.rimLight = new DirectionalLight(0xbed8ff, 0.5);
    this.rimLight.name = 'rim-light';
    this.scene.add(this.rimLight, this.rimLight.target);

    this.hemiLight = new HemisphereLight(0xa9c6da, 0x111619, 0.22);
    this.hemiLight.name = 'hemi-light';
    this.scene.add(this.hemiLight);

    const pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.4;
    room.dispose();
    pmrem.dispose();

    // A faint light pool under the part. Without it the CSS background is so
    // dark that a shadow has nothing to darken and the model appears to float.
    this.floorTexture = createFloorTexture();
    this.floor = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        map: this.floorTexture,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.floor.name = 'studio-floor';
    this.floor.renderOrder = -1;
    this.floor.visible = false;
    this.scene.add(this.floor);

    this.ground = new Mesh(
      new PlaneGeometry(1, 1),
      new ShadowMaterial({
        color: 0x000000,
        opacity: 0.5,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.ground.name = 'ground-shadow';
    this.ground.receiveShadow = true;
    this.ground.renderOrder = 1;
    this.ground.visible = false;
    this.scene.add(this.ground);

    this.contactTexture = createContactTexture();
    this.contact = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        map: this.contactTexture,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.contact.name = 'ground-contact';
    this.contact.renderOrder = 2;
    this.contact.visible = false;
    this.scene.add(this.contact);

    this.updateLightRig(null);

    this.controls.addEventListener('change', this.onControlsChange);
    this.controls.addEventListener('start', this.onControlsStart);

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(host);
    this.resize();
    this.invalidate();
  }

  // ---------------------------------------------------------------- public API

  /**
   * Replace the shaded mesh. `bounds` is optional; when omitted it is computed
   * from the positions. Geometry is never recentred or rescaled.
   *
   * `bevelFaces` is a 0/1 mask per triangle; 1 tints that face as the bevel
   * band. The mask is ignored when it does not match the mesh.
   */
  setMesh(
    mesh: MeshData | null,
    bounds?: Bounds,
    flat = false,
    bevelFaces?: Uint8Array | null,
  ): void {
    if (this.disposed) return;

    const computed = this.meshView.setMesh(mesh, { flat, bevelFaces });
    this.bounds = mesh ? (bounds ? boxFromBounds(bounds) : computed) : null;

    if (this.bounds) {
      this.updateGround(this.bounds);
    } else {
      this.ground.visible = false;
      this.contact.visible = false;
    }
    this.updateLightRig(this.bounds);

    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate();
  }

  /** Toggle the triangle-edge overlay. */
  setWireframe(on: boolean): void {
    if (this.disposed) return;
    this.meshView.setWireframe(on);
    this.invalidate();
  }

  /** Replace the overlay. Passing the same table again only refreshes the selection. */
  setEdges(table: EdgeTable | null, selection: Uint8Array | null): void {
    if (this.disposed) return;
    this.edgeView.setPixelScale(this.pixelScale());
    this.edgeView.setEdges(table, selection);
  }

  /** Selection-only update; cheap for click/paint interaction. */
  setSelection(selection: Uint8Array | null): void {
    if (this.disposed) return;
    this.edgeView.setPixelScale(this.pixelScale());
    this.edgeView.setSelection(selection);
  }

  /** World units per screen pixel at the model centre. */
  private pixelScale(): number {
    const center = this.bounds
      ? this.bounds.getCenter(this.tmpCenter)
      : this.tmpCenter.set(0, 0, 0);
    const distance = Math.max(this.camera.position.distanceTo(center), 1e-3);
    const height = this.renderer.domElement.clientHeight || 1;
    return (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2) * distance) / height;
  }

  /**
   * Frame bounds (defaults to the current mesh) from the standard three-quarter
   * view, animated with an ease-out over `durationMs`.
   */
  frame(bounds?: Bounds, durationMs = DEFAULT_FIT_MS): void {
    if (this.disposed) return;

    const box = bounds ? boxFromBounds(bounds) : this.bounds;
    if (!box || box.isEmpty()) return;

    this.resize();

    const size = box.getSize(this.tmpSize);
    const center = box.getCenter(this.tmpCenter);
    const radius = size.length() * 0.5;

    const verticalFov = MathUtils.degToRad(this.camera.fov);
    const horizontalFov =
      2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(this.camera.aspect, 1e-6));

    const forward = FIT_DIRECTION.clone().negate();
    const right = new Vector3().crossVectors(forward, WORLD_UP);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();
    const tanVertical = Math.tan(verticalFov / 2) / FIT_MARGIN;
    const tanHorizontal = Math.tan(horizontalFov / 2) / FIT_MARGIN;

    // Fit the real silhouette, not the bbox: for an L-shaped part the empty
    // corners of the bounding box otherwise dominate the projection and the
    // model ends up small in the middle of the viewport.
    let maxRight = 0;
    let maxUp = 0;
    let maxDepth = 0;
    let distance = radius * 0.4;

    const positionAttribute = this.meshView.object.geometry.getAttribute('position');
    const point = new Vector3();
    const consider = (x: number, y: number, z: number) => {
      point.set(x, y, z).sub(center);
      const depth = point.dot(forward);
      maxRight = Math.max(maxRight, Math.abs(point.dot(right)));
      maxUp = Math.max(maxUp, Math.abs(point.dot(up)));
      maxDepth = Math.max(maxDepth, depth);
      distance = Math.max(
        distance,
        Math.max(
          Math.abs(point.dot(right)) / tanHorizontal,
          Math.abs(point.dot(up)) / tanVertical,
        ) - depth,
      );
    };

    if (positionAttribute && positionAttribute.count > 0) {
      for (let i = 0; i < positionAttribute.count; i++) {
        consider(
          positionAttribute.getX(i),
          positionAttribute.getY(i),
          positionAttribute.getZ(i),
        );
      }
    } else {
      for (let i = 0; i < 8; i++) {
        consider(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        );
      }
    }

    distance = Math.max(distance, maxDepth + Math.max(0.2, radius * 0.02), 1e-3);

    const target = this.tmpTarget.copy(center);
    const position = new Vector3().copy(center).addScaledVector(FIT_DIRECTION, distance);
    this.animateCamera(position, target, durationMs);
  }

  /** World-space bounds of the current mesh, or null. */
  getBounds(): Box3 | null {
    return this.bounds;
  }

  /** Schedule exactly one frame; safe to call repeatedly. */
  readonly invalidate = (): void => {
    if (this.disposed || this.frameHandle !== 0) return;
    this.frameHandle = requestAnimationFrame(this.tick);
  };

  /**
   * Ray through a client-space point, in model space (Z up). Pass `target` to
   * avoid allocating per pointer event.
   */
  screenToRay(clientX: number, clientY: number, target = new Ray()): Ray {
    const rect = this.domElement.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : 1;
    const height = rect.height > 0 ? rect.height : 1;
    this.pointer.set(
      ((clientX - rect.left) / width) * 2 - 1,
      -((clientY - rect.top) / height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    target.copy(this.raycaster.ray);
    return target;
  }

  /**
   * World-space point under the cursor on the model, or null. Used by edge
   * selection to anchor a pick in 3D instead of in screen space.
   */
  pickSurface(clientX: number, clientY: number): Vector3 | null {
    if (!this.meshView.object.visible) return null;
    this.screenToRay(clientX, clientY, this.raycaster.ray);
    const hits = this.raycaster.intersectObject(this.meshView.object, false);
    return hits.length > 0 ? hits[0].point.clone() : null;
  }

  /**
   * Cheap "is the pointer over the model" test using the world-space bounding
   * box. Good enough to distinguish double-click-empty from double-click-model;
   * use `screenToRay` for real picking.
   */
  isPointerOverModel(clientX: number, clientY: number): boolean {
    if (!this.bounds || !this.meshView.object.visible) return false;
    const ray = this.screenToRay(clientX, clientY, this.raycaster.ray);
    return ray.intersectsBox(this.bounds);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.frameHandle !== 0) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
    }

    this.resizeObserver.disconnect();
    this.controls.removeEventListener('change', this.onControlsChange);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.controls.dispose();

    this.edgeView.dispose();
    this.meshView.dispose();

    this.scene.environment = null;
    this.envTarget.dispose();
    this.scene.clear();

    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.contact.geometry.dispose();
    this.contact.material.dispose();
    this.contactTexture.dispose();
    this.floor.geometry.dispose();
    this.floor.material.dispose();
    this.floorTexture.dispose();

    this.renderer.dispose();
    if (this.domElement.parentElement === this.host) {
      this.host.removeChild(this.domElement);
    }
  }

  // ---------------------------------------------------------------- internals

  private readonly tick = (now: number): void => {
    this.frameHandle = 0;
    if (this.disposed) return;

    const animating = this.stepCamera(now);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    if (animating) this.invalidate();
  };

  private stepCamera(now: number): boolean {
    const animation = this.cameraAnimation;
    if (!animation) return false;

    const t = Math.max(0, Math.min(1, (now - animation.start) / animation.duration));
    const eased = 1 - Math.pow(1 - t, 3);
    this.camera.position.lerpVectors(animation.fromPosition, animation.toPosition, eased);
    this.controls.target.lerpVectors(animation.fromTarget, animation.toTarget, eased);

    if (t >= 1) {
      this.cameraAnimation = null;
      return false;
    }
    return true;
  }

  private animateCamera(position: Vector3, target: Vector3, durationMs: number): void {
    const duration = this.reduceMotion ? 0 : Math.max(0, durationMs);

    if (duration === 0) {
      this.cameraAnimation = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      this.invalidate();
      return;
    }

    this.cameraAnimation = {
      fromPosition: this.camera.position.clone(),
      toPosition: position.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      start: performance.now(),
      duration,
    };
    this.invalidate();
  }

  private readonly onControlsChange = (): void => {
    this.edgeView.refreshScale(this.pixelScale());
    this.invalidate();
  };

  private readonly onControlsStart = (): void => {
    this.cameraAnimation = null;
  };

  private readonly onResize = (): void => {
    this.resize();
  };

  private resize(): void {
    if (this.disposed) return;

    const width = Math.max(1, Math.round(this.host.clientWidth));
    const height = Math.max(1, Math.round(this.host.clientHeight));
    if (width === this.width && height === this.height) return;

    this.width = width;
    this.height = height;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.edgeView.setResolution(width, height);
    this.invalidate();
  }

  private pixelRatio(): number {
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    return Math.min(ratio, 2);
  }

  private updateGround(box: Box3): void {
    const size = box.getSize(this.tmpSize);
    const center = box.getCenter(this.tmpCenter);
    const diagonal = Math.max(size.length(), 1e-3);
    const span = Math.max(size.x, size.y, diagonal * 0.5, 1);

    this.ground.visible = false;
    this.ground.position.set(center.x, center.y, box.min.z - diagonal * 0.006);
    this.ground.scale.set(span * 4, span * 4, 1);

    this.floor.visible = true;
    this.floor.position.set(center.x, center.y, box.min.z - diagonal * 0.008);
    this.floor.scale.set(span * 5, span * 5, 1);

    this.contact.visible = true;
    this.contact.position.set(center.x, center.y, box.min.z - diagonal * 0.002);
    this.contact.scale.set(Math.max(size.x * 1.95, 1), Math.max(size.y * 1.95, 1), 1);
  }

  /** Aim the three-point rig and the shadow camera at the model. */
  private updateLightRig(box: Box3 | null): void {
    const center = this.tmpCenter.set(0, 0, 0);
    let scale = 100;

    if (box) {
      box.getCenter(center);
      scale = Math.max(box.getSize(this.tmpSize).length(), 1);
    }

    this.keyLight.position.copy(center).addScaledVector(KEY_DIRECTION, scale * 3);
    this.keyLight.target.position.copy(center);
    this.keyLight.target.updateMatrixWorld();

    const shadowCamera = this.keyLight.shadow.camera;
    const extent = scale * 1.7;
    shadowCamera.left = -extent;
    shadowCamera.right = extent;
    shadowCamera.top = extent;
    shadowCamera.bottom = -extent;
    shadowCamera.near = scale * 0.2;
    shadowCamera.far = scale * 7;
    shadowCamera.updateProjectionMatrix();

    this.rimLight.position.copy(center).addScaledVector(RIM_DIRECTION, scale * 4);
    this.rimLight.target.position.copy(center);
    this.rimLight.target.updateMatrixWorld();

    this.hemiLight.position.copy(center);
  }
}

function boxFromBounds(bounds: Bounds): Box3 {
  return new Box3(
    new Vector3(bounds.min[0], bounds.min[1], bounds.min[2]),
    new Vector3(bounds.max[0], bounds.max[1], bounds.max[2]),
  );
}

/** Soft elliptical falloff used for the contact shadow under the part. */
function createContactTexture(): CanvasTexture {  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.05,
      size / 2,
      size / 2,
      size * 0.5,
    );
    gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
    gradient.addColorStop(0.35, 'rgba(0,0,0,0.32)');
    gradient.addColorStop(0.7, 'rgba(0,0,0,0.1)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * Faint neutral light pool so the floor reads as a surface rather than a void.
 * Kept very low contrast: it must never compete with the model.
 */
function createFloorTexture(): CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size * 0.5,
    );
    gradient.addColorStop(0, 'rgba(255,255,255,0.11)');
    gradient.addColorStop(0.42, 'rgba(255,255,255,0.055)');
    gradient.addColorStop(0.72, 'rgba(255,255,255,0.018)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
