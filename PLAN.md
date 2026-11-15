# Facet — browser-native STL bevel tool

**Status:** plan v1 · 13 Nov 2026
**Working name:** Facet (placeholder, trivially renameable)
**Target:** Windows desktop app (Tauri 2 shell), geometry 100% client-side.
**Owner of the problem:** selecting "the real outside edges" of a CAD-exported STL and
rounding only those, without Blender and without cleaning the mesh by hand first.

---

## 0. Decisions taken (from the scope answers)

| Question | Answer | Consequence |
|---|---|---|
| Bevel engine | **Pure browser (WASM)** | No Python, no Blender install, no server. Engine runs in a Web Worker. |
| Edge marking | **Auto-detect, then refine** | Import pre-classifies sharp *convex* edges as candidates; click/shift-click/paint to add or remove. Nothing has to be picked from scratch. |
| Parameters | **One set for all marked edges** | Single width/segments/profile. Data model keeps room for groups later. |
| Repair | **Auto-repair what is repairable** | Weld, de-duplicate, drop slivers, fix winding, close simple holes, report everything. |
| Delivery | **Packaged desktop app (Tauri)** | `Facet.exe` + installer, file dialogs, drag-and-drop, recent files. |
| Size target | **over 1M triangles** | Architecture must never do O(n) work per slider tick without caching. See §4.6. |
| Units | **Preserved, a given** | No rescaling anywhere. Width is entered in model units; the unit chip is display only. |

---

## 1. Product definition

### 1.1 The job to be done

> "I have a printable STL with sharp corners. I want the outside edges rounded the way a
> 0.5 mm × 4-segment bevel looks in Blender, on the edges I choose, in under two minutes,
> without touching Blender."

### 1.2 Success = these five sentences true

1. Drop an STL in, and within a second I see it, with the bevelable edges already suggested.
2. I mark the edges I want with clicks and a paint stroke — no pixel hunting, no extra
   cleanup step.
3. I drag "width" and "segments" and the shape updates while I drag.
4. The result is watertight, has no flap faces, spikes or slivers, and looks like a real
   bevel when shaded.
5. I hit Export and get an STL that prints the same size and orientation as the input.

### 1.3 Explicit non-goals (v1)

- No general modelling: no extrude, no booleans, no text, no sculpting.
- No concave/inner-edge filleting (only convex "outside" edges). §12 asks about it.
- No multi-object scenes, no assemblies, no build plate/collision checks.
- No mesh repair *wizard* — repair is automatic and opaque unless it fails.
- No fixing geometry that was already broken before import (e.g. a bevel that overran its
  corner). The tool guarantees it won't *create* that, not that it can undo it.
- No monetisation, no accounts, no telemetry. MIT/OSS-spirited build.

### 1.4 The one sentence that shapes the architecture

**A bevel on an STL is a boolean, not a mesh-surgery exercise.**

Blender's bevel is a half-edge algorithm with 20 years of corner cases; a browser tool must
not re-implement that. Instead: build the exact solid volume that a rolling ball of radius
*r* would remove at each selected edge, and subtract it with a robust CSG kernel. The output
is watertight by construction, and the failure mode that produced the flaps on the desk hook
(subdividing a corner with no room) cannot occur.

---

## 2. Reference meshes — measured

`example_stl_beveling/` (both binary STL, millimetres, Z up, one closed shell):

| | `Desk_Hook_Quatsch_unoptimized.stl` | `Desk_Hook_Quatsch_improved.stl` |
|---|---|---|
| triangles | 140 | 654 |
| welded verts | 72 | 329 |
| edges | 210 | 981 |
| boundary / non-manifold | 0 / 0 | 0 / 0 |
| shells | 1 | 1 |
| convex / concave edges (>0.5°) | 87 / 15 | 582 / 176 |
| distinct Z levels | 2 (0.00, 35.00) | 32 (bevel bands) |
| bbox (mm) | 47.88 × 62.15 × 35.00 | 47.88 × 61.87 × 35.00 |
| signed volume | 12 871.80 mm³ | 12 788.47 mm³ |
| median triangle area | 7.18 mm² | 0.54 mm² |

What this means for the build:

- The "unoptimized" file is **already a clean prism** (perfectly manifold, two Z levels,
  29-gon profile extruded). The pair tests **bevel quality and topology**, not repair.
  Repair has to be tested against synthetic broken meshes (§10.3).
- The improved file is **centred on X/Y**; the base is not. Export must therefore never
  silently re-centre, and the acceptance comparison must be translation-invariant
  (volume, bbox *size*, triangle count, manifoldness, and a rendered side-by-side).
