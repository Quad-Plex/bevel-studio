# Architecture

Bevel Studio is a static web app that also ships as a Tauri desktop build. The
geometry engine is plain TypeScript with no DOM, React or three.js imports, so
the same code runs in a worker, in Node tools and in tests.

## Execution contexts

| Context | Owns | Never does |
|---|---|---|
| Main thread (`src/app`, `src/panels`, `src/state`, `src/viewport`) | UI state, three.js scene, pointer picking, preview scheduling | Geometry maths |
| Worker (`src/engine/worker.ts`) | The repaired source mesh, the canonical edge table, the session epoch | Rendering, UI state |
| WASM (`manifold-3d`) | Solid booleans for the rolling-ball cut | File I/O, topology |

The main thread holds render copies only. Every message carries an `id`;
`preview` and `export` also carry the document `epoch`, which is incremented on
each import. A job whose epoch no longer matches is answered with
`error { code: 'superseded' }` instead of being applied to a different document.

## Import

1. `src/engine/io/stl.ts` detects binary or ASCII STL, rejects ZIP/3MF by
   signature, parses millimetres and welds vertices at 1e-4 mm.
2. `src/engine/repair/` fixes winding, drops duplicate and degenerate faces,
   fills holes up to 64 edges and removes tiny shells.
3. `src/engine/topo/` builds the canonical edge table: vertex pair, dihedral
   angle, convexity, flags and per-edge `maxWidth`.
4. The worker keeps the source mesh and edge table, then posts render arrays
   and the edge table as transferable buffers. It copies every buffer before
   transferring, so its own data is never detached.

## Preview and export

`EngineClient` allows one geometry job at a time. A burst of slider changes
collapses to the newest request (`queued`), because `bevelMesh` is synchronous
inside the worker and cannot be preempted. Preview and export both call the
same `bevelMesh` with the app's parameters; export additionally serialises the
result to binary STL.

`bevelMesh` runs in three steps:

1. **Plan** (`bevel/plan.ts`, no WASM). Vertices joined by sharp edges shorter
   than the irregularity scale (0.2 × width, at most 0.1 mm) become one node,
   so a sliver step reads as a single corner. Each selected edge gets a
   geometric width limit from short BVH ray casts along its faces
   (`bevel/bvh.ts`); node widths are the minimum of their edges and ramp along
   the selection graph. Every sweep end is either *joined* (it runs past the
   node and is trimmed by the miter plane against each other selected edge
   there, and by the planes of other features' faces) or *faded* (the
   selected run stops in the middle of a crease). Nodes whose features are all
   selected and of one kind get a rolling-ball vertex blend; an inside fillet
   between two beveled rims gets a rim chain along its arc.
2. **Build** (`bevel/sweep.ts`). Linked sweeps become one seamless chain solid
   with mitred rings; each section carries a band past the face planes that
   sweeps away irregularities and keeps the boolean off coplanar faces.
   Vertex blends are `region − (K ⊕ ball)` with the convex polytopes built by
   plane enumeration and hulls. Trims only act near their own end.
3. **Boolean** (`bevel/kernel.ts`). Inside fillets are unioned with the base,
   outside cuts are unioned and subtracted. The result is cleaned, welded and
   validated; when it is not watertight or has crossing triangles the kernel
   retries once with a 1e-4 mm arc inset and keeps the better result. A result
   that still fails is reported, and the Inspector blocks export.

## Invariants

- **One canonical edge enumeration.** Analyzer and kernel must produce the same
  edge ids for the same mesh; a repair pass always runs before topology.
- **Engine purity.** `src/engine/**` has no three.js, DOM or React imports.
- **Deterministic output.** Same mesh and parameters produce the same mesh.
- **No silent bad geometry.** A non-watertight result is reported and cannot be
  exported.
- **Transfers are copies.** Buffers handed to `postMessage` are copies, never
  the worker's only copy.
- **Bounded UI work.** No O(n) pass over the full mesh per frame. The brush
  projects only feature edges and tests occlusion against a BVH of the source
  mesh, built once on the first hover.

## Module map

| Path | Responsibility |
|---|---|
| `src/engine/io/stl.ts` | Parse, weld, STL serialisation |
| `src/engine/repair/` | Mesh repair pipeline |
| `src/engine/topo/` | Canonical edges, union-find, metadata |
| `src/engine/bevel/` | Plan (`plan.ts`), sweeps and blends (`sweep.ts`), BVH (`bvh.ts`), boolean and validation (`kernel.ts`) |
| `src/engine/worker.ts` | Session state, job serialisation, epoch checks |
| `src/engine/client.ts` | Main-thread façade, coalescing, timeouts, errors |
| `src/viewport/` | three.js scene, edge overlay, selection brush (`brush.ts`, `surface.ts`, `useEdgeSelection.ts`) |
| `src/state/` | zustand store, live preview, export |
| `src/panels/`, `src/ui/` | Inspector, status bar, glass component kit |

## Build and packaging

Vite builds `dist/` with `base: /`; serve it from the origin root. Tauri wraps
the same output, with a strict CSP that allows the module worker, the WASM
module and blob downloads. The Windows installer is built by NSIS.
