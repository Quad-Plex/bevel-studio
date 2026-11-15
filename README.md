# Bevel Studio

[![CI](https://github.com/Quad-Plex/bevel-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/Quad-Plex/bevel-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A526-informational)](package.json)

A local-first STL bevel editor for printable models. Import a mesh, let Bevel
Studio find the edges worth beveling, refine the selection by clicking or
painting, dial in a fillet, and export a watertight STL — without opening a
modelling suite.

Everything runs on the machine: no upload, no account, no network calls. The
desktop build wraps the same web app in a Tauri shell.

![Bevel Studio workspace](renders/final-loaded.png)

## Features

- **Import** — binary or ASCII STL in millimetres, origin preserved. The repair
  pipeline welds at 1e-4 mm, fixes winding, drops duplicate and degenerate
  faces, fills holes up to 64 edges and removes tiny disconnected shells.
- **Edges** — canonical edge table with dihedral angle, convexity, per-edge
  `maxWidth` and auto-detected candidates (convex, ≥ 20°).
- **Selection** — click, right-click erase, drag to paint, `A` for all
  candidates, `Ctrl+Z` / `Ctrl+Shift+Z` to undo and redo, `F` to refit.
- **Bevel** — width, segments and profile with a real rolling-ball cut solid
  and a Manifold WASM boolean, previewed live in a worker.
- **Export** — binary STL in the input's units and origin, blocked when the
  result is not watertight.

## Requirements

| | |
|---|---|
| Node | 26 or newer (`.nvmrc`) |
| npm | 11 or newer |
| Desktop build only | Rust stable, MSVC toolchain, Visual Studio Build Tools (C++), WebView2 |

## Quick start

```bash
npm ci
npm run dev        # http://localhost:5183
```

Build the static app with `npm run build` (output in `dist/`). Serve `dist/`
from the origin root; asset URLs are absolute.

### Desktop build

```bash
npm run tauri dev     # shell against the dev server
npm run tauri build   # NSIS installer in src-tauri/target/release/bundle/nsis/
```

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on port 5183 |
| `npm run build` | Typecheck, then build `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run acceptance` | Reference bevel gate, exits non-zero on drift |
| `npm run bench` | 1.08 M-triangle import and bevel benchmark |
| `npm run tauri <cmd>` | Tauri CLI |

## Reference acceptance

`npm run acceptance` bevels `public/fixtures/hook-base.stl` with the same
kernel the app uses and compares the result with a model that was made by hand
in Blender:

| | triangles | volume (mm³) | bbox (mm) |
|---|---|---|---|
| source | 140 | 12 871.80 | 47.88 × 62.15 × 35.00 |
| hand-made reference | 654 | 12 788.47 | 47.88 × 61.87 × 35.00 |
| **all convex edges** | 2 686 | **12 782.60** (−0.05 %) | **47.88 × 61.92 × 35.00** |

The tool lands within 0.05 % of the reference volume and 0.05 mm on the
bounding box. It keeps roughly 4× more triangles because CSG retriangulates
the trimmed faces; the shape, not the tessellation, is the acceptance
criterion. The command asserts volume, bounding box, shell count and triangle
window, and fails the build when the shape drifts.

## Architecture

```
src/
  engine/    pure TypeScript: STL I/O, repair, topology, bevel kernel, worker
  viewport/  three.js scene, edge overlay, picking, selection gestures
  panels/    inspector, top bar, status bar
  ui/        glass component kit, gallery at /?gallery=1
  state/     zustand store, engine client, live preview, export
src-tauri/   Tauri v2 shell, NSIS packaging
tools/       acceptance, benchmark and browser checks
```

The engine has no DOM, React or three.js imports, so it runs unchanged in the
worker, in Node tools and in tests. Edge ids are canonical across the analyzer
and the kernel, and a result that is not watertight cannot be exported. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data flow and the worker
contract.

## Performance

Measured on the development machine (Windows, Node 26) with `npm run bench`
(1 080 000-triangle cube, 51.5 MB STL) and `node tools/e2e-1m.mjs` (same file
through the browser):

| stage | Node | browser |
|---|---|---|
| parse + weld (2.16 M raw verts → 540 k) | 1.18 s | 7.57 s (whole import) |
| repair + edge table (1.62 M edges) | 3.64 s | — |
| bevel 400 edges (incl. boolean + cleanup) | 3.97 s | — |
| first rendered frame after import | — | 7 ms |
| hook (140 tris), bevel | 47 ms | — |

Above 300 k triangles the viewport switches to flat shading (facet normals in
the shader) instead of merging creased normals, which keeps the first frame
instant. The 1 M import is dominated by the worker's repair pass.

## Known limitations

- Beveling **all** convex edges also bevels the under-table plate of the
  reference model, whose corners are too tight for the current corner
  handling. Crossings are detected, flagged and export-blocked; deselect the
  four plate-corner edges until the clamp is chain-consistent.
- Loop/ring and silhouette-sweep selection are not implemented; click and
  paint are.
- Concave edges are rejected with a warning by design.
- Pointer picking is linear in triangle count, so painting on a
  1 M-triangle mesh is slow (no BVH yet).
- WASM heap growth across repeated previews is not measured.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — threads, data flow, invariants.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, conventions, review checklist.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.
- [`SECURITY.md`](SECURITY.md) — reporting a vulnerability.

## License

[MIT](LICENSE) © Bevel Studio contributors.
