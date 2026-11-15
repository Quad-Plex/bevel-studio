# Frontend review — Bevel Studio

**Date:** 13 Nov 2026 · **Scope:** React/three.js frontend, interaction, state/UX, CSS · **Mode:** read-only (only this file created)

## Verdict

**No P0. 7 P1, 18 P2.** The frontend is visually strong and the renderer lifecycle is mostly careful: StrictMode mount/unmount is handled, geometry/material/observer/RAF cleanup is present, and the 140-triangle hook is pleasant to use. The weak point is the **preview state machine**: a fresh import, or any selection-only edit after the selection is cleared, never starts a bevel, while the inspector says “Live”. Clearing the selection while a preview is in flight then wedges `phase='beveling'` and leaves Export permanently busy. Picking is O(n) with no BVH (measured **~90 ms per pointer-down** on the 1M fixture), undo is narrower than the README claims, and import/bevel warnings and engine failures have no UI. The result is an app that looks finished on the small reference part but is not yet trustworthy on a large model or after an error.

Verification: `npm run typecheck` (0), `npm run build` (`EXIT:0`), `npm test` (42 passed). Headless Chromium at 1440×900, `?sample=1`, plus the 51.5 MB `cube-1m.stl` fixture; measurements below are from scripts outside the repo.

## Findings

| ID | Sev | Area | Finding |
|---|---|---|---|
| P1-1 | P1 | Live preview | Preview never starts on import or selection-only edits; it appears only after a parameter change. |
| P1-2 | P1 | Live preview | Clearing the selection during a preview wedges `phase='beveling'`; Export stays disabled forever. |
| P1-3 | P1 | Inspector | Export's loading state is the preview phase, so the primary action spins/disables during every bevel. |
| P1-4 | P1 | Picking | Every pointer-down/move raycasts all triangles; ~90 ms/click at 1M with no BVH. |
| P1-5 | P1 | Undo | Undo/redo ignores select-all and all parameter changes; history lives in the gesture hook. |
| P1-6 | P1 | Errors | Preview/export failures are swallowed; a dead worker hangs the session with no message or retry. |
| P1-7 | P1 | Warnings | Repair and bevel warnings are computed but never shown; `repairs` is dropped. |
| P2-8 | P2 | Inspector | “Smooth shading” (and `creaseAngle`) is a no-op; the viewport hardcodes 30°. |
| P2-9 | P2 | Live preview | With “Show result” off, previews still run and each result rebuilds the base mesh behind a loading card. |
| P2-10 | P2 | Selection perf | A stroke copies the full mask per hit; StatusBar/Inspector scan all edges on every render. |
| P2-11 | P2 | State/UX | `stale` is always false and `progress` never renders; an old bevel is presented as current. |
| P2-12 | P2 | Panels | TopBar/StatusBar disagree with Inspector (base vs preview tris/watertight; clamp chip when hidden). |
| P2-13 | P2 | Import | A failed re-import labels the old model with the failed file's name. |
| P2-14 | P2 | Import UX | No Open/Browse control once a model is loaded; only drag-and-drop remains. |
| P2-15 | P2 | three.js | DPR changes are missed; shadow map/ground are dead code; floor is not hidden with the mesh. |
| P2-16 | P2 | Interaction | Lost pointer-up can leave controls disabled and turn hover into painting; no `buttons` check. |
| P2-17 | P2 | Picking | `EdgePicker` ignores its computed min bounds, allocates per candidate, and builds on the UI thread. |
| P2-18 | P2 | Interaction | No hover feedback/cursor; hint bar omits orbit, drag-paint, Alt erase, Shift+A and redo; F ignores selection. |
| P2-19 | P2 | Layout | Responsive collisions: hint bar over the inspector sheet ≤900 px; topbar/inspector overlap at 960; hint bar off-screen at 420. |
| P2-20 | P2 | A11y | `--fg-subtle` is 3.02–3.46:1 at 11 px (WCAG AA fail). |
| P2-21 | P2 | A11y | Canvas is not focusable/labelled; status bar is not `aria-live`; segmented control is unlabelled; tooltip is not described. |
| P2-22 | P2 | Hygiene | Dead store actions/state/exports, a gallery-only failure mock, an old mock HTML page, dead CSS/tokens, stale viewport README, favicon 404. |
| P2-23 | P2 | CSS | Hardcoded colours, duplicate rules, no bundled Inter webfont, and `outline: none` on the range input. |
| P2-24 | P2 | three.js perf | Preview/base-mesh shading is rebuilt synchronously on the UI thread; the 300 k threshold still pays `toCreasedNormals` per slider tick. |
| P2-25 | P2 | Keyboard | A/F/Ctrl+Z stop working while a range input has focus, and sliders keep focus after a drag. |

