# Architecture review — Bevel Studio

**Date:** 13 Nov 2026 · **Scope:** architecture, worker protocol, build/packaging, docs · **Mode:** read-only (only this file was created)

## Verdict

**No P0. 8 P1, 15 P2.** The project typechecks, builds, runs 42 tests and produces a bevel within 0.04 % of the reference volume, so it is a credible prototype rather than a broken one. The weak point is the worker contract: “latest-wins” is only true while the WASM kernel is loading, a second import has no document epoch, and worker/kernel failures are either swallowed or permanent for the session. The acceptance harness is a printout, not a gate, and its published numbers no longer match the code. Packaging works (installer + `app.exe` exist) but is under-hardened: CSP is `null`, production sourcemaps ship, and the desktop icon/metadata are the Tauri defaults.

“P1” below means a real risk to the core promise or to recoverability; “P2” is significant debt/polish.

## Findings

| ID | Sev | Area | Finding |
|---|---|---|---|
| P1-1 | P1 | Worker protocol | “Latest-wins” only works during kernel loading; once ready, queued previews run to completion and cancel cannot preempt |
| P1-2 | P1 | Worker protocol | No document epoch: import can race an in-flight preview/export and mix new mesh with old edge ids |
| P1-3 | P1 | Worker lifecycle | Rejected kernel init is cached forever; a dead worker is never recreated and requests can hang |
| P1-4 | P1 | Transferables | The full edge table is structured-cloned inside `result`, ~79 MB at 1 M triangles |
| P1-5 | P1 | Error propagation | Bevel warnings are dropped; export can write a non-watertight result and export errors are unhandled |
| P1-6 | P1 | Acceptance | `npm run acceptance` never asserts; its output misses the README/PLAN gate yet exits 0 |
| P1-7 | P1 | Live preview | The first selection after import does not trigger a preview; “Live” is only true after a parameter change |
| P1-8 | P1 | Tauri security | `app.security.csp` is `null` (no CSP in the packaged app) |
| P2-9 | P2 | Protocol hygiene | Progress has no request id, is never rendered, and there is no protocol version/docRev |
| P2-10 | P2 | Worker memory | No explicit `Manifold.delete()`; a second topology is rebuilt in the worker; identity cache is unguarded |
| P2-11 | P2 | Edge contract | The frozen edge-id walk is duplicated and the two versions disagree on degenerate triangles |
| P2-12 | P2 | State lifecycle | `phase` is a single boolean; overlapping import/export/preview can clear each other |
| P2-13 | P2 | Dead controls | `smoothing`, `draft`, `limitAngle`, `miterJoin`, `creaseAngle` are sent/displayed but never used |
| P2-14 | P2 | Production bundle | Sourcemaps (4.3 MB) ship in `dist`; 866 kB chunk warning; Gallery is in the production build |
| P2-15 | P2 | Repo hygiene | No root `.gitignore`; `dist` (6 MB), `renders` (14 MB), `node_modules` (222 MB) are unignored |
| P2-16 | P2 | Tauri dev/static | `strictPort:false` conflicts with `devUrl:5183`; absolute `/assets` breaks `file://`/subpath static builds |
| P2-17 | P2 | Packaging identity | Default Tauri icon; Cargo says “A Tauri App”/“you”; no publisher, copyright or LICENSE |
| P2-18 | P2 | Dependencies | `three-mesh-bvh` and `@tauri-apps/api` are unused; no `engines`; “Pinned” is false |
| P2-19 | P2 | Tools | Hardcoded Chrome/4173 paths; `bench` leaves a 51.5 MB temp STL; acceptance writes into `renders/` |
| P2-20 | P2 | Fixtures | `public/fixtures` and `example_stl_beveling` are byte-identical copies; `dist/fixtures` is a third |
| P2-21 | P2 | Docs drift | Test counts, numbers, “Pinned”, M6 status, PLAN §7/§8/§9 and README performance claims are stale |
| P2-22 | P2 | Untrusted STL | No file/triangle cap; huge finite coordinates collapse the weld hash and can make import O(n²) |
| P2-23 | P2 | 1 M scale | Selection changes copy the whole mask per hit; counts scan all 1.6 M edges on every render |

---

## P1 findings

### P1-1 — “Latest-wins” is not latest-wins; cancel cannot preempt

**Evidence**