- Material removed: **83.3 mm³** for the whole bevel set — a hard sanity check: our result
  must land within ~2% of that, and never *gain* volume.
- 87 convex edges on a 140-triangle part confirms the UX premise: "select all sharp" is a
  useful default and manual picking is the exception, not the workflow.

Expected acceptance result: **≈654 triangles, 12 788 mm³ ± 1%, bbox 47.88 × 61.87 × 35
± 0.02, one shell, genus 0.**

---

## 3. Architecture

```
┌──────────────────────────── Tauri 2 (Rust, thin) ────────────────────────────┐
│  window · native open/save dialogs · drag-drop paths · recent files · menu    │
├──────────────────────────────────── WebView (React) ────────────────────────┤
│                                                                              │
│  UI thread                        Worker thread(s)                           │
│  ─────────                        ─────────────────                           │
│  React 19 + Zustand               geometry.worker.ts                          │
│  three.js scene                   ├─ stl reader / writer                      │
│  three-mesh-bvh picking           ├─ repair pipeline                          │
│  overlay lines (edges, hover)     ├─ half-edge graph + classification         │
│  glass UI (CSS backdrop-filter)   ├─ bevel planner (cut-solid builder)        │
│                                   └─ Manifold WASM (booleans, validation)     │
│        ▲                                    │                                 │
│        └──── transferable ArrayBuffers ─────┘  latest-wins, cancellable       │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Why a worker:** a 1M-triangle boolean takes 200 ms–2 s. On the UI thread that is a frozen
app; in a worker it is a spinner over a still-interactive viewport.

**Why Manifold:** it is the only WASM CSG kernel with guaranteed-manifold output, exact
predicates and batch booleans. `manifold-3d` (Apache-2.0) ships a ~250 KB wasm module.
`three-bvh-csg` exists but is slower, less robust and not guaranteed manifold — wrong
foundation for a tool whose entire promise is "no broken geometry".

**Why not three.js CSG / no bevel library:** there is no maintained JS bevel library.
Writing a half-edge bevel is the thing we are explicitly avoiding (§1.4).

---

## 4. Geometry engine (the core)

### 4.1 Import

1. Read the file as `ArrayBuffer`.
2. Format detect: binary if `84 + 50·n === byteLength` with `n` from offset 80; else ASCII
   (`solid` header + `facet normal` tokens). Both writers exist in-house (~80 lines each)
   so we control determinism and can preserve the header.
3. De-interleave positions into `Float32Array`, drop the per-triangle normals (recompute —
   STL normals are frequently wrong), keep the triangle order.
4. Record `sourceName`, `byteLength`, `triCount` for the header/export.

**Units:** STL has no unit field. We assume millimetres for display (the 3D-printing
convention), never convert, never scale. The chip shows `mm` with a tooltip: "values are
model units; nothing is rescaled".

### 4.2 Repair (automatic, reported, non-destructive)

Runs on import, in this order, each step instrumented for the report:

| # | Step | Method | Report line |
|---|---|---|---|
| R1 | Weld | spatial hash, tolerance `max(1e-6, 1e-6 · bboxDiag)` | "welded 128 duplicate vertices" |
| R2 | Degenerate removal | drop triangles with repeated index or area < `tol²` | "removed 2 slivers" |
| R3 | Duplicate faces | canonical sorted-index key | "removed 1 duplicate face" |
| R4 | Winding | flood-fill orientation across manifold edges, majority vote per shell, flip shell if its signed volume is negative | "fixed 214 flipped faces" |
| R5 | Split non-manifold vertices | duplicate a vertex per face fan at bow-tie vertices | "split 3 non-manifold vertices" |
| R6 | Hole closing | find boundary loops; if a loop is planar within `1e-4·diag` and convex-ish, cap it with a fan; otherwise mark as unresolvable | "closed 2 holes" |
| R7 | Shell selection | keep the largest closed shell; list others in the report with a "keep anyway" toggle | "kept 1 of 2 shells" |
| R8 | Validate | every edge has exactly 2 faces, no zero-area faces, volume > 0 | gate: `engineReady` |

If R8 fails, the app **still opens** and allows selection/inspection, but the Bevel panel
shows a disabled state with the exact reason and an offer: *"Close holes automatically"*
(R6 aggressive: ear-clip any boundary loop, not just planar ones) or *"Simplify to a printable
shell"* (deferred, see §12).

Rationale for non-destructive: the user's mental model is "my file is being beveled", so the
original bytes stay untouched and Export writes a new file.

### 4.3 Topology graph & classification

Built once per import, cached, reused by every bevel recompute:

```
positions: Float32Array (3n)
faces:     Uint32Array  (3m)          // indices
he:        Uint32Array  (3m)          // half-edge: next = he ^ 1 style twin pairs
edgeOf:    Uint32Array  (3m)          // half-edge -> undirected edge id
angle:     Float32Array (E)           // dihedral, degrees
convex:    Uint8Array   (E)           // 1 convex, 0 concave, 2 ambiguous(coplanar)
maxWidth:  Float32Array (E)           // safe radius, see 4.4.4
```

Convexity test (robust, no normals-sign pitfalls):
for edge `(a,b)` with faces `f1`, `f2`, `n1 = normal(f1)`,
take the vertex `p` of `f2` not in `{a,b}`; the edge is **convex** iff
`dot(n1, p − a) < −ε` (the neighbour lies behind face 1). This is the same test used in the
probe script that produced §2, and it agreed with the signed-volume check.

`maxWidth[e]` = 0.45 × the shortest of:
- the altitude of each adjacent triangle from the edge (distance edge→opposite vertex),
- the length of every edge sharing a vertex with `e`,
- half the distance from `e` to the nearest *other* selected edge at each endpoint.

This is the number that stops the "bevel with no room" failure before it happens. Blender's
`clamp_overlap` does this implicitly; we do it explicitly and *tell the user the number*.

### 4.4 Bevel construction — "cut solid" sweep

For each selected convex edge `e = (A,B)`, adjacent faces `f1,f2`, outward normals `n1,n2`,
inward `m1 = −n1`, `m2 = −n2`, radius `r`, segments `s`, profile `p`:

**4.4.1 Centre of the rolling ball (2D, perpendicular to the edge)**

```
c = A + r · (m1 + m2) / (1 + m1·m2)
```
Degenerate when `m1·m2 → −1` (nearly flat edge): skip, treat as coplanar.

**4.4.2 Cross-section to remove** (the 2D region between the corner and the fillet)

```
t1 = A + r · m2        // tangent point on plane 1
t2 = A + r · m1        // tangent point on plane 2
polygon = [A, t1, arc(t1 → t2, centre c, s points), t2]
```

`arc()` for `p = 0.5` is a true circular arc; for other profiles it interpolates between the
straight chamfer (`p = 0`) and the arc (`p = 0.5`) and then between the arc and a "bulged"
superellipse (`p = 1`). Blender-equivalent behaviour for the values people actually use.

**4.4.3 Sweep and terminate**

Sweep the polygon along `d = normalize(B − A)` from `t = −ε` to `t = |AB| + ε`, with the
radius scaled by a taper function `r(t)`:

- both end vertices have **all** incident edges selected and convex → no taper; the corner
  sphere (§4.4.5) finishes it.
- the neighbouring edge at an end is **not** selected → taper `r` to 0 over the last
  `min(r, 0.25·len)` of the edge, ending exactly at the vertex plane. This is what makes a
  bevel *stop* somewhere without leaving a wall or a flap.
- the neighbouring edge is selected but the vertex is non-convex → taper to 0 over `r/2`.

Rings: `s + 2` vertices per station, `N` stations → quad side walls + two end caps (fan).
Result is a closed, manifold, self-intersection-free solid per edge.

**4.4.4 Clamping**

Requested `w` is clamped to `0.98 · min(maxWidth[e])` over the selection. The inspector shows
a warning chip: *"Width limited to 0.31 mm — 6 edges are narrower"* with a "show" link that
highlights those edges. No silent surprises, no exploded corners.

**4.4.5 Corners**

For every vertex where **all** incident edges are selected, convex and non-degenerate:

```
solve  n_k · x = −r  for the three planes            → centre q  (3×3 Cramer)
cut   = (cube at v, edge 4r)  −  sphere(q, r, s·2)
```

The union of the per-edge sweeps and per-vertex sphere cuts is exactly the rolling-ball
volume; subtracting it from the solid with a single boolean produces rounded corners that
match at the seams, with no miter artefacts and no "vertex mesh" options to get wrong.

**4.4.6 Boolean**

```
cuts   = Manifold.batchBoolean('union', cutSolids)     // chunked by 128 to bound memory
result = base.difference(cuts)
```

`batchBoolean` is the fast path (single tree build for many operands). Timing target for the
reference part: **< 15 ms**.

**4.4.7 Post-clean & validation**

```
result = result.simplify(r * 0.002)        // merge tangency slivers
assert result.status() == OK
assert result.genus() == 0
assert result.volume() < base.volume()     // bevels only remove material
```
If the volume delta is outside `[0, 1.5 × Σ expected cut volume]`, the result is rejected and
the UI explains which edge(s) failed, with a one-click "exclude these edges".

### 4.5 Shading & display

- Geometry is triangulated (Manifold output). Normals via `toCreasedNormals(geometry, 30°)`
  from three's `BufferGeometryUtils`, matching the "smooth by angle" look that worked in
  Blender — flat on big faces, smooth across the bevel strip.
- Optional "faceted" toggle (flat normals) for people who want to inspect the segments.
- Wireframe overlay drawn from the *display* mesh, not the original: after bevel the edge
  lines follow the new topology. A separate toggle draws the **original** shell as a ghost.
- Amber selection glow via a second line pass with a wider, transparent stroke.

### 4.6 Performance model

Everything is measured against this table; a milestone is not done until it holds.

| Operation | 50 k tri | 250 k tri | 1 M tri |
|---|---|---|---|
| parse + weld + graph | 120 ms | 400 ms | 1.4 s |
| selection click (BVH ray → edge) | < 5 ms | < 5 ms | < 8 ms |
| hover repaint | 16 ms | 16 ms | 16 ms |
| cut-solid build (100 edges) | 10 ms | 10 ms | 10 ms |
| boolean (reference part) | 15 ms | — | — |
| boolean (100 edges, full mesh) | 60 ms | 250 ms | 1.2 s |
| export STL | 40 ms | 200 ms | 800 ms |

Strategies, in order of application:

1. **Cache the base `Manifold`.** Parse/repair once; every parameter change reuses it.
2. **Cache cut solids by `(edge, r, s, p)`.** Only rebuild when the value actually changes;
   changing `segments` reuses the sweep frames, changing `width` rescales them.
3. **Debounce 80 ms + latest-wins.** A slider drag emits one job at a time; superseded jobs
   are dropped before they start, and a running job is not restarted (its result is shown,
   then the newest is queued).
4. **Coarse preview under load.** If the last exact job exceeded 250 ms, switch the live
   preview to a decimated proxy (`meshoptimizer.simplify`, 150 k tri, locked borders) and
   swap in the exact result on pointer-up. The proxy is for judging the shape, and the UI
   labels it as such with a subtle "preview" dot.
5. **Local extraction (v1.5).** Extract the 2-ring neighbourhood of the selection as a
   closed sub-solid (`trimByPlane` box, or `splitByPlane` + `compose`), boolean locally,
   then re-union with the untouched remainder. Cost becomes O(selection), not O(model).
   Only needed if the 1 M rows above miss; the interface is built so it can be added
   without touching the UI.
6. **Worker pool of 1.** CSG is memory-hungry; a second worker only for parse/export so the
   viewport never waits on I/O.

---

## 5. UX

### 5.1 Principles

1. **The model is the interface.** Panels float; nothing docks; the part is never smaller
   than 60% of the window.
2. **Nothing starts empty.** Sharp edges are pre-marked as *candidates* on import, so the
   first action is "yes, those" rather than "find them".
3. **Every automatic decision is visible and reversible.** Repairs, clamps and exclusions
   each produce a chip that can be inspected and undone.
4. **One primary action per screen.** Import → mark → shape → export.
5. **No modal dead ends.** Any error offers the next step in the same sentence that states
   the problem.

### 5.2 Screens

**S1 — Start**
Full-bleed glass card on a dark, softly lit background: a large drop target, "Open STL…",
and the last 3 files as rows with thumbnails (rendered once, cached in IndexedDB). Drag-over
inflates the card by 2% and lights the border with an accent sweep.

**S2 — Workspace** (the only real screen)

```
┌────────────────────────────────────────────────────────────────────────────┐
│        ┌───────────────────────────────────────────────┐                   │
│        │ hook_v3.stl   ·  140 tri  ·  mm      ↶ ↷  ⋯  │  ← top capsule    │
│        └───────────────────────────────────────────────┘                   │
│ ┌──┐                                                                       │
│ │ ▣│                                                        ┌────────────┐ │
│ │ ✎│                     ╭─────────╮                        │  Bevel     │ │
│ │ ◇│                    ╱           ╲                       │  Width 0.50│ │
│ └──┘                   │    MODEL    │                      │  ○───────○ │ │
│                        │             │                      │  Segments  │ │
│                        ╰──────╮      │                      │  ▮▮▮▯ 4    │ │
│                               ╰──────╯                      │  Profile   │ │
│                                                             │  ○────○    │ │
│  ╭─ 14 edges · 2 chains ─╮                                  │            │ │
│  ╰───────────────────────╯                                  │  Shading   │ │
│                                                             │  Mesh ✓    │ │
│                       click · shift-click · drag to paint    │  [Export]  │ │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Top capsule** (centred, floating): filename, triangle count, unit chip, undo/redo, overflow
  (fit, grid, screenshot, about).