---

## P1 findings

### P1-1 — Live preview never starts on import or selection-only edits

**Where:** `src/state/useLivePreview.ts:25-27`, `src/panels/Inspector.tsx:22,37`, `src/viewport/Viewport.tsx:84`

**Evidence:** On `?sample=1` the inspector starts with **77 edges selected**, the chip says **“Live”**, and the stats show the source **140 tri / 12,871.8 mm³**. The effect returns because `before === null` (`paramsChanged` false) and `preview === null` (`hasPreview` false). Pressing ArrowRight on Width produces a preview: **2,296 tri / 12,838.5 mm³**. Clearing with Shift+A and clicking one edge back stays at **140 tri**; only another parameter change starts a preview. The comment says this is deliberate to avoid beveling a 1M import, but there is no way to leave the dead state except touching a parameter, and the UI never says “not previewed”.

**Fix (minimal):** keep the import tick guarded, then arm the preview on the first user selection edit. Track the last edge table in a ref; if `before === null` (or `edges` changed), record state and return; otherwise build whenever `before.selected !== selected || before.params !== params`. Expose a `previewState: 'not-built' | 'pending' | 'stale' | 'ready'` and label the chip accordingly instead of always “Live”.

### P1-2 — Clearing selection mid-preview wedges the busy phase

**Where:** `src/state/useLivePreview.ts:33-35,52-58,61-63`

**Evidence:** The empty-selection branch sets `preview = null` and returns without clearing `beveling`. The old request's cleanup sets `cancelled = true`, so its `.finally` skips `setBeveling(false)`. Reproduced on the hook: change Width, then Shift+A **150–175 ms later**; after 2 s the selection is 0 and Export still has `aria-busy="true"` (it is also disabled by `count === 0`, but the busy flag proves the phase never cleared; re-selecting edges leaves it disabled because `busy` still forces it). The only recovery is another parameter change or re-import. On a 1M model the in-flight window is seconds, so this is easy to hit.

**Fix:** in the `ids.length === 0` branch call `state.setBeveling(false)` before returning; and use a monotonically increasing request token so only the latest request may clear the phase (or clear it in the effect cleanup when no replacement request was started). Add a test for “start bevel → clear selection → phase returns to ready”.

### P1-3 — Export button reports someone else's work

**Where:** `src/panels/Inspector.tsx:24,124`, `src/state/export.ts:13,24`

**Evidence:** `busy = phase === 'beveling'` is passed to the Export button as `loading`. Changing Width makes the Export button spin and become disabled while the *preview* runs (observed `aria-busy="true"`, `disabled: true` for the duration). The same phase is set by `exportModel`, so preview and export cannot be distinguished. Combined with P1-2, the primary action can be disabled permanently even though nothing is running.

**Fix:** use a local `exporting` flag (or a separate `exporting` phase) for the button's `loading/disabled`; show preview activity with a separate chip/progress near the stats. Disable Export only for `exporting || importing || count === 0`, and catch export failures.

### P1-4 — Full-mesh raycast on every pointer event

**Where:** `src/viewport/scene.ts:388-393,371-381`, `src/viewport/useEdgeSelection.ts:110,146,151`

**Evidence:** `pickSurface` calls `Raycaster.intersectObject(mesh, false)` over every triangle; `screenToRay` also forces a `getBoundingClientRect` layout on each call, and the move handler calls it again for the stroke. `three-mesh-bvh` is installed (`package.json:24`) but never imported. Measured on the 1.08M-triangle cube: import **7.34 s**, pointer-down handler **91.2 / 89.3 ms**, pointer-move handler **70.2 ms**. That caps painting at ~14 Hz on CPU alone before rendering, store updates or React.