- `src/engine/client.ts:35-38` claims “a new preview supersedes the previous one so dragging a slider never queues.”
- `src/engine/client.ts:76-84`: every `preview()` call rejects the previous *promise* and immediately posts a new message. It has no in-flight/queued slot.
- `src/engine/worker.ts:23-25` dispatches each message with `void handle(...)`; `src/engine/worker.ts:83-93` runs `bevelMesh` synchronously. While that runs, the worker cannot process the next preview message at all.
- `src/engine/worker.ts:39-43`: `cancel` only assigns `latestPreview = target`. If the cancelled job is queued, it overwrites `latestPreview` with itself when it starts; if it is running, the assignment does not stop it.
- The `latestPreview !== request.id` check at `worker.ts:88` only has a chance to fire if a newer request arrived during `await ensureKernel()` (the WASM load). Once the kernel is ready, `await` yields only a microtask, and the synchronous bevel runs before the next message task.
- On the 1 M benchmark, a 400-edge bevel takes 3.6 s (`npm run bench` output), so a few parameter changes can queue several multi-second jobs.

**Fix (minimal):** coalesce on the main thread. Keep `inFlight` and a single `queued` request in `EngineClient.preview`; post only when idle; resolve/reject the queued promise when its turn comes. This avoids depending on worker message preemption. Add a counter/test that asserts at most one bevel runs for a burst of N previews. If true cancellation is required, add an `AbortSignal`-style flag checked between kernel stages, but do not claim preemption of the synchronous `bevelMesh`.

### P1-2 — No document epoch; import can race a preview/export

**Evidence**

- `src/engine/worker.ts:55-62`: `importMesh` replaces `source` and `edgeTable` globally.
- `src/engine/worker.ts:87-91`: a preview awaits `ensureKernel()`, then reads `source`, `request.edges`, and `edgeTable?.maxWidth`. If an import is processed during that await, the preview calls `bevelMesh(newSource, oldEdges, newMaxWidth)`.
- `src/engine/worker.ts:112-119`: export has the same shape and the same race.
- `src/engine/client.ts:58-69`: `importStl` does not cancel `livePreview` or bump any generation. `useLivePreview` only cancels via React effect cleanup, which may run after the worker's `previewed` message has already resolved the promise.
- If the kernel is already loaded, the opposite happens: the import message waits behind the synchronous bevel, so importing a new file appears to hang for the duration of the old preview.

**Fix:** add a monotonic `docEpoch` to the protocol. `import` increments it; `preview`/`export` carry the epoch and capture `source`/`edgeTable` at entry. Check `myEpoch === docEpoch` after every `await` and before `post`, and return a `superseded` response (or silently drop). On the client, `importStl` must cancel `livePreview`, increment its own epoch, and ignore any response whose epoch is old. Add a test that starts a preview, delays `initKernel`, imports a second fixture, and asserts the preview never bevels the new mesh with old ids.

### P1-3 — Kernel init failure and worker crash are unrecoverable and silent

**Evidence**

- `src/engine/worker.ts:126-131`: `kernelReady` caches the promise returned by `initKernel()`. If it rejects, every later `ensureKernel()` returns the same rejected promise. `src/engine/bevel/kernel.ts:52-66` correctly resets its own `loading` on failure, but the worker's cache defeats the retry.
- `src/engine/client.ts:51-55`: `onerror` rejects all pending promises and clears the map, but does not terminate/recreate the worker or mark it dead.
- `src/engine/client.ts:123-127`: `wait()` has no timeout. A `postMessage` to a terminated/crashed worker silently goes nowhere, so a later import/preview promise never settles.
- `src/state/engine.ts:21-24` defines `resetEngine()` but nothing calls it (grep: only the definition).
- `src/state/useLivePreview.ts:52-55` swallows every non-`SupersededError`, so a kernel failure produces no user-visible message.

**Fix:** wrap the init promise: `kernelReady = initKernel().catch((e) => { kernelReady = null; throw e; })`. On `worker.onerror`, mark the client dead, reject with a clear “geometry worker stopped” error, and create a fresh worker on the next request (or call `resetEngine` from a retry button). Add a request timeout (e.g. 120 s for 1 M bevels) so a dead worker cannot hang the UI. Surface the error in the store/Inspector rather than swallowing it.

### P1-4 — The edge table is copied by structured clone, not transferred

**Evidence**

- `src/engine/protocol.ts:24-25`: `imported` has `result: AnalysisResult`; `src/engine/types.ts:33-49` puts six typed arrays inside `EdgeTable`.
- `src/engine/worker.ts:66-80` sends `{ result }` in the message object and transfers only `positions.buffer`/`indices.buffer`. The edge arrays are therefore structured-cloned.
- At the benchmark's 1.62 M edges: `v` 13 MB, `position` 39 MB, `dihedral` 6.5 MB, `flags` 1.6 MB, `maxWidth` 6.5 MB, `tris` 13 MB — about **79 MB copied**, while the worker retains its own copy for `maxWidth`.
- `src/engine/protocol.ts:5-7` says large arrays “travel as transferable ArrayBuffers next to a plain result object, never nested inside it.” That is false for the edge table.