- **Left rail** (56 px, icon-only with tooltips after 400 ms): *Select*, *Paint*, *Inspect*
  (measure/first-glance stats), *Compare* (hold). Keyboard `1 2 3`; `C` held = compare.
- **Right inspector** (340 px, glass, scrolls internally): Bevel · Shading · Mesh · Export.
  Sections are collapsible; the Bevel section is open by default.
- **Bottom-left chips**: `14 edges · 2 chains`, `0.50 mm × 4`, and warning chips
  (`Width limited`, `2 edges excluded`) — clickable.
- **Bottom-centre hint line**: contextual, one line, fades after 6 s of use
  ("Shift-click to add · Alt-click to remove · drag empty space to orbit").
- **Bottom-right**: axis gizmo, fit, ortho/persp toggle.

**S3 — Export sheet**
A bottom sheet (not a modal window): filename field, format (STL binary, disabled alternatives
greyed with reasons), summary `654 tri · watertight ✓ · 12 788 mm³ · Δ −83 mm³`, and
**Save**. Remembers the last directory via Tauri.

**S4 — Failure states**
- Import fails to parse → "This file isn't a valid STL. First 4 bytes are `PK☺☻` — that's a
  3MF archive. [Open in 3MF viewer] [Choose another file]".
- Mesh can't be made manifold → the Bevel panel shows the exact failing edge count and the
  two repair escalations (§4.2 R8).
