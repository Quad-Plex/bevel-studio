# Bevel Studio — orchestration

## Status (M0–M6 complete)

| Workstream | State | Evidence |
|---|---|---|
| K — kernel spike | done | `experiments/spike/report.json`, cube + hook numbers |
| E — import/repair/topology | done | 42 tests total, 100 k-tri analysis in ~0.5 s |
| B — bevel kernel | done | 8 tests, hook in ~47 ms, 12 783.72 mm³ |
| W — worker runtime | done | serialized worker, coalesced previews, document epoch, transferable edge table |
| V — viewport | done | studio scene, silhouette fit, feature-edge overlay |
| P — selection | done (v1) | click, sweep-paint, Alt erase, undo/redo, select-all |
| I — inspector/export | done | live params, clamp + watertight guards, STL export |
| D — design system | done | glass kit, gallery at `/?gallery=1` |
| T — acceptance | done | `npm run acceptance` asserts and exits non-zero |
| M6 — Tauri packaging | **done** | NSIS installer + `app.exe`; Rust 1.100, WebView2, CSP set |

Acceptance: 12 783.72 mm³ vs 12 788.47 mm³ hand-made (−0.04 %), bbox within
0.05 mm, one manifold shell, 2 672 triangles (CSG retriangulation).

Known gaps: loop/ring and silhouette-sweep selection; concave-edge bevels; BVH
for pointer picking on million-triangle meshes; WASM heap growth across
repeated previews is not measured. Geometry: the all-convex selection still
self-intersects at the plate corners — detected, warned and export-blocked, but
not yet fixed (needs a chain-consistent clamp); R6/R7 repair policies and the
maxWidth formula still differ from PLAN §4.3. See `reviews/` for the full audit.

Milestones M0–M5 of `PLAN.md`, split into workstreams with one owner each. The
integrator (main session) owns this document, `package.json`, `src/app/App.tsx`,
`src/engine/types.ts`, `src/engine/protocol.ts` and `src/state/store.ts`.

## Workstreams

| ID | Responsibility | Milestone | Owns (write access) | Depends on |
|----|----------------|-----------|--------------------|------------|
| W0 | Scaffold, contracts, integration, visual QA | all | `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/app/**`, `src/engine/types.ts`, `src/engine/protocol.ts`, `src/state/**` | — |
| K | **Kernel spike**: numerical proof of the cut-solid boolean bevel | M0 | `experiments/spike/**` | W0 |
| V | **Viewport**: renderer, camera, lighting, STL load, edge overlay, empty state | M1 | `src/viewport/**`, `src/app/app.css` | W0 |
| D | **Design system**: glass primitives, controls, gallery | M5 (starts early) | `src/ui/**`, `src/dev/**`, `src/styles/tokens.css` | W0 |
| E | **Import + repair + topology**: STL hardening, weld, orientation, holes, edge table with `maxWidth` | M1 | `src/engine/io/**`, `src/engine/repair/**`, `src/engine/topo/**`, `src/engine/meta.ts` | W0, K |
| B | **Bevel kernel**: cut solids, corners, clamp, batch boolean, validation, creased normals | M3 | `src/engine/bevel/**` | K, E (types only) |
| W | **Worker runtime**: protocol, job queue, latest-wins preview, progress, cancel | M2 | `src/engine/worker.ts`, `src/engine/client.ts` | E, B |
| P | **Selection**: auto-candidate tuning, click, paint, loop/ring, silhouette sweep, undo | M2 | `src/viewport/selection/**`, `src/state/selection.ts` | V, E |
| I | **Inspector + export flow**: parameters, warnings, compare, export sheet, shortcuts | M3–M4 | `src/panels/**`, `src/state/panels.ts` | D, W |
| T | **Acceptance harness**: invariants, reference STL comparison, synthetic corpus, perf gate | M4 | `tests/**`, `tools/**` | E, B, W |
| R | **Review**: geometry correctness, architecture, UX/design, copy | all gates | `reviews/**` (read-only elsewhere) | all |

## Waves and gates

**Wave 1 — feasibility and shell.** K, V, D in parallel.
Gate: `npm run build` green; K reports cube + hook numbers; viewport renders the
unoptimized hook with a placeholder edge overlay; gallery page renders.