**Fix:** copy the edge arrays in `importMesh` (as already done for `positions`/`indices`) and add their buffers to the transfer list, extending `WorkerResponse` with explicit edge fields; keep the worker's originals for `maxWidth`. Alternatively, send the edge table in a separate transfer message and retain a copy in the worker. Add a 1 M import test that checks memory and that the edge arrays are not cloned.

### P1-5 — Warnings are dropped; export can ship a non-watertight mesh

**Evidence**

- `src/state/useLivePreview.ts:45-50` constructs `PreviewState` with `mesh`, `meta`, `clampedEdges`, `stale` only. `result.warnings` is discarded.
- `src/state/store.ts:18-19` has no warnings field in `PreviewState`; `store.warnings` (`store.ts:28`) is only import warnings and is not rendered anywhere in `src/panels` (grep: no `warnings` use).
- `src/panels/Inspector.tsx:22-24` shows only `meta` and `clampedEdges`; `StatusBar.tsx` shows only the clamp chip.
- `src/engine/bevel/kernel.ts:923-935` returns the closest mesh with `bevel.nonManifold` when the watertight check fails, and sets `meta.watertight = false` (`kernel.ts:957`).
- `src/state/export.ts:14-24` has `try/finally` but no `catch`; `Inspector.tsx:122` calls `void exportModel()`, so a failure is an unhandled rejection. Export never checks `meta.watertight` or the preview warnings.

**Fix:** add `warnings: MeshWarning[]` to `PreviewState`, pass `result.warnings` through, and render error-severity warnings in the Inspector/StatusBar. In `exportModel`, catch failures and set a visible store error; block export (or require an explicit confirmation) when the current preview/result is not watertight. Add a test that a failing boolean cannot be exported silently.

### P1-6 — Acceptance is a printout, not a gate; published numbers are stale

**Evidence**

- `tools/acceptance.ts:92-101` loops over two selections, writes STLs, and `console.log`s the lines. There is no assertion, no `process.exitCode`, and no comparison against PLAN §10.2.
- `npm run acceptance` exit code is **0** with these results:

```
all convex   2672 tri   12783.72 mm³   47.88 × 61.92 × 35.00   108 ms  NoError
outside only  542 tri   12799.06 mm³   47.88 × 62.15 × 35.00    20 ms  NoError
```

- `README.md:55` claims **1 668 tri / 12 784.04 mm³ / 47.88 × 61.92 × 35.00** for “all convex”. The triangle count is 60 % higher than documented.
- `PLAN.md:664-665` requires **640–670 tri**, 12 660–12 920 mm³, bbox y **61.87 ± 0.02**. “outside only” is 542 tri and bbox y 62.15, so it fails the documented gate.
- `tools/acceptance.ts:68` uses `clampOverlap: false` while the app default is `true`; `tools/acceptance.ts:78` hardcodes `midX < -16.9` rather than PLAN's silhouette selection. The harness therefore does not test the shipped default selection either.

**Fix:** assert `status === 'NoError'`, `shells === 1`, the triangle window, volume range, and bbox tolerance; print PASS/FAIL and set `process.exitCode = 1` on failure. Run the same params/selection the app uses (or document the difference explicitly). Update README/PLAN to the measured numbers, or fix the kernel/selection until they meet the gate. Add a `--update` mode if the reference numbers are intentionally regenerated.

### P1-7 — The first selection after import does not preview

**Evidence**

- `src/state/store.ts:90-107` `setImported` sets `preview: null`.
- `src/state/useLivePreview.ts:25-27`: `paramsChanged = before !== null && before.params !== params`; `hasPreview = preview !== null`; if neither, return. After import, a click/paint changes `selected` but neither condition is true, so no preview is sent.
- The user must move Width/Segments/Profile before seeing any bevel. `src/panels/Inspector.tsx:32` still labels the state “Live” whenever edges are selected.

**Fix:** track selection changes separately from import. If `selected` changed and `countSelected(selected) > 0`, schedule a preview even when `preview === null`; suppress only the initial import state (e.g. compare a `docEpoch`/`importedAt`). Alternatively add an explicit “Preview” action. Add a test: import → click one edge → a `previewed` response arrives.

### P1-8 — Tauri CSP is `null`

**Evidence**