- Boolean fails → "The bevel on 3 edges would cut through the part. Exclude them?"
  with the edges highlighted; one click retries.

### 5.3 Interaction spec

| Input | Behaviour |
|---|---|
| hover edge | edge glows white, cursor becomes a crosshair with a tiny dot; a chip near the cursor shows `124° · max 0.62 mm` (fades in after 250 ms) |
| click edge | toggle selected; amber glow + slight "pop" (scale 1.0 → 1.08 → 1.0 over 140 ms) |
| shift-click | add without toggling; drag with shift = add swept edges |
| alt-click / alt-drag | remove |
| drag empty space | orbit (LMB), pan (MMB/space+drag), orbit (RMB) |
| scroll | zoom to cursor |
| `F` | frame selection, or whole model if nothing selected |
| `1` / `2` | Select / Paint tool |
| `[` `]` | width −/+ 0.05 mm |
| `,` `.` | segments −/+ |
| `C` (hold) | compare: original mesh as a 35% ghost plus an A/B wipe line that follows the cursor |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo/redo over *selection and parameters* (not mesh, which is derived) |
| `Ctrl+O` / `Ctrl+S` | open / export |
| `Esc` | close sheet, then clear selection |

**Paint tool detail:** a screen-space brush (radius 12–80 px, `[`/`]` when in paint mode). While
dragging, every undirected edge whose *closest point in screen space* is within the radius and
whose depth is not occluded gets added (or removed with Alt). Only convex edges are eligible
unless "include concave" is enabled. Stroke is capped at 60 Hz and applied as one undo group
per pointer-down.