**Fix:** build a `MeshBVH` for the displayed geometry once per `setMesh` and use `acceleratedRaycast` (or `bvh.raycast`) in `pickSurface`; cache the canvas rect on resize/scroll instead of reading it per move; throttle move picking to rAF and reuse the last ray. If the BVH is considered too large for the base mesh, at least use the edge picker in screen space and only raycast to obtain depth when a hit exists.

### P1-5 — Undo/redo is narrower than documented

**Where:** `src/viewport/useEdgeSelection.ts:36-53,67-87,121`, `src/state/store.ts:120-128`, `src/panels/Inspector.tsx:49,58,68,78`

**Evidence:** History is a ref inside the gesture hook and is pushed only on pointer-down. `selectCandidates` (A / Shift+A) bypasses it; `setParams` is never recorded. Measured: initial 77 → Shift+A 0 → **Ctrl+Z still 0**; Width 0.50 → 0.55 → **Ctrl+Z still 0.55**; a paint stroke 3 → Ctrl+Z 1 → Ctrl+Shift+Z 3 works. The README promises Ctrl+Z/Ctrl+Shift+Z undo/redo, and PLAN §5.3 says “undo/redo over selection and parameters”.

**Fix:** move history into the store as `{ selected, params }` snapshots. Commit before every user mutation: pointer-down, select-all/deselect-all, and the start of a slider/keyboard parameter gesture (coalesce the drag into one entry). Skip no-op snapshots. Keep the current 40-entry limit and clear on a new document. Expose `canUndo/canRedo` for buttons/tooltips.

### P1-6 — Silent preview/export failures; a dead worker hangs forever

**Where:** `src/state/useLivePreview.ts:41-55`, `src/state/export.ts:14-25`, `src/engine/client.ts:51-55`, `src/state/engine.ts:21-24`

**Evidence:** The preview catch only does `setPreview(null)` (Superseded is ignored); no store error or toast. `exportModel` has a `try/finally` but no `catch`, and `Inspector` calls it with `void`, so rejection is unhandled. `worker.onerror` rejects pending promises but does not mark the client dead or recreate the worker; `resetEngine` is never called. Terminating the worker after import and then changing Width left the app with **`aria-busy="true"`, Export disabled, no toast, no page error** after 3 s. A synchronous throw from `getEngine()` inside the preview timer has the same shape and leaves `beveling` true.

**Fix:** add an `onFatal` callback/store error; on `worker.onerror` (and a “no response” timeout) reject future requests immediately, terminate/reset the worker, show a toast with a Retry action, and always clear the busy phase via a request token. Wrap `getEngine().preview` in `try/catch` inside the timer, and catch export errors in `exportModel`/Inspector.

### P1-7 — Repair and bevel warnings are computed and thrown away

**Where:** `src/state/store.ts:14-19,28,90-107`, `src/state/useLivePreview.ts:45-50`, `src/viewport/import.ts:63`, `src/engine/types.ts:99`, `src/engine/bevel/kernel.ts:537-584`

**Evidence:** `AnalysisResult.repairs` is never passed to the store; `warnings` is stored but no panel reads it (`TopBar`/`Inspector` only render `watertight`). `PreviewState` has no `warnings`, so `BevelResult.warnings` is dropped by `useLivePreview`; only `clampedEdges` becomes a count. The kernel emits useful messages (skipped concave edges, width limited, non-manifold) that never reach the user. A user can select a concave edge (the click picker does not filter by `EDGE_CANDIDATE`) and get a preview where it is silently skipped.

**Fix:** store `repairs` and `warnings` from import, and add `warnings` to `PreviewState`; render a compact “Warnings/Repairs” section in the Inspector with severity tone and an icon, or a chip that expands into the messages. At minimum show `concave`/`clamp` messages next to the clamped count so the selection and the result agree.

## P2 findings

### P2-8 — “Smooth shading” toggle is a no-op

**Where:** `src/panels/Inspector.tsx:81-86`, `src/viewport/meshView.ts:14-15,82-99`, `src/engine/types.ts:116,127`