**Wave 2 — engine and interaction.** E, B, P, I in parallel (W wired by integrator).
Gate: import → repair → edge table in a worker; selecting edges by click and paint
works on the reference model; bevel preview updates live at ≥ 15 fps on 100 k tris.

**Wave 3 — acceptance and review.** T builds the harness and reference test; R1
(geometry) and R2 (product/code) review. Gate: reference STL reproduces 640–670
triangles and 12 660–12 920 mm³ from the unoptimized file, one manifold shell.

**Wave 4 — M5 design pass and fixes.** Integrator + D apply review findings, motion,
empty/loading/error states, final screenshots.

## Frozen contracts

- `src/engine/types.ts` — `MeshData`, `EdgeTable`, `MeshMeta`, `BevelParams`,
  `BevelResult`. Changing a field breaks every workstream, so propose first.
- `src/engine/protocol.ts` — worker requests/responses, typed arrays transferred.
- `src/engine/io/stl.ts` — `parseStl(buffer, tolerance) → { mesh, format, triangles }`.
- `src/engine/meta.ts` — `computeBasicMeta(mesh, name) → MeshMeta`.
- `src/state/store.ts` — `useApp` plus `countSelected`.
- `src/ui/index.ts` — component API (see D's brief).

## Rules for every agent

1. Read `PLAN.md` sections for your milestone and this file before coding.
2. Write only inside your owned paths. Do not edit another workstream's files.
3. No new dependencies without asking the integrator. Read the installed package's
   `.d.ts` before using an unfamiliar API; never guess.
4. Never start a dev server. Verify with `npm run typecheck` and `npm run build`
   (and `npm test` where tests exist).
5. Pure functions in `src/engine/**`: no three.js, no DOM, no React.
6. Deterministic output: same input + params ⇒ byte-identical mesh.
7. Performance is a feature: no per-frame allocations, no O(n²) over full meshes.
8. Report back with: files changed, verification command + result, open risks.
   Keep it under 400 words.

## Milestone definitions of done

- **M0** cube, rounded cube and reference hook bevel successfully with the cut-solid
  approach; volume/triangle numbers within 1 % of prediction; timing logged.
- **M1** drag an STL in, see it lit and framed, edges extracted with dihedral and
  convexity, repair report shown, no console errors.
- **M2** candidates pre-marked; click, paint, loop/ring and silhouette sweep work;
  undo/redo; selection survives parameter changes.
- **M3** width/segments/profile live-preview with clamp warnings, latest-wins
  scheduling, correct corners and terminations, no flap faces.
- **M4** export binary STL preserving units and origin; reference acceptance passes;
  validation panel reports watertight/volume/genus.
- **M5** liquid-glass pass, motion, empty/loading/error states, keyboard map,
  copy reviewed, screenshots approved.

## Deviations from PLAN.md (deliberate)

- **Plain three.js, no react-three-fiber**: one imperative renderer we control is
  less version-coupled and better suited to 1 M-triangle overlays and custom picking.
- **Hand-written CSS with tokens, no Tailwind**: the glass surface is bespoke; a
  shared token file keeps agents consistent.
- **Vite 8 + Node 26 + TypeScript 7**: upgraded after M5 (see below).
- **Tauri v2 shell**: wraps the same `dist/`; NSIS installer built.
- Pinned: `manifold-3d` 3.5.5, `three` 0.187, React 19, TypeScript 7.0.2.

## Toolchain (upgraded)

- Node 26.13.1 (portable zip at `.tools/node-v26.13.1-win-x64`, prepended to the
  user PATH; npm 11.20).
- Vite 8.3.8 (Rolldown), `@vitejs/plugin-react` 6.3.0, Vitest 5.1.0,
  TypeScript 7.0.2 — `tsc --noEmit` works on Node 26.
- Rust 1.100.0 (rustup, MSVC toolchain), Tauri CLI 2.12.4.
- npm 11 blocks postinstall scripts by default; `esbuild` was approved with
  `npm install-scripts approve esbuild`.

## Environment

Windows 10/11, PowerShell. Node 26.13.1, npm 11.20. Blender 5.3 with the MCP add-on is
available for visual verification of exported STLs. Reference models:
`C:\Users\basti\AI_printing\example_stl_beveling\`.