**Auto-detect on import:**
- candidates = convex edges with dihedral ≥ 20° (on the reference part: 87 edges).
- "Select all candidates" is a button in the Selection section; also `Ctrl+A`.
- **"Select silhouette from this view"** — projects candidates to screen space and keeps those
  whose two adjacent faces face the camera and away from the camera respectively. On a
  prismatic part like the desk hook this is *exactly* the "outside rim" the user had to fight
  for in Blender, in one click.
- **"Select chains"** — after the first click, the tool offers "extend along the chain" with
  `Shift+E`, walking the most-collinear continuation while the dihedral stays above the
  threshold. Ends at real corners, not at arbitrary vertex valence.

### 5.4 Visual design — liquid glass

The look is a dark studio with floating frosted panes; *not* neon, not a SaaS dashboard.

**Colour tokens**

```
--bg-0        #06080B        app background (behind the gradient)
--bg-1        #0E131A        viewport floor
--bg-glow     #1B2A38        radial glow behind the model, 40% opacity
--glass       rgba(255,255,255,.045)
--glass-hi    rgba(255,255,255,.075)   hovered / raised
--stroke      rgba(255,255,255,.10)
--stroke-hi   rgba(255,255,255,.18)    inner top highlight
--text-1      #E9EEF4
--text-2      #9AA7B6
--text-3      #5E6B7A
--accent      #7DE2C3   (to #56C8FF in gradients)
--selection   #FFB65C   selected edge
--candidate   #FFB65C @ 28%  unselected but sharp
--danger      #FF6E6E
--success     #63E6A8
--warning     #FFC46B
```