**Evidence:** `smoothing` is written to `params` but nothing reads it (grep: only the type and the Inspector). `MeshView` always creases at a fixed `CREASE_ANGLE_DEGREES = 30`, regardless of `params.creaseAngle`. With a preview present (2,296 tri), toggling Smooth shading off, waiting 2.5 s and comparing a model-only crop produced a **pixel-identical image**; toggling back was identical too. The toggle therefore only triggers a needless preview rebuild.

**Fix:** pass `smoothing`/`creaseAngle` through `Viewport` → `SceneController.setMesh` → `MeshView.setMesh` and include them in the mesh-effect deps; when `smoothing === 'flat'`, set `flatShading` and skip `toCreasedNormals`. Or remove both parameters and the toggle if the viewport is intentionally fixed at 30°.

### P2-9 — “Show result: off” still runs previews and rebuilds the base mesh

**Where:** `src/state/useLivePreview.ts:13-27`, `src/viewport/Viewport.tsx:84,92-93,121`

**Evidence:** `useLivePreview` never subscribes to `showPreview`, so a width change still posts a bevel (and occupies the worker) while the result is hidden. `Viewport` includes `previewMesh` in its effect deps; with `showPreview === false`, `mesh` falls back to `baseMesh`, `isBaseMesh` is true, so every hidden preview result calls `setMesh(baseMesh)` and `setBuilding(true)` — a full crease/import-path rebuild and a loading card flash for a result the user cannot see.

**Fix:** derive `activePreview = showPreview ? previewMesh : null` and use it for both the mesh choice and the effect deps; skip the preview effect entirely when `showPreview` is false (optionally keep a “stale” flag), so “hide to edit the original surface” also stops the work.

### P2-10 — Selection updates are O(edge count) per hit and per render

**Where:** `src/state/store.ts:111-117`, `src/viewport/useEdgeSelection.ts:172-175`, `src/viewport/edgeView.ts:124-130,222-238`, `src/panels/StatusBar.tsx:14-19`, `src/panels/Inspector.tsx:21`

**Evidence:** `toggleEdge` does `selected.slice()` for every edge hit; a stroke loop calls it once per hit, so one move that hits 8 edges performs 8 full-mask copies, 8 store updates and 8 renders. `EdgeView.applySelection` scans all edges on every selection change, and `refreshScale` re-runs it when zoom exceeds 5 %. `StatusBar` recounts `edges.count` candidates on every render and `Inspector`/`StatusBar` call `countSelected` (full mask scan) per render. On the 1M mesh `selected` is one byte per edge (~1.6 MB for 1.62M edges); a drag added 8 edges per move in the test and each update also pays the panel scans.

**Fix:** accumulate the stroke's hits into one mask copy and call `setSelection` once per pointermove; maintain `candidateCount` in the store when the table is built; maintain a `selectedCount` incrementally in selection actions (or memoize it) instead of scanning in render.

### P2-11 — Stale previews are shown as current; `stale` and `progress` are dead

**Where:** `src/state/store.ts:14-19,34,138`, `src/state/useLivePreview.ts:45-50`, `src/panels/Inspector.tsx:22`, `src/panels/StatusBar.tsx:29-30`

**Evidence:** `PreviewState.stale` is only ever set to `false`; nothing sets it true. `progress` is written by `engine.ts:15` but no panel imports it. During a width change the Inspector keeps showing the previous preview's triangles/volume (2,296 tri) and the old clamp count until the new result arrives; the only “busy” signal is the misused Export spinner (P1-3). On a slow 1M bevel the user sees an outdated shape with no indication.

**Fix:** mark `stale: true` immediately when params or selection change, clear on result, and render a small “Updating…” chip plus `Progress` fed by `progress` (or at least `aria-busy` on the Inspector). Show the preview stats as “updating” rather than silently mixing old numbers with new controls.

### P2-12 — TopBar/StatusBar disagree with the Inspector

**Where:** `src/panels/TopBar.tsx:16-19`, `src/panels/Inspector.tsx:22-23`, `src/panels/StatusBar.tsx:29-30`

**Evidence:** With a 2,296-triangle preview active, the Inspector says 2,296 while TopBar still says **140 tri** and “Watertight” from the base meta. With “Show result” off, the Inspector hides the clamp count (`clamped = 0`) but StatusBar still shows “19 limited” from the retained preview. Two triangle counts and two watertight states on screen at once is confusing.