- `src-tauri/tauri.conf.json:27` has `"csp": null`; `index.html` has no CSP meta. The packaged WebView therefore has no script/connect/worker restrictions.
- The app handles untrusted STL files, loads a 542 kB WASM module, and creates a module worker (`src/state/engine.ts:13-14`). Those are exactly the assets a CSP must allow deliberately.

**Fix:** set a strict CSP in `tauri.conf.json`, e.g. `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. Verify the packaged worker/WASM still load (the build currently references `/assets/worker-*.js` and `/assets/manifold-*.wasm`, both present). If dev needs looseness, use `devCsp` rather than leaving production open.

---

## P2 findings

### P2-9 — Protocol hygiene: no progress ids, no version, unused validator

**Evidence**

- `src/engine/protocol.ts:35` `progress` has no `id`; `src/engine/client.ts:129-133` routes progress before looking at `id`, so progress from a superseded preview/export updates the same slot as the current job.
- `src/engine/protocol.ts:11-36` has no version or `docRev`, despite `PLAN.md:541` describing “typed, versioned, latest-wins by `docRev`”.
- `isWorkerResponse` (`protocol.ts:38-40`) is never imported (grep: only the definition).
- `src/state/engine.ts:15` writes `store.progress`, but no component reads it (grep: only `store.ts`/`engine.ts`; the Gallery uses the `Progress` component directly). The loading card uses `phase`, not `progress`.
- `src/engine/worker.ts:56-70` emits “Building edge table” *after* `analyzeParsedStl`, which already built it; stage ordering is misleading.

**Fix:** add `id` (or a job token) to progress and filter by the current job; add `v: 1` and/or `docRev` to the request/response union; either remove `isWorkerResponse` or use it to validate; either render progress in the status card or delete the dead store field. Fix the stage labels.

### P2-10 — Worker memory: no explicit Manifold frees, duplicate topology, unguarded identity cache

**Evidence**

- `src/engine/bevel/kernel.ts:113-126` caches `CachedMesh` (topology + base `Manifold` + volume) in a `WeakMap` keyed by `MeshData`. `src/engine/types.ts:8-11` declares `MeshData` mutable; nothing prevents in-place edits, which would leave a stale topology/base silently.
- `src/engine/bevel/kernel.ts:362-425` creates `parts`, `out`, `cleaned`, `source`, `welded`, `rebuilt`; `src/engine/bevel/kernel.ts:792-793` creates `union` and `raw`. There is **no `.delete()` call** in `bevel/kernel.ts` or `cutSolid.ts` (grep count 0). `node_modules/manifold-3d/manifold.d.ts:1248` documents `delete()` for `Manifold`; the JS build has a `FinalizationRegistry`, but freeing is non-deterministic.
- `src/engine/bevel/topology.ts:44` rebuilds a topology in the worker even though `worker.ts:16` already holds the analyzer's `EdgeTable`. That is a second large set of edge/vertex arrays (roughly 100 MB at 1.6 M edges), including normals and face normals the analyzer already computed.
- The worker does **not** retain old meshes: `source`/`edgeTable` are replaced on import and the `WeakMap` value dies with the key. That part is sound; the peak memory and duplicate topology are the risk.
- `npm run bench` only reports JS heap (30 MB), not the WASM heap, so growth across repeated previews is unmeasured.

**Fix:** freeze/readonly `MeshData` or add a `revision` to the cache key; pass the analyzer topology or a compact edge-id array to the kernel instead of rebuilding it; explicitly `.delete()` temporary `Manifold` objects (`parts`, `union`, `raw`, `cleaned`, `rebuilt`) when they are no longer needed, keeping only the cached base. Add a repeated-preview memory test and report `wasmMemory.buffer.byteLength` in `bench`.

### P2-11 — The frozen edge-id walk is duplicated and differs on degenerate triangles

**Evidence**

- `src/engine/topo/topology.ts:50-68` walks triangles and **skips** `a === b` (`halfEdgeEdge[he] = 0xffffffff; continue`).
- `src/engine/bevel/topology.ts` uses `orderEdges`; `src/engine/topo/edgeOrder.ts:45-58` `add()` does not skip `u === v`, so a self-edge would be inserted.
- Production is safe today because `repairMesh` drops degenerate triangles before either topology is built, and `bevelMesh` documents that it expects a repaired mesh. But `bevelMesh` is exported and used by tests/tools; a direct caller with a degenerate triangle would get different edge ids between the analyzer and the kernel, silently selecting the wrong edges.

**Fix:** make `orderEdges.add()` skip `u === v` (or make `topo/topology.ts` include self-edges) and add a unit test that compares both enumerations on a mesh with one degenerate triangle. Better: have one canonical enumerator and make the kernel consume its output.

### P2-12 — `phase` is a boolean; overlapping jobs clobber each other

**Evidence**

- `src/state/store.ts:137` `setBeveling: (on) => set({ phase: on ? 'beveling' : 'ready' })` unconditionally writes `ready`.
- `src/state/useLivePreview.ts:33-35`: when the selection is cleared it calls `setPreview(null)` and returns; it never clears `beveling`. The previous effect's `.finally` is skipped because `cancelled` is true (`useLivePreview.ts:56-57`), so a preview that was running when the user cleared the selection can leave `phase === 'beveling'` forever.
- `src/state/export.ts:13,24` also sets `beveling` true/false unconditionally. If an import starts during an export, `beginImport` sets `importing`, then the export's `finally` sets `ready` and hides the loading state.
- `src/viewport/Viewport.tsx:55` uses `phase === 'importing'` for the loading card, so the clobber is user-visible.

**Fix:** use job tokens/counters (`beginJob()`/`endJob(token)`) or transition only from the expected phase (`if (phase === 'beveling') phase = 'ready'`). Clear `beveling` when the selection becomes empty. Add tests for import-during-export and clear-selection-during-preview.

### P2-13 — Dead controls and parameters

**Evidence**

- `src/panels/Inspector.tsx:83-87` “Smooth shading” writes `params.smoothing`; the kernel never reads `smoothing`, and `src/viewport/meshView.ts:82-84` chooses `flatShading` solely from triangle count. The toggle does nothing.
- `src/engine/protocol.ts:13` sends `draft`; `src/engine/worker.ts` never reads `request.draft`. No coarse preview exists.
- `src/engine/types.ts:113-117` declares `limitAngle`, `miterJoin`, `creaseAngle`; no engine module reads them (grep).
- `tsconfig.json:16-17` disables `noUnusedLocals`/`noUnusedParameters`, so these dead fields are not flagged.

**Fix:** wire `smoothing` into `MeshView` (override `flatShading` when `params.smoothing === 'flat'`), implement or remove `draft`/coarse preview, and either implement or delete `limitAngle`/`miterJoin`/`creaseAngle`. Enable unused checks for `src/engine` at least.

### P2-14 — Production bundle hygiene

**Evidence**

- `vite.config.ts:8` sets `sourcemap: true`; `dist/assets/index-3CN9K2DT.js.map` is 4.26 MB, `worker-*.js.map` 362 kB, `Gallery-*.js.map` 43 kB. `dist` totals 6.0 MB; the installer is 3.2 MB, so the maps are inside the shipped app.
- `npm run build` warns: `dist/assets/index-3CN9K2DT.js 866.41 kB` (>500 kB), gzip 232 kB.
- `src/app/App.tsx:10-27` lazy-loads `Gallery`, but it is still a production chunk reachable through `/?gallery=1`.
- `PLAN.md:596` budgets <1.8 MB gzip JS + 300 KB wasm; actual gzip JS is ~232 kB and wasm ~209 kB, so the budget is met — the warning and maps are debt, not a budget failure.

**Fix:** set `sourcemap: false` for the Tauri build (or `'hidden'` and exclude maps from `frontendDist`); split three/react into a vendor chunk or set a deliberate `chunkSizeWarningLimit`; guard the Gallery import with `import.meta.env.DEV` if it is not meant for users.

### P2-15 — No root `.gitignore`; generated artifacts are unignored

**Evidence**

- `Test-Path .gitignore` is **false**; only `src-tauri/.gitignore` exists (it ignores `target/` and `gen/schemas`).
- `dist` is 6.0 MB, `renders` 14.1 MB, `node_modules` 222 MB; `experiments/spike/out` contains STLs; `mock-workspace.html` (11 kB) is unreferenced (grep finds no use).
- There is no `.git` directory, so nothing is committed yet — but `git add .` would add all of the above, including the 4.3 MB sourcemap.
- `README.md:7` uses `renders/final-loaded.png`; a blanket `renders/` ignore would break the README image.

**Fix:** add a root `.gitignore` for `node_modules/`, `dist/`, `experiments/spike/out/`, `src-tauri/target/`, logs, and `renders/*` with an explicit whitelist for `renders/final-loaded.png` (or move doc images to `docs/`). Decide whether `dist/` and the installer are release artifacts; if so, publish them outside the source tree.

### P2-16 — Tauri dev port and static base

**Evidence**

- `vite.config.ts:7` has `strictPort: false`; `src-tauri/tauri.conf.json:8` has `devUrl: "http://localhost:5183"`. If 5183 is busy, Vite silently picks another port and `tauri dev` loads the wrong URL or times out.
- `dist/index.html` references `/assets/index-*.js` and `/assets/index-*.css` with a leading slash. Tauri's `http://tauri.localhost` root works, but `README.md:16` calls `dist/` “static”; opening it via `file://` or hosting under a subpath fails.
- `vite.config.ts:8` targets ES2022; fine for current WebView2 but worth pinning in docs.

**Fix:** set `strictPort: true` (and update the README if the port changes). If static hosting is a supported path, set `base: './'` and verify the worker/WASM URLs; otherwise state explicitly that `dist/` must be served from the origin root.

### P2-17 — Default packaging identity

**Evidence**

- `src-tauri/icons/icon.png` is the stock Tauri logo (visually inspected); the `Square*Logo`/`StoreLogo` set is the default template.
- `src-tauri/Cargo.toml:4-6`: `description = "A Tauri App"`, `authors = ["you"]`, `license = ""`.
- `src-tauri/tauri.conf.json:32-38` uses the default icon list; the bundle has no `publisher`, `copyright`, `shortDescription` or `longDescription`.
- No root `LICENSE` file and no `license` field in `package.json`, despite PLAN §1.3 describing an “MIT/OSS-spirited build”.

**Fix:** generate proper icons with `npm run tauri icon <brand.png>`; set Cargo description/authors/license; add `bundle.publisher`/`copyright`/description; add a LICENSE and a `license` field if the project is to be shared.

### P2-18 — Dependency hygiene

**Evidence**

- `package.json:19` `@tauri-apps/api` and `:24` `three-mesh-bvh` are installed, but no `src` file imports either (grep for `@tauri-apps/api`/`three-mesh-bvh` returns no matches). `npm ls --depth=0` confirms both.
- PLAN §3/§8 expects `three-mesh-bvh` for picking, but `src/viewport/picking.ts` uses a custom uniform grid; the dependency is dead.
- No `engines` field in `package.json`, despite README/toolchain requiring Node 26.13.1.
- `ORCHESTRATION.md:109` says “Pinned: manifold-3d 3.5.5, three 0.187, React 19, TypeScript 7.0.2”, but `package.json` uses carets (`^3.5.5`, `^0.187.0`, `^19.3.1`, `^7.0.2`). The lockfile pins installs, but the claim is about ranges.
- Positives: `package-lock.json` is present; `npm audit` (full and `--omit=dev`) reports 0 vulnerabilities; `npm ls` is otherwise clean.

**Fix:** remove the unused dependencies (or actually use BVH for picking as PLAN says); add `"engines": { "node": ">=26" }`; either pin exact versions for the kernel/renderer or change the doc to “lockfile-pinned”; keep `npm ci` in the verification path.

### P2-19 — Tooling is hardcoded and leaves artifacts

**Evidence**

- `tools/shot.mjs:8-9` hardcodes `C:\Program Files\Google\Chrome\Application\chrome.exe`; `tools/e2e-1m.mjs:8-13` hardcodes `http://localhost:4173/` and writes `renders/e2e-1m.png`. No npm script runs any e2e/shot tool.
- `tools/e2e-controls.mjs`, `e2e-stroke.mjs`, `e2e-zoom.mjs`, `e2e-zoom-clean.mjs` are one-off visual checks with the same assumptions; `e2e-drop.mjs` is a useful keeper for the HTML5 drop path.
- `tools/bench-1m.ts:75-99` writes `%TEMP%\bevel-bench\cube-1m.stl` (51.5 MB, confirmed by `npm run bench`) and never deletes it. The header says “never into the repository”, which is true, but it is not cleaned.
- `tools/acceptance.ts:86-97` writes `renders/hook-tool-all.stl` and `hook-tool-outside.stl` on every run.
- `acceptance` is cwd-independent (`tools/acceptance.ts:18` resolves the root from `import.meta.url`); `e2e-*.mjs` and `shot.mjs` are cwd-dependent because their outputs are relative.

**Fix:** read `CHROME_PATH`/`PREVIEW_URL` from env with the current values as defaults; add npm scripts (`e2e`, `shot`) and document the `npm run preview` prerequisite; `rmSync` the bench STL in a `finally` (or add `--keep`); write acceptance STLs to temp or ignore `renders/`. Decide which e2e scripts are keepers and put them under `tools/visual/` with a README; delete the rest.

### P2-20 — Fixtures are duplicated byte-for-byte

**Evidence**

- SHA256: `public/fixtures/hook-base.stl` = `example_stl_beveling/Desk_Hook_Quatsch_unoptimized.stl` (`A9E90A…`); `hook-reference.stl` = `Desk_Hook_Quatsch_improved.stl` (`DAEB79…`).
- `tools/acceptance.ts:52-56` reads the public copies; `ORCHESTRATION.md:125` points at `example_stl_beveling/` as the reference models; `dist/fixtures` is a third copy created by the build.
- If the user's reference file changes, the app sample/acceptance silently keeps the stale copy.

**Fix:** keep one canonical fixture directory; copy/generate the public sample from it at build/test setup, or have acceptance read the canonical path via env with a fallback. Add a hash test so the copies cannot drift.

### P2-21 — Docs drift

**Evidence**

| Claim | Reality |
|---|---|
| `ORCHESTRATION.md:8` “28 tests” | `npm test` runs **42 tests / 6 files** |
| `ORCHESTRATION.md:10` “latest-wins preview” | P1-1: previews queue; cancel does not preempt |
| `ORCHESTRATION.md:16` “M6 done” | No window state, recents or crash-safe autosave (PLAN §9 M6, `PLAN.md:637`); no `tauri-plugin-window-state` |
| `ORCHESTRATION.md:109` “Pinned” | Caret ranges in `package.json` |
| `ORCHESTRATION.md:18` / `README.md:55` 12 784.04 / 1 668 tri | Acceptance prints 12 783.72 / 2 672 tri |
| `README.md:58` “roughly 2.5× more triangles” | 2 672 / 654 ≈ **4.1×** |
| `README.md:86` “first rendered frame 7 ms” | No script/report in the repo measures this; unverified |
| `README.md:93-96` “Not done yet” | Omits missing M6 items, native dialogs/recents, persistence, coarse preview, export-in-Tauri coverage |
| `PLAN.md:104-116` native dialogs, drag-drop paths, recents, menu | App uses HTML5 `<input>`/drop and blob download; no Tauri dialog/fs/window-state plugins |
| `PLAN.md:261` `batchBoolean` | `experiments/spike/report.json` says manifold-3d 3.5.5 has no `batchBoolean`; code uses `Manifold.union` |
| `PLAN.md:577` localStorage/IndexedDB recents/last document | No `localStorage`/`indexedDB` in `src` (grep) |
| `PLAN.md:588-593` BVH, meshoptimizer, Tailwind, motion, Tauri plugins, Playwright | Not installed/used; ORCHESTRATION only acknowledges plain three/no Tailwind |
| `PLAN.md:664-665` acceptance gate | Fails on the “outside only” result (P1-6) |
| `src/viewport/README.md:94-120` UI-thread parse, BVH picking | Actual: worker import (`src/viewport/import.ts:62`), custom grid picker (`picking.ts`) |

**Fix:** update the status tables to measured values and mark PLAN items as “implemented / deferred / not planned” with links. Add a small docs check (or a CI grep) for numbers that are supposed to be generated. Date the status section so readers know which build it describes.

### P2-22 — Untrusted STL limits

**Evidence**

- Positives: `src/engine/io/stl.ts:15-24` rejects ZIP/3MF by signature; `dropDegenerate` drops non-finite vertices/triangles (`stl.ts` R2); binary length is checked before reading (`stl.ts:69-73`).
- Risks: `stl.ts:76` allocates `count * 9` floats after the length check but with **no triangle/file-size cap**; `stl.ts:94-115` builds an ASCII vertex array with no cap (a 1 GB ASCII file can exhaust memory); `stl.ts:149` computes `Math.round(x * 1e4)`, and `cellHash` at `stl.ts:195-200` uses `cx | 0`. Finite coordinates around `1e30` become `Infinity | 0 === 0`, so all vertices land in one bucket and the 27-cell weld probe becomes O(n²).
- `src/engine/topo/edgeOrder.ts:35-38` rejects >2^21 vertices, but only after parse/weld has already allocated the big arrays.

**Fix:** cap input size/triangle count (e.g. 2 GB / 50 M triangles) with a clear error before allocation; reject or clamp `|coordinate| > 1e9`; make the weld hash robust for large finite values (mix the float bits or use a string key with a length cap); add fuzz tests for huge coordinates and a large ASCII file.

### P2-23 — Selection state is O(edge count) per hit/render

**Evidence**

- `src/state/store.ts:111-117` `toggleEdge` copies the entire `Uint8Array` on every call.
- `src/viewport/useEdgeSelection.ts:174` calls `toggleEdge` for **each hit** in a paint stroke; `useEdgeSelection.ts:121-122` keeps up to 40 full-mask history snapshots. At 1.62 M edges, one mask is 1.6 MB; 40 snapshots are ~64 MB, and a stroke can allocate a new mask per hit.
- `src/panels/Inspector.tsx:21` calls `countSelected` (full scan) on every render; `StatusBar.tsx:13-16` counts all candidates on every render; `useLivePreview.ts:29-30` builds the selected-id list by scanning the full mask on every effect.
- This is main-thread work, not the worker, but it undermines the 1 M “never do O(n) per interaction” goal.

**Fix:** add a batch `toggleEdges(ids, value)` that copies once per pointer event (or use a bitset/`Set` and a revision counter); cache `selectedCount`/`candidateCount` in the store; avoid rebuilding the id list when the mask revision has not changed. Add a 1 M paint-stroke latency/allocation test.

---

## What I verified

Run with the portable Node 26.13.1 on PATH (`npm.cmd`), from `C:\Users\basti\AI_printing\bevel-studio`:

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | **42 tests / 6 files pass** (574 ms) |
| `npm run build` | exit 0; `index-*.js` 866.41 kB (gzip 232.46 kB), `manifold-*.wasm` 542.74 kB, map 4,263.98 kB; >500 kB warning |
| `npm run acceptance` | exit 0; 2 672 tri / 12 783.72 mm³ all convex, 542 tri / 12 799.06 mm³ outside; **no assertions** |
| `npm run bench` | exit 0; 1 080 000 tri, 51.5 MB temp STL; parse 1 023 ms, analyze 3 266 ms, bevel 3 613 ms; JS heap 30 MB |
| `npm audit` / `npm audit --omit=dev` | 0 vulnerabilities |
| `npm ls --depth=0` | clean; shows unused `@tauri-apps/api`, `three-mesh-bvh` |
| `rustc --version` / `cargo --version` | 1.100.0 (matches ORCHESTRATION) |
| `tauri --version` | tauri-cli 2.12.4 |
| Artifacts | `src-tauri/target/release/app.exe` 10.2 MB; NSIS installer 3.2 MB; README path correct |
| Fixtures | SHA256 identical to `example_stl_beveling`; `dist/fixtures` is a third copy |
| Repo | no `.git`; no root `.gitignore`; `dist` 6.0 MB, `renders` 14.1 MB, `node_modules` 222 MB |

Also checked by reading: worker copies positions/indices before transferring (no detach bug); client copies selections before transferring; ZIP/NaN handling; no telemetry/external fetch (only `/fixtures/hook-base.stl`); HTML5 drop path (`Viewport.tsx:196-203`); `dragDropEnabled: false` is intentional for HTML5 drop; `beforeBuildCommand` is correct; `bundle.identifier` is valid; `dist/assets/worker-*.js` and `manifold-*.wasm` exist and are referenced by the built worker.

## Unverified

- **Packaged Tauri runtime** — I did not launch `app.exe`: worker startup, WASM loading under `http://tauri.localhost`, `dragDropEnabled:false` behavior, HTML5 drop, and the blob `<a download>` export path are unverified.
- **`npm run tauri build`** — not rerun (existing artifacts inspected only); Rust compilation not rerun.
- **Browser 1 M path** — `tools/e2e-1m.mjs` not run (needs `npm run preview` + Chrome at a hardcoded path); only the Node bench ran.
- **Manifold WASM heap growth** — not measured across repeated previews/imports; the `FinalizationRegistry` analysis is source-level only.
- **CSP fix** — read-only review; the proposed policy was not applied or tested.

## The 3 fixes I would do first

1. **Fix worker scheduling and add a document epoch** (P1-1, P1-2): coalesce previews on the client so only one runs at a time, cancel the live preview on import, and add a `docEpoch` guard so a preview/export can never combine a new `source` with old edge ids. This is the core of the product’s “live” promise.
2. **Make failures visible and recoverable** (P1-3, P1-5): reset `kernelReady` after a rejected init, recreate the worker after a crash, add a request timeout, carry `warnings` into `PreviewState`, and block/confirm export when the result is not watertight. Right now the app can silently do nothing or export a broken mesh.
3. **Turn acceptance into a real gate** (P1-6): assert status, shell count, triangle window, volume and bbox; exit non-zero on failure; run the app’s actual selection/params; update the README/PLAN numbers. Without this, the 1 668-triangle claim and the 640–670 gate are unsubstantiated.

Next after those: set the Tauri CSP (P1-8) and transfer the edge table instead of cloning it (P1-4).