**Glass recipe** (one mixin, used everywhere)

```css
background: var(--glass);
backdrop-filter: blur(28px) saturate(150%);
border: 1px solid var(--stroke);
box-shadow:
  inset 0 1px 0 var(--stroke-hi),
  inset 0 -1px 0 rgba(0,0,0,.35),
  0 24px 60px -16px rgba(0,0,0,.65);
border-radius: 20px;
```

A 1 px accent line at the top edge of the active panel (a `::before` gradient at 60% width,
centred) marks focus without a glow-heavy look.

**Type:** Inter Variable; UI 13 px / 1.45; section labels 11 px, uppercase, `+0.08em`
tracking, `--text-3`; all numbers in JetBrains Mono with `font-variant-numeric: tabular-nums`.
Width and volume never jump when a digit changes.

**Motion:** one curve, `cubic-bezier(.22,1,.36,1)`, 200 ms for state, 260 ms for panels,
90 ms for slider feedback. Panels enter with opacity + 12 px translate + 1% scale. No
parallax, no springy overshoot on data-bearing UI (it makes numbers feel unreliable).

**Viewport look:** the model sits on a soft contact shadow, lit by a 3-point studio rig
(key warm-white from upper left, fill cool from the right, rim from behind) plus a subtle
matcap-like specular. No environment map download; a procedural gradient cube. Grid off by
default (it fights with STL scale), toggled with `G`.

**Responsive:** below 1100 px the inspector becomes a bottom sheet; below 760 px the rail
collapses into a single FAB. Tauri windows are resizable, so this is real, not theoretical.

**Accessibility:** all panels reachable by `Tab`; sliders are real `<input type=range>` with
`aria-valuetext` in millimetres; selection chips announce changes via `aria-live="polite"`;
contrast of `--text-2` on glass ≥ 4.5:1 after blur compositing; `prefers-reduced-motion`
removes all transforms and keeps opacity fades.

### 5.5 Copy

Plain, specific, no exclamation marks, no "Oops".

| Situation | Text |
|---|---|
| first run | "Drop an STL to start. Nothing is uploaded — this runs on your machine." |
| repair summary | "Tidied up before beveling: welded 128 duplicate vertices, removed 2 slivers, fixed 214 flipped faces." |
| clamp | "Width limited to 0.31 mm — six edges are narrower." |
| no edges | "No convex edges above 20°. Lower the threshold to see more." |
| export | "654 triangles · watertight · 12 788 mm³" |
| failure | "The bevel on 3 edges would cut through the part. Exclude them and try again?" |

### 5.6 Onboarding

No tour. A single line under the first model: *"Sharp edges are already marked. Click to keep
them, Alt-click to remove."* Disappears after the first click and never returns (localStorage).

---

## 6. Project structure

```
bevel-studio/
  PLAN.md                     ← this document
  README.md                   ← how to run, how to build the installer
  src-tauri/
    src/main.rs               ← window, dialogs (plugin-dialog), drag-drop, recents
    tauri.conf.json           ← bundle assets, CSP allowing wasm-eval for manifold
    icons/
  src/
    app/App.tsx, routes.tsx, shell.css
    ui/                       ← Glass, Slider, Segmented, Chip, Sheet, Tooltip, Toast
    viewport/Scene.tsx, CameraRig.tsx, ModelMesh.tsx, EdgeOverlay.tsx, Picking.ts
    state/document.ts, selection.ts, params.ts, jobs.ts, history.ts, report.ts
    engine/client.ts          ← worker RPC, cancellation, progress
    engine/protocol.ts        ← typed messages, shared with the worker
    workers/geometry.worker.ts
    engine/io/stl.ts, units.ts
    engine/topo/build.ts, classify.ts, chains.ts
    engine/repair/repair.ts
    engine/bevel/plan.ts, cutSolid.ts, corner.ts, boolean.ts, validate.ts
    engine/mesh/decimate.ts
  tests/
    fixtures/*.stl            ← reference pair + synthetic broken meshes
    engine/*.test.ts          ← vitest: geometry invariants on every fixture
    perf/bench.ts             ← 1 M tri timings, run manually in CI nightly
```