**Fix:** share one `shownMeta = (showPreview && preview?.meta) || meta` selector between TopBar, Inspector and StatusBar; label base values as “source” if both are needed; gate the clamp chip on `showPreview` (or on the same stale/ready state).

### P2-13 — Failed re-import relabels the old model

**Where:** `src/state/store.ts:74,90-109`, `src/panels/TopBar.tsx:15`

**Evidence:** `beginImport` sets `fileName` immediately, while `fail` only sets `phase/error/preview` and leaves `mesh/edges/meta/selected` from the previous document. Reproduced: load `hook-base.stl`, upload `broken.stl`; the toast says “Could not read broken.stl…”, but TopBar shows **`broken.stl` + 140 tri + Watertight**, and the Inspector still says 77 edges of the hook.

**Fix:** keep the last successful `fileName` separate from `pendingImportName`; update the visible name only in `setImported`, or restore the previous name in `fail`. If there is no previous document, clear the doc so the empty state and the error are coherent.

### P2-14 — There is no Open/Browse control after the first import

**Where:** `src/viewport/Viewport.tsx:243-265,312-326`, `src/panels/TopBar.tsx:21-25`, `src/viewport/import.ts:43`

**Evidence:** The Browse button only exists in the empty state. Once `hasMesh` is true, the only way to load another STL is drag-and-drop; the hidden file input has no other trigger, and there is no Ctrl+O. The PLAN's top capsule and Ctrl+O are not implemented. A second drop during an import is also ignored silently (`busyRef.current` returns), with no “already importing” feedback.

**Fix:** add an Open icon button (or a small “Open” button) to TopBar wired to the same picker; lift `useStlImport` to App/a store-level file-picker singleton so both TopBar and Viewport can use it. Add Ctrl+O in the existing keyboard handler, and either queue the next file or show “finish the current import first”.

### P2-15 — DPR and shadow/ground dead paths

**Where:** `src/viewport/scene.ts:107-111,147,188-201,245-246,510-517,535-539`, `src/viewport/meshView.ts:44-45`

**Evidence:** `pixelRatio()` is only applied inside `resize()`, and `resize()` returns early when CSS width/height are unchanged, so moving the window to a monitor with a different DPR leaves the canvas at the old ratio. Shadows are configured (`shadowMap.enabled`, `needsUpdate`, `receiveShadow`, `mesh.castShadow`) but `keyLight.castShadow = false` and `ground.visible` is set false in `updateGround` as well as `setMesh`; the shadow map is never rendered and the “2048 PCF-soft shadow” in `viewport/README.md` does not exist. When `setMesh(null)` runs, `floor` is not hidden in the `else` branch.

**Fix:** set the pixel ratio before the size early-return and re-run it on a `matchMedia(resolution)` change; either enable the key light's shadow and the ground, or delete the shadow map/ground/`castShadow`/`receiveShadow` settings and the README claim. Hide `floor` in the `setMesh(null)` else branch.

### P2-16 — Lost pointer-up can strand controls and make hover paint

**Where:** `src/viewport/useEdgeSelection.ts:138-148,182-188`, `src/viewport/useEdgeSelection.ts:41-53`

**Evidence:** `onPointerMove` checks only `paint.current`/`pointerId`, never `event.buttons`; `endPaint` runs only for `pointerup`/`pointercancel` on the stage. There is no `lostpointercapture`, window `pointerup`, or `blur` fallback, and the edges effect resets the picker/history but not `paint.current` or `controls.enabled`. If a pointer-up is missed (alt-tab/OS dialog, capture loss, re-import mid-stroke), the next mouse move can keep toggling edges and orbit stays disabled until a successful model click. Simulated capture loss is not required to see the code path; the lack of a `buttons` guard is sufficient.

**Fix:** add a window-level pointer-up/blur fallback and a `lostpointercapture` handler that calls `endPaint`; in `onPointerMove` end the stroke when `event.buttons === 0`; reset `paint.current` and re-enable `controls` when `edges` changes. Use `event.currentTarget.setPointerCapture` with a try/catch so a failed capture cannot leave controls disabled.

