# Viewport

The imperative three.js viewport for Bevel Studio. `Viewport.tsx` is the React
shell (empty state, drag & drop, loading and error states); everything below it
is plain three.js so the selection workstream can query the scene without going
through React.

## Files

| File | Role |
|---|---|
| `scene.ts` | `SceneController`: renderer, Z-up camera, orbit controls, studio rig, shadows, render-on-demand, framing |
| `meshView.ts` | `MeshView`: zero-copy `BufferGeometry`, 30° creased normals, bevel-band tint, wireframe overlay |
| `edgeView.ts` | `EdgeView`: thin all-edge layer + capped fat selected-edge layer |
| `import.ts` | `useStlImport`: file picker, drop handling, parse + `computeBasicMeta`, loading yield, errors |
| `registry.ts` | `getActiveViewport()` — the live controller, or `null` |
| `theme.ts` | Reads a CSS token for canvas materials |
| `Viewport.tsx` | Component wiring and overlays |

## Coordinate system

The viewport is **Z-up** and works in **millimetres**, exactly like the STL. A
vertex at `(12, -4, 35)` in the file is at `(12, -4, 35)` in world space. Nothing
is recentred, rotated or rescaled, so world space and model space are the same.
`camera.up` is `(0, 0, 1)`.

## Controller lifecycle

`Viewport` creates one `SceneController` when it mounts and disposes it on
unmount (React StrictMode creates → disposes → creates again in development).
The controller owns the only WebGL context, the renderer canvas, the model, the
edge overlay, the light rig and the shadow plane. Do not dispose it from another
module and do not create a second renderer.

```ts
import { getActiveViewport } from '../viewport/registry';

const viewport = getActiveViewport(); // null before mount / after unmount / if WebGL failed
```

Render-on-demand: the controller renders one frame per `invalidate()` and keeps
rendering while OrbitControls damping or a camera animation is settling. If you
add an object or mutate an overlay, call `viewport.invalidate()`.

## Public API

```ts
class SceneController {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;   // fov 32, near 0.1, far 10000, Z-up
  readonly controls: OrbitControls;     // damping 0.08, zoomToCursor, screenSpacePanning
  readonly meshView: MeshView;          // meshView.object is the shaded Mesh
  readonly edgeView: EdgeView;
  readonly domElement: HTMLCanvasElement;

  setMesh(mesh: MeshData | null, bounds?: Bounds, flat?: boolean, bevelFaces?: Uint8Array | null): void;
  setWireframe(on: boolean): void;
  setEdges(table: EdgeTable | null, selection: Uint8Array | null): void;
  setSelection(selection: Uint8Array | null): void;
  frame(bounds?: Bounds, durationMs?: number): void;
  getBounds(): Box3 | null;
  invalidate(): void;
  screenToRay(clientX: number, clientY: number, target?: Ray): Ray;
  isPointerOverModel(clientX: number, clientY: number): boolean;
  dispose(): void;
}
```

### Selection workstream

- **Camera / renderer:** `camera`, `renderer`, `domElement` are public. Orbit
  controls already own pointer/wheel listeners on the canvas; disable
  `viewport.controls.enabled` while a paint stroke is in progress, re-enable on
  pointer up. Keyboard handling for tools belongs to the selection layer.
- **Picking:** `screenToRay(clientX, clientY)` returns a world-space `Ray` in
  model space. Pass a reusable `Ray` as the third argument to avoid allocations.
  `picking.ts` raycasts against `meshView.object.geometry`, which is the
  displayed creased geometry; the store's `MeshData` shares its coordinates.
- **Overlay:** `setEdges(table, selection)` is the entry point. The mask is one
  byte per edge id. Passing the same `EdgeTable` object again only refreshes the
  selection buffer — a click or paint stroke never rebuilds the base layer.
  `setSelection(mask)` is the same operation when the table has not changed.
- **Fat-line cap:** up to 30 000 selected edges use `Line2` fat lines (2.2 px,
  amber from `--selection`). Above that the overlay switches to thin amber
  lines, so selecting a whole 1 M-triangle model stays interactive. This is a
  visual downgrade, not an error.
- **Hover feedback:** add your own object to `viewport.scene` and call
  `viewport.invalidate()`; the controller's render loop will include it.
- `isPointerOverModel` is a bounding-box test for double-click-empty semantics,
  not an exact hit test.

### Mesh replacement

`setMesh` disposes the previous geometry and uploads the new typed arrays
directly. It never mutates or copies `positions` / `indices`. `bounds` is
optional (the store's `meta.bbox` saves one pass over the vertices).

The optional `bevelFaces` mask (one byte per triangle, 1 = bevel-solid face) adds
a second mesh that reuses the same vertex attributes and draws only those
triangles with the `--bevel-face` material. Nothing is duplicated except the
index list, so the tint costs one extra draw call, not another copy of the mesh.

The edge overlay stays visible during preview: the selection lives on the base
mesh and hiding it would make the marked edges impossible to refine.

`setWireframe(true)` shows the triangle edges of the displayed geometry as a
cheap overlay (shared geometry, `wireframe` material). It does not rebuild the
mesh and the setting survives a preview update.

## Import

Drag and drop anywhere on the viewport, the empty-state button, or the hidden
file input. `.stl` only (binary or ASCII). The flow sets `phase: 'importing'`,
yields two animation frames so the loading card paints, reads the file, calls
`parseStl` and `computeBasicMeta`, then `setMeshOnly`. Parse failures set the
store error and show a dismissible toast. The sample link fetches
`/fixtures/hook-base.stl` through the same path.

## Visual notes

The canvas is transparent; the graphite gradient and vignette are CSS behind it
(`src/app/app.css`, colours from `tokens.css`). Lighting is a `RoomEnvironment`
PMREM plus a warm key with a 2048 PCF-soft shadow, a cool rim and a low
hemisphere light. A `ShadowMaterial` plane and a soft contact gradient sit just
under the model's minimum Z. The shadow map only updates when the mesh changes.

## Known limits

- `toCreasedNormals` is three's implementation: one-time but memory-hungry on a
  1 M-triangle mesh (it de-indexes the geometry and builds a hash of 3 M
  vertices). The result is cached until the displayed mesh changes.
- Fat lines above 30 000 selected edges are replaced by thin amber lines.
- The base edge layer is one draw call for every edge; it is static per table.