**Worker protocol** (typed, versioned, latest-wins by `docRev`):

```ts
type Req =
  | { t: 'import';  id: number; bytes: ArrayBuffer; name: string }
  | { t: 'bevel';   id: number; edges: Uint32Array; w: number; seg: number; profile: number }
  | { t: 'export';  id: number; format: 'stl-binary' };

type Res =
  | { t: 'imported';  id; positions: Float32Array; indices: Uint32Array; edges: EdgeTable; report: Report }
  | { t: 'beveled';   id; positions; indices; stats: Stats; warnings: Warning[] }
  | { t: 'failed';    id; reason: string; edges?: Uint32Array };
```

---

## 7. State model

```ts
type Doc = {
  source: { name: string; bytes: number; hash: string };
  base: MeshData;              // repaired, immutable
  report: RepairReport;
  edges: EdgeTable;            // angle, convex, maxWidth, chainId
  selection: Set<EdgeId>;
  params: { width: number; segments: number; profile: number };
  result: MeshData | null;     // derived
  warnings: Warning[];
  units: 'mm';
};
```

- Selection and params are the only real state; the mesh is a pure function of them
  (`bevel(base, selection, params)`).
- Undo/redo is a stack of `{selection, params}` snapshots (cheap, structurally shared).
- A `docRev` counter invalidates in-flight worker jobs.
- Persistence: `localStorage` for params/UI prefs, IndexedDB for recents and the last
  document (so reopening the app restores the session).

---

## 8. Dependencies

| Package | Why | Alternative rejected |
|---|---|---|
| `manifold-3d` | robust CSG, manifold guarantee, batch booleans | `three-bvh-csg` (slow, not manifold-safe), `@jscad/modeling` (no fillet, slow) |
| `three`, `@react-three/fiber`, `@react-three/drei` | rendering, camera, gizmo | raw three (more boilerplate) |
| `three-mesh-bvh` | raycast + nearest-point, fast picking and paint queries | three's built-in raycast (O(n)) |
| `meshoptimizer` | decimated preview proxy, vertex-cache optimisation | hand-rolled (worse quality/speed) |
| `zustand` | tiny store, no provider tree, works across the worker boundary cleanly | Redux (boilerplate), context (re-render storms) |
| `tailwindcss` + CSS vars | the glass system in §5.4 with a handful of custom classes | CSS-in-JS (runtime cost in a 60 fps viewport) |
| `motion` (framer-motion) | panel/chip transitions with layout animation | CSS only (fine, but sheet choreography suffers) |
| `@tauri-apps/plugin-dialog`, `plugin-fs`, `plugin-window-state` | native open/save, recents, window restore | browser file APIs (no real paths) |
| `vitest` + `playwright` | geometry unit tests, one E2E smoke | — |

Bundle budget: < 1.8 MB gzip JS + 300 KB wasm; the app must start cold in < 800 ms.

---

## 9. Milestones

Each milestone ends with something demonstrable; nothing is "80% done".

**M0 · Engine spike (riskiest first)**
Tauri window + three canvas + Manifold in a worker + hardcoded bevel of the reference hook.
*Done when:* the 140-tri hook bevels to 654 tri / 12 788 mm³ ±1%, manifold, in < 50 ms, and
the wasm loads from the bundled asset in the packaged build (not just dev).
This milestone exists to kill the plan early if Manifold's tangency handling is inadequate.
*Fallback if it is:* offset the cut solid by `+r·1e-4` and post-simplify; if that still
produces slivers, switch the kernel to `three-bvh-csg` only for the local patch.

**M1 · Import, repair, viewport**
Drop/open, parse, repair pipeline, stats, edge table, orbit/zoom/fit, edge overlay, repair
report card.
*Done when:* all fixtures open, the report is accurate, and a 1 M-triangle STL imports in
< 1.6 s.

**M2 · Selection**
Hover, click, shift/alt, paint, candidates, select-all-sharp, silhouette, chains, undo/redo,
chips.
*Done when:* marking the reference part's outer rim takes ≤ 3 interactions and no misclicks.