### P2-17 — EdgePicker grid ignores its min bounds and allocates per candidate

**Where:** `src/viewport/picking.ts:13-15,53-57,124,132,139-141`, `src/viewport/useEdgeSelection.ts:47-49`

**Evidence:** `minX/minY/minZ` are computed but `index(value)` uses absolute `value / cell`; the packed key assumes indices in `[-4096, 4096)`. A small part far from the origin (common in CNC exports) can exceed that range and collide buckets, degrading a click to testing a large fraction of the table. `pointSegmentSq` calls `point.clone()` for every candidate tested; `EdgePicker.build` runs synchronously in an effect after import and builds JS `number[]` buckets for every edge (1.6M edges on the 1M fixture).

**Fix:** index relative to `minX/minY/minZ` (three separate offsets) and pack with a safe base derived from the actual grid extent; replace `point.clone().sub(a)` with a preallocated `Vector3`; consider building the picker in a worker or in time-sliced chunks, or replace it with a BVH once P1-4 lands.

### P2-18 — No hover feedback; the hint bar is incomplete

**Where:** `src/app/app.css:44-53`, `src/panels/HintBar.tsx:8-16`, `src/viewport/scene.ts:282-354`

**Evidence:** `.vp-stage` is `cursor: grab` and `:active` is `grabbing` even while painting on the model; there is no hover-edge highlight or cursor change, so the only feedback is after the click. The permanent legend lists LMB/RMB/MMB/Wheel/A/F/Ctrl+Z but omits **orbit (left-drag on empty space)**, **drag to paint**, **Alt+LMB erase**, **Shift+A deselect-all** and **Ctrl+Shift+Z redo**; it also says “Fit” although `frame()` always fits the whole mesh, not the selection (PLAN §5.3 says frame selection when there is one). The orbit gesture is the one control a new user cannot guess from the legend.

**Fix:** add the missing hints (and a second row or a compact “?” expansion), change “Fit” to “Fit model” until selection framing exists, and implement hover by running the existing `EdgePicker` on pointermove when no stroke is active, writing a hover id to the edge overlay. Change the cursor to `crosshair` when over the model/edge and `grab` only on empty space.

### P2-19 — Responsive collisions

**Where:** `src/panels/panels.css:225-254`, `src/app/app.css:361-383`, `src/viewport/Viewport.tsx:297-310`

**Evidence (measured with headless layout):** at 900×800 the inspector sheet occupies y=372–788 and the hint bar y=712–744, so the legend covers the sheet's “Clamp overlap” text; at 960×800 the topbar right edge is 624 and the inspector starts at 614 (10 px overlap); at 420 px the hint bar spans x=-72…492, with the left entries clipped off-screen. The error toast is also positioned `bottom: 24px`, so it overlaps the hint bar when both are present. The CSS moves the hint bar up at ≤1280 but never wraps or hides it, and moves the sheet only at ≤900 (PLAN says ≤1100).

**Fix:** move the sheet breakpoint to 1100; below 900 either hide the hint bar or make it `left:12px; right:12px; transform:none; max-width:calc(100% - 24px); flex-wrap:wrap; justify-content:center`, and place it above the sheet (`bottom: calc(52% + 16px)`) rather than on top of it. Give the topbar `max-width:calc(100% - 380px)` only while it is centered, or reserve the inspector width. Raise/lower the toast so it does not cover the legend.

### P2-20 — Low-contrast secondary text

**Where:** `src/styles/tokens.css:16`, `src/panels/panels.css:129-131,219`, `src/ui/ui.css:269-274,478`

**Evidence:** `--fg-subtle` is `#5c6a71`. Against the app background `#0b0e10` the contrast is **3.46:1**, and against the viewport top `#171e22` it is **3.02:1**. It is used at 11 px for the hint labels and stats headings and 10 px for unit suffixes, all normal-size text; WCAG AA requires 4.5:1. `#7a8992` gives 5.37/4.67 and would pass on both surfaces.

**Fix:** change `--fg-subtle` to `#7a8992` (or use `--fg-muted` for functional 11 px text) and re-check the glass-composited background; keep a separate token if a deliberately quieter decorative tone is needed.