**M3 · Bevel + live preview**
Cut-solid builder, corners, clamp, warnings, debounce, coarse preview, shading toggle.
*Done when:* dragging width from 0.1 to 1.0 stays interactive on 250 k tri and the reference
result matches §2.

**M4 · Export & acceptance**
STL writer, save dialog, export sheet, reference acceptance script (§10.2).
*Done when:* exported file re-imports as one manifold shell with the expected numbers.

**M5 · Design pass**
Glass tokens, motion, empty/failure states, copy, onboarding line, responsive sheets,
keyboard map, accessibility audit.

**M6 · Hardening & packaging**
1 M stress pass, fixture corpus, installer, icon, window state, recents, crash-safe autosave
of the session.

Stretch (not committed): multiple bevel groups, concave edges, 3MF in/out, "stacked passes".

---

## 10. Test plan

### 10.1 Invariants (run on every fixture, every CI build)

- exactly 2 faces per edge, 0 boundary edges, 1 shell
- no zero-area triangles, no edges < `1e-6`
- `volume(result) ≤ volume(base)`
- `volume(base) − volume(result)` within 1.5× the analytic cut volume of the selection
- genus unchanged when beveling a closed convex-edge set on a genus-0 part
- deterministic output: same input + params → byte-identical STL

### 10.2 Reference acceptance (the user's own test)

```
open example_stl_beveling/Desk_Hook_Quatsch_unoptimized.stl
select the outer rim (candidates + silhouette), deselect the wedge zone
width 0.50 mm · segments 4 · profile 0.5
export → compare against Desk_Hook_Quatsch_improved.stl
```

Pass criteria: 640–670 triangles · volume 12 660–12 920 mm³ · bbox 47.88 × 61.87 × 35.00
±0.02 · one manifold shell · visual side-by-side indistinguishable at 1:1.
The comparison is translation-invariant (the improved file is re-centred; the base is not).

### 10.3 Fixture corpus (synthetic, generated by a script in `tests/fixtures`)

| Fixture | Tests |
|---|---|
| duplicate verts everywhere | weld |
| duplicated faces | dedupe |
| one flipped shell | winding repair |
| open box (one missing face) | hole closing |
| non-manifold T-junction | vertex split or graceful refusal |
| self-intersecting "bow tie" | boolean robustness |
| already-beveled edge | bevel-on-bevel |
| 0.01 mm thick plate | clamping prevents blow-through |
| 1 M tri greeble | performance budget |

### 10.4 Perf gate

Nightly bench asserts the §4.6 table on the reference machine; a regression > 25% fails.

---

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Manifold leaves slivers where cylinder is tangent to a face | medium | M0 spike proves it or not; `simplify` + epsilon inflation; worst case: local kernel swap |
| Repair cannot make a scan manifold | medium | clear failure UI + "close holes" escalation; voxel remesh deferred |
| 1 M tri + many edges too slow for "live" | medium | debounce, cached cuts, coarse proxy, local extraction (§4.6.5) |
| Tauri + wasm + CSP packaging breaks only in the bundle | medium | M0 tests the packaged build, not `npm run dev` |
| Corner quality with partial selections | medium | taper rule (§4.4.3) + visual fixture of a partially beveled cube |
| Colour/AA of 1 px lines on HiDPI | low | instanced wide lines with a minimum device-pixel width |
| STL unit ambiguity (m vs mm) | low | never rescale; unit chip + bbox readout in the same unit |

**Explicitly accepted trade-off:** a CSG bevel yields a triangulated result, so the export has
more triangles than a quad-based Blender bevel on the same shape (654 vs maybe ~400). At
0.5 mm on a print this is invisible; it is not worth a second engine.

---

## 12. Open questions

1. **Concave edges** — should the tool also round inner corners (fillets)? The cut-solid
   approach handles them with the same maths (the ball sits on the other side), but the
   selection UI then needs a "convex only" filter to stay safe. Cheap to add after M3.
2. **Name** — "Facet" is a placeholder; anything you prefer?
3. **Self-test screen** — should the reference acceptance (§10.2) be a hidden developer page
   (`Ctrl+Shift+D`) so you can re-run it yourself after future changes? Recommended yes.

---

## 13. Definition of done for v1

- Ships as a Tauri bundle you can double-click; no terminal, no Python, no Blender.
- Opens any of the fixtures; bevels the reference part to the numbers in §10.2.
- Handles 250 k tri smoothly, 1 M tri without dying.
- Nothing in the UI requires knowing what a half-edge, a normal or a manifold is.
- The bevel never produces a flap, spike or hole; when it can't bevel, it says why.