### P2-21 — Canvas and status semantics are not accessible

**Where:** `src/viewport/Viewport.tsx:232`, `src/app/app.css:44-49`, `src/panels/StatusBar.tsx:21-32`, `src/ui/Segmented.tsx:31-64`, `src/ui/Tooltip.tsx:131-139`, `src/ui/ui.css:322-324`

**Evidence:** The canvas stage is a plain `<div>` with pointer handlers; it has `tabIndex=-1` (default), no `role`, no `aria-label`, and no keyboard path for adding/removing an edge. StatusBar has no `aria-live`, so selection changes are not announced despite the PLAN's requirement. The Segments control is a row of unlabelled toggle buttons (the `.field-label` span is not associated), and Tooltip renders `role="tooltip"` but never sets `aria-describedby` on the anchor/child. The range input sets `outline: none` on focus and relies on a thumb box-shadow, which disappears in forced-colours/high-contrast modes.

**Fix:** give the stage `tabIndex={0}`, `role="application"` and an `aria-label`/visually hidden instructions; add `aria-live="polite" aria-atomic="true"` to the status chips; wrap Segmented in `role="group"` with `aria-labelledby`; wire `useId()` into Tooltip's `aria-describedby`; keep a real `:focus-visible` outline on the slider (or add `outline` on the track in forced colours).

### P2-22 — Dead state, exports, files and docs

**Where:** `src/state/store.ts:18,34,39,51,57,76,129,139`, `src/viewport/scene.ts:262,357`, `src/viewport/meshView.ts:50`, `src/viewport/edgeView.ts:140`, `src/dev/Gallery.tsx:608-635`, `src/panels/panels.css:159-163`, `src/styles/tokens.css:9,17,50,69-70`, `mock-workspace.html`, `src/viewport/README.md:92-115`, `index.html`

**Evidence:** `setMeshOnly`, `clearSelection` and `reset` have no callers; `PreviewState.stale`, `progress`, `SceneController.setSelection`, `EdgeView.setSelection`, `SceneController.getBounds` and `MeshView.getBounds` are never consumed; `NumberField`/`Progress` are only used by the gallery; the gallery's “Failure state” (with Exclude/Show actions) has no counterpart in the app; `.statusbar-hint` is dead CSS; `--bg-glow`, `--radius-xl`, `--fg-inverse`, `--space-5/6/8` are unused tokens; `mock-workspace.html` is an unreferenced 206-line old “Facet” mock; `viewport/README.md` still claims the overlay is hidden during preview, import parses on the main thread and uses `setMeshOnly`, selection should build a BVH (none exists), and shadows exist. `index.html` has no favicon, producing a 404 in the console (verified).

**Fix:** delete the unused actions/state/APIs or wire them (especially stale/progress, see P2-11); either build the failure-state component from the gallery or remove the demo; delete the dead mock/token/class; update the viewport README; add a small favicon (`<link rel="icon" href="/favicon.svg">`) so the M1 “no console errors” gate is honest.

### P2-23 — CSS token drift and focus styling

**Where:** `src/ui/ui.css:103-106,130-135,287,429-470,491,604,638`, `src/panels/panels.css:83-90`, `src/styles/tokens.css:54-55`

**Evidence:** Many component colours/shadow tints are literal `rgba(125,226,195,…)`/`rgba(255,255,255,…)` values rather than `--accent-soft`/`--neutral-soft`/`--track` (e.g. primary button shadow, switch track, segmented background, value pill, number input), so a token change does not propagate. `.bs-number__input` is declared twice (base at 429, appearance reset at 467). `.eyebrow` in `panels.css` duplicates `.bs-eyebrow` in `ui.css` with slightly different weight/colour. `--font-ui` starts with Inter but no `@font-face` or font link exists, so Windows falls back to Segoe UI (metrics/spacing differ from the design). The slider's focus outline is explicitly removed at `ui.css:322-324`.

**Fix:** replace the literal tints with the existing semantic tokens; merge the duplicate input rules; use `.bs-eyebrow` in the Inspector; either bundle/link Inter or drop it from the stack and update the design notes; restore a visible focus ring (the thumb shadow can remain as an enhancement).

### P2-24 — Preview shading is built on the UI thread

**Where:** `src/viewport/meshView.ts:82-99`, `src/viewport/Viewport.tsx:92-115`

**Evidence:** Every displayed mesh below the dense threshold runs `toCreasedNormals` synchronously inside a `setTimeout`: the function de-indexes the geometry and hashes vertices, and the source comment itself says it can “cost seconds on a million triangles”. The import path only shows the loading card for the base mesh (`isBaseMesh`), so a 100–300 k preview result rebuilds normals with no spinner while the slider is being dragged; several queued results can freeze the tab. The stated M3 gate is “dragging width stays interactive on 250 k tri”, which is exactly the worst case before the 300 k flat-shading shortcut.

**Fix:** use the `dense`/flat-shading path while a slider drag is active (or lower the threshold for previews), then compute creased normals once the gesture ends; alternatively move normal generation into a worker or cache it per preview result. At minimum show the same “Preparing model” busy state for preview builds so the freeze is visible. (Timing at 250 k was not measured; this is a code-path/risk finding.)

### P2-25 — Global shortcuts die after touching a slider

**Where:** `src/viewport/useEdgeSelection.ts:56-69`, `src/viewport/Viewport.tsx:140-148`

**Evidence:** Both guards treat **every** `INPUT` as editable. A range slider keeps focus after a drag, so `A`/`Shift+A` (select all/clear), `Ctrl+Z` and `F` are ignored until focus moves elsewhere. In the headless run, Shift+A after focusing Width left the selection at 77 until we explicitly blurred the element; the same applies to F. The workaround is clicking the viewport, which may itself select an edge.

**Fix:** restrict the guard to text-entry controls (checks on `HTMLInputElement.type` for text/number/search/email/password/url/tel), `TEXTAREA`, `SELECT`, and `isContentEditable`; allow shortcuts from range/checkbox/radio/button. Alternatively blur the slider on `pointerup`. Keep arrow-key slider behaviour intact.

---

## What I verified

- Typecheck, production build and 42 tests pass.
- StrictMode double-mount: the renderer is disposed/recreated and the `?sample=1` auto-load is guarded; no double import observed.
- Disposal paths for mesh/edge geometry, materials, PMREM target, ResizeObserver, controls listeners and pending RAF are present and look complete.
- Left add (click and drag), right remove, right-drag erase (77→76→77→75 in the test), paint undo-redo (3→1→3), Shift+A clear and A select-all work on the hook; the middle-pan mapping is wired but was not separately re-measured. Context menu is suppressed on the stage and only there (inspector gets the native menu).
- Measured 1M picking, import, layout collisions, contrast, missing favicon, failed re-import, worker termination, smoothing no-op and preview dead-end as described above.
- `?gallery=1` renders and the kit components behave; the gallery is lazy-loaded.

## Unverified

- OS-level pointer capture loss (alt-tab, release outside the window) was reasoned from the missing listeners, not reproduced with a real window blur.
- `toCreasedNormals` timing at 250 k triangles was not measured (no fixture of that size); the code path and the comment's own “seconds on a million” claim make the risk credible.
- Real GPU context loss and WebView2-specific `backdrop-filter`/font behaviour were not tested.
- True uncaught worker exceptions (as opposed to `terminate()`) were not forced; the onerror path was inspected, and the terminate case demonstrates the no-recovery symptom.

## The 3 fixes I would do first

1. **Repair the preview state machine (P1-1, P1-2, P1-3).** Arm a preview on the first user selection edit, set/clear stale and `beveling` with a request token, and give Export its own busy state. This is the difference between “the app is broken” and “the app is working” on first contact.
2. **Make picking and selection O(log n) (P1-4, P2-10).** Build a `three-mesh-bvh` on the displayed mesh, cache the canvas rect, and batch one mask update per stroke move. Without this, the advertised 1M path cannot be painted or inspected.
3. **Make failures and undo honest (P1-5, P1-6, P1-7).** Move history into the store so select-all and parameters undo, surface preview/export errors and a dead worker with a retry, and render the repair/bevel warnings that are already computed. A local-first editor must not silently ignore a failed bevel or a repaired mesh.
