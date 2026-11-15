# Geometry engine review — Bevel Studio

**Date:** 13 Nov 2026 · **Scope:** `src/engine/**`, engine tests, `experiments/spike/**` · **Mode:** read-only (only this file was created)

## Verdict

**2 P0, 7 P1, 7 P2.** The cut-solid architecture is sound and the headline numbers reproduce: `npm test` is 42/42 green, `npm run acceptance` gives 2 672 tri / 12 783.72 mm³ / 47.88 × 61.92 × 35.00 on the all-convex selection, one shell, genus 0, and an independent edge-use count finds 0 boundary / 0 non-manifold edges. The chain extension also works (a split 40 mm box edge removes the same 35.0385 mm³ as the unsplit edge).

But the engine does **not** keep its central promise under the settings the app actually ships. `DEFAULT_BEVEL.clampOverlap` is `true` (`types.ts:120-124`, `state/store.ts:70`), and on `hook-base.stl` the clamped outside-rim bevel has **113 self-intersecting triangle pairs**; all-convex clamped has **214** (unclamped: 121). Manifold's `status()` is `NoError`; the geometry tests run with `clampOverlap:false` (the one clamped test checks widths only), and neither the acceptance script nor the kernel tests check self-intersection. The same kernel also leaks ~4.4 MB of WASM memory per bevel (the architecture review's P2-10, measured here), and the 1 M / tessellated-rim paths either do nothing (per-edge 4r skip) or collapse the mesh (global `simplify(1e-3)`: 1.08 M → 4 200 triangles). Those three are release blockers; the rest is real debt around repair, validation and test coverage.

“P0” = wrong output / crash / data loss; “P1” = real risk or significant debt; “P2” = polish. Where a finding is already in `reviews/architecture.md` the cross-reference is stated and only the engine evidence/severity is added.

## Findings

| ID | Sev | Area | Finding |
|---|---|---|---|
| E1 | P0 | Bevel correctness | Default clamp produces self-intersecting output on the reference hook (113–214 pairs) while reporting `NoError`; no test/acceptance checks it |
| E2 | P0 | Memory | Every bevel leaks Manifold/Mesh WASM objects; RSS +4.4 MB per hook bevel, linear, OOM during a slider drag (arch P2-10 measured) |
| E3 | P1 | Cleanup | Global `simplify(1e-3)` decimates flat regions (1.08 M → 4 200; 1 200 → 32 triangles) and is unit-dependent; it also moves the bbox by +1e-3 |
| E4 | P1 | Selection | Per-edge “shorter than 4× width” check rejects tessellated rims/chains; a 64-gon rim at width 1 gets zero bevel, and the 1 M cube at default width 0.5 does too |
| E5 | P1 | Retry | The boolean-failure retry uses the arc *inset* the spike proved unusable; the actual tangency mitigation (`extend`) is always passed as 0 |
| E6 | P1 | Repair holes | R6 caps any ≤64-edge loop without the planarity/convexity check; non-planar/non-convex caps can self-intersect (L-hole → 2 caps, zero-volume shell) |
| E7 | P1 | Repair shells | R7 silently drops small shells below 0.1 % of total volume with no keep-anyway option; a 20 mm part beside a 300 mm part is lost |
| E8 | P1 | maxWidth | The clamp uses a midpoint-distance proxy (0.5×), not PLAN §4.3's endpoint distance (0.45×); the two analyzer/kernel definitions also disagree |
| E9 | P1 | Acceptance | `npm run acceptance` never asserts and never exercises the app's default clamp; published numbers are stale (arch P1-6) |
| E10 | P2 | Metadata | Bevel-result `meta.edges` is 0; boundary/non-manifold counts are hard-coded 0 even on failed results; `shells` is a pre-union count |
| E11 | P2 | Duplicate topology | Five edge-table implementations; `orderEdges` vs `topo/topology` disagree on self-edges and a degenerate-first mesh shifts every id by one (arch P2-11) |
| E12 | P2 | Units/precision | Fixed absolute tolerances (1e-4, 1e-3, 10, 1e-8) and absolute-coordinate construction; at x≈1e6 the same edge removes 17.656 mm³ instead of 18.771 |
| E13 | P2 | Performance | Full-vertex corner scan + 6.4 MB of per-call arrays on every preview; no 128-chunk union; export re-runs the bevel; 1 M bevel 5.5 s vs README 3.97 s |
| E14 | P2 | Warnings | Flat edges are reported as “not two-sided”; `useLivePreview` discards every warning except `clampedEdges` (arch P1-5) |
| E15 | P2 | Dead code | `bevel/index.ts` unused; spike code is dead/stale with a hard-coded user path; `limitAngle`/`miterJoin`/`creaseAngle` unread; smoothing toggle ignored |
| E16 | P2 | Parse/API | A binary STL whose header starts `solid` plus one trailing byte is misread as ASCII; `bevelMesh` throws on an open base instead of returning a structured refusal |

---

## P0 findings

### E1 — The default clamp path ships self-intersecting geometry

**Evidence**

- `src/engine/types.ts:120-124` sets `clampOverlap: true`; `src/state/store.ts:70` initialises `params: DEFAULT_BEVEL`; the Inspector toggle (`Inspector.tsx:78-79`) starts on. The app therefore runs the clamped path by default.
- `src/engine/bevel/kernel.ts:504-508` clamps **each edge independently** to `min(width, 0.98 × maxWidth[e])`. Adjacent edges of a chain get different radii; the corner cut uses only the minimum incident radius (`kernel.ts:642-671`); the terminations taper over `min(r, 0.25L)` (`kernel.ts:693-698`). Nothing reconciles the mismatched cut solids at a shared vertex.
- Empirical, using the repo's own SAT check copied verbatim from `experiments/spike/run.ts:420-561` (the same function that reports 0 for the base and 5/11 for the spike's C/C-noclamp STLs, so it is calibrated):

| selection | clamp | tri | volume | self-intersecting pairs |
|---|---|---|---|---|
| outside rim (midX ≥ −16.9) | off | 542 | 12 799.06 | **0** |
| outside rim | on | 398 | 12 856.33 | **113** |
| all convex ≥20° | off | 2 672 | 12 783.72 | **121** |
| all convex ≥20° | on | 2 204 | 12 845.00 | **214** |

- `npm run acceptance` uses `clampOverlap:false` (`tools/acceptance.ts:68`), so the shipped default is never tested. `kernel.test.ts:174-175` also pins `clampOverlap:false`; the only clamped test (`kernel.test.ts:252-264`) asserts widths, not geometry. `kernel.ts:937-950` checks only volume direction, and `status()`/`manifold` only prove topological manifoldness — a self-intersecting mesh can be topologically manifold.
- `experiments/spike/report.json` already marks the all-convex variants `pass=false` with `selfIntersections` 5/11/10; the README/ORCHESTRATION present the all-convex result as the success case anyway. The production result is worse (121/214) because of the newer `continues` extension (`kernel.ts:689-722`) and/or the clamp/taper interaction.
- The intersecting pairs are not a coplanar artefact: the sampled pairs are non-coplanar and cluster at the under-table plate (x≈−27…−31, z≈0.3–0.5) and at terminations. `taper:'none'` reduces the outside-clamped count 113 → 5, so the taper/extension is the main source; `corners:false` leaves it at 113; disabling `simplify` leaves it at 120.

**Fix:** (a) Port `countSelfIntersections` into a production validator and call it on `chosen.mesh` (≤3 k triangles cheap; use a spatial grid/BVH over the result triangles for large results). If nonzero, return the base / exclude the offending edges and warn, exactly as PLAN §4.4.7 intends. (b) Clamp per **chain** (a connected selected set), not per edge, so adjacent cuts share a radius; or clamp all incident edges at a vertex to the vertex minimum. (c) Use `extend` (currently dead) at terminations to make the cut sides cross the base surface instead of running tangent to it. (d) Add the spike's SI check to `acceptance.ts` and to the hook test with the **default** params.

**Smallest test:** `bevelMesh(hookBase, outsideRim, { ...DEFAULT_BEVEL, width: 0.5 }, maxWidth)` then assert `countSelfIntersections(result.mesh) === 0`. It fails today with 113.

### E2 — Every bevel leaks WASM memory; a slider drag will OOM the worker

**Evidence**

- `manifold-3d`'s `Manifold.delete()` doc says: “Frees the WASM memory of this Manifold, since these cannot be garbage-collected automatically” (`node_modules/manifold-3d/manifold.d.ts:1243-1248`).
- `src/engine/bevel/kernel.ts` creates Manifolds/Meshes and never calls `delete()`:
  - `meshToManifold` (`kernel.ts:177-185`) creates a `Mesh` and a `Manifold`;
  - `manifoldToMesh` (`kernel.ts:188-199`) calls `getMesh()` and never deletes the returned Mesh;
  - `cleanup` (`kernel.ts:362-425`) creates `decompose()` parts, `keep`, a union, `simplify`, a welded Mesh and a rebuilt Manifold;
  - `attempt` (`kernel.ts:739-782`) creates one Mesh+Manifold per cut solid, plus `probeSolids`, `union`, `raw`, `cleaned`;
  - `baseShells` (`kernel.ts:128-137`) decomposes and drops the parts.
- Measured on `hook-base.stl`, 77 edges, width 0.5 (30 iterations, `--expose-gc` and a forced `global.gc()` every 5): RSS 79 → 225 MB, linear ≈ 4.4 MB per call; JS heap stayed at 11–23 MB, so the growth is WASM/external. The 1 M path leaks much more because the cleanup mesh is 1 M triangles. The architecture review already noted the missing `delete()` as P2-10; the measurement makes it P0 for the live-preview loop.
- Every import also replaces `source` (`worker.ts:61`) and leaves the cached base Manifold in the WeakMap without a dispose hook.

**Fix:** wrap every non-returned Manifold/Mesh in `try/finally { obj.delete(); }` (`meshToManifold`'s Mesh immediately after the constructor; each `raw` cut solid after `meshToManifold`; `union` after `subtract`; `parts`/`keep` after the union; `raw` after `cleanup`; the chosen result Manifold after `genusOf`/volume, unless it is the cached `base`; the `getMesh()` result in `manifoldToMesh`). Add an explicit `disposeCached(mesh)` for the worker's import path, or a `FinalizationRegistry` keyed by `MeshData`. Add a 50-iteration memory test: assert RSS growth < 50 MB (it currently fails at ~220 MB).

---

## P1 findings

### E3 — `simplify(1e-3)` is a global decimator, not a sliver merge, and it is unit-dependent

**Evidence**

- `kernel.ts:375-383` runs `cleaned = out.simplify(1e-3)` on the **whole result**, with the comment “Collapsing within 1 µm is far below print resolution … Simplification is an optimisation only.”
- Measured: a 10×10-per-face cube (1 200 triangles), bevel one 2 mm edge at r=0.5 → **32 triangles**; a 2×2-per-face cube (48) → 32; the 1 M bench (1 080 000 triangles, 400 edges) → **4 200 triangles**. Manifold's `simplify(tolerance)` moves surfaces by up to `tolerance` and collapses coplanar regions because their deviation is zero — it is not limited to the bevel's tangency slivers.
- The reference hook's bbox z becomes **35.000999** from a 35.000 base: the simplify pass moved a face outward by its full 1e-3 tolerance. Volume is unchanged to 1e-12 in that case, but the “bevels only remove material” guarantee is violated at the bbox/Hausdorff level. On a curved/fine surface the same movement can change volume; `kernel.ts:937-950` only checks the sign of the removed volume, never the analytic expected cut volume, so a wrong-magnitude result passes.
- Unit dependence: 1e-3 is model units. For a model in metres a 0.5 mm bevel is 5e-4 units; the simplify tolerance is 2× the bevel and erases it (or the arc). For a 0.01 mm bevel in mm the arc chord (~7.6e-4) is below 1e-3, so the arc is flattened. The README says “units preserved”; the engine has no unit flag, so this is reachable.
- The 1 M bench prints 4 200 triangles but the README says the tool “keeps roughly 2.5× more triangles” (≈1 635 for the hook); the bench has no triangle-count assertion. The kernel test's `expect(result.meta.triangles).toBeLessThan(3000)` (`kernel.test.ts:228`) is a ceiling that a decimated result passes trivially.

**Fix:** remove the global `simplify` (the weld at `kernel.ts:386` already merges the 1e-4 slivers; without simplify the hook was 2 686 triangles, not 2 672), or scope it to the bevel strips only and derive it from `min(r × 0.002, bboxDiag × 1e-6)`; never let the result triangle count fall below, say, 50 % of the base, and add that guard + a warning. Add a subdivided-cube test asserting the result keeps most of the base triangles.

### E4 — The per-edge 4× width check defeats tessellated rims and the 1 M default

**Evidence**

- `kernel.ts:516-519`: every selected edge with `length < 4 × radius` is skipped, before the `continues()` chain logic (`kernel.ts:604-626`) can treat it as part of a long chain.
- A 64-sided prism (radius 10 mm, height 20), top rim selected, width 1 mm: each rim segment is 0.98 mm, 4r = 4 mm, so **all 64 edges are skipped**, `appliedWidth` is all zero, removed volume is 0, and the warnings are `bevel.short`. A 32-gon (1.96 mm) fails too; a 128-gon (0.49 mm) fails at a smaller width. This is an ordinary STL cylinder, not a pathological input.
- The 1 M bench is a 300 mm cube with 1 mm facets. Its rim edges are 1 mm; the app default width 0.5 mm gives 4r = 2 mm, so **every rim edge is skipped** and the bevel does nothing. The bench only works because `tools/bench-1m.ts:24` sets `bevelWidth = 0.15`; the comment there admits “The kernel skips edges shorter than 4× the radius”.
- `useLivePreview.ts:45-50` stores only `mesh`/`meta`/`clampedEdges`/`stale`; the `bevel.short` warning is discarded, so the user sees no bevel and no explanation. The Inspector's “Width limited” chip only covers `clampedEdges` (`Inspector.tsx:94-98`), not skipped edges.

**Fix:** make the check chain-aware. Build the selected-edge adjacency first, include short edges in `incident`, compute `continues` for them, and only skip a short edge when it is isolated (no continuing selected neighbour). For a chain, use the sum of its edge lengths for the 4r test (or drop the test when `continues` is true and let `stationList`/the extension handle the joint). Add a 64-gon rim test asserting `removed > 0` and no `bevel.short` for the rim.

### E5 — The retry uses the mitigation the spike proved unusable; the good knob is dead

**Evidence**

- `kernel.ts:46` `RETRY_INSET = 1e-4`; `kernel.ts:882-893` retries `attempt(RETRY_INSET)` when the first result is not watertight.
- `cutSolid.ts:113` `R = Math.max(rho - inset, rho * 0.3)` shrinks the arc radius while the centre stays put, so the arc no longer reaches the face planes — a knife-edged slit. `experiments/spike/report.json:22` records: “PLAN §9 ε-inset mitigation fails: shrinking the fillet arc turns the cut into a knife-edged slit that never reaches the surface (bbox unchanged, 2234 self-intersections). Not usable.” The C+eps report row has 2 234 self-intersections and fails `oneShell`, `noDuplicatePositions`, `reimportsManifold`.
- `cutSolid.ts:117-118` implements the actual mitigation — `extend` pushes the section corner ε outside both face planes while the arc stays exact, so the cut’s side faces cross the base surface transversally. But `kernel.ts:748` always passes `extend: 0`; the field is never nonzero in production. The spike’s `DEFAULT_CUT` also had `extend: 1e-3` but `collectCuts` passed 0.
- The retry warning (`kernel.ts:888-892`) tells the user it “retried once with a 1e-4 mm arc inset” as if that were a fix.

**Fix:** make the retry use `extend: RETRY_INSET` (and keep `inset: 0`), or delete the retry. Enable a small `extend` on the first attempt for edges below, say, 5° (where tangency slivers are most likely) and measure the hook. Add a test that forces a failure (a deliberately shallow edge) and asserts the second result is watertight without the `C+eps`-style self-intersections.

### E6 — R6 caps any hole without the planarity/convexity check the plan requires

**Evidence**

- `repair.ts:416-543` finds every boundary loop, rejects only loops that do not close or exceed `MAX_HOLE_EDGES=64` (`repair.ts:472-479`), and fans it from the centroid (`repair.ts:497-513`). The only geometric validation is triangle area ≥ `1e-8` (`repair.ts:517-538`).
- PLAN §4.2 R6 says: “if a loop is planar within `1e-4·diag` and convex-ish, cap it with a fan; otherwise mark as unresolvable.” Neither test exists. A non-planar hole on a curved surface gets a flat fan; a non-convex loop can have its centroid outside the loop, so the fan covers solid material and overlaps the existing faces.
- Measured: a 5×5 grid with an L-shaped hole (removed cells (1,1),(2,1),(3,1),(1,2),(1,3)) reports `holesFilled = 2` (the outer boundary and the L hole) and yields a “watertight” 1-shell mesh with **volume 0** and a `volume` warning. The flat sheet case is not necessarily self-intersecting, but the L loop is non-convex and is capped anyway; the code never checks planarity/convexity, and the same path runs on curved patches.

**Fix:** before capping, compute a Newell normal, the max deviation of the loop vertices from the best-fit plane, and a 2-D convexity test (or an ear-clipping check). Cap only if `maxDeviation ≤ 1e-4 × bboxDiag` and the loop is simple/convex; otherwise increment `holesUnresolved` and leave it open. Add the L-hole test asserting `holesUnresolved > 0` (or a single cap), not `holesFilled = 2` + zero volume.

### E7 — R7 drops small shells by volume fraction with no user consent

**Evidence**

- `repair.ts:10` `SMALL_SHELL_FRACTION = 0.001`; `repair.ts:652-665` drops every non-largest component whose absolute volume is below 0.1 % of the total.
- For the 1 M bench's 300 mm cube (27 000 000 mm³) the threshold is 27 000 mm³: a separate 20 mm cube (8 000 mm³) is silently removed. Even a 30 mm cube (27 000 mm³) is at the boundary. A multi-part print with a small separate piece loses it; the only signal is an `info` repair record and a `shellDropped` warning.
- PLAN §4.2 R7 says “keep the largest closed shell; list others in the report with a ‘keep anyway’ toggle.” The toggle does not exist; `analyze.test.ts:231-243` only checks that a 0.5 mm cube is dropped, not that the user can keep it.
- The architecture review did not cover this; it is engine data loss.

**Fix:** keep all closed shells by default (bevels already apply to all shells, per `analyze.ts:95-101`), and drop only genuine debris (e.g. < 8 triangles / < 1e-6 of the bbox volume). If the volume-fraction heuristic stays, make it a reported, user-confirmed action rather than an automatic drop. Add the 20 mm-beside-300 mm test asserting the part survives or is explicitly listed.

### E8 — `maxWidth` is a midpoint proxy, not the plan's endpoint distance; the two definitions disagree

**Evidence**

- PLAN §4.3: `maxWidth[e] = 0.45 × min(altitude of each adjacent triangle from the edge, length of every edge sharing a vertex with e, half the distance from e to the nearest other selected edge at each endpoint)`.
- `topo/build.ts:138-149` documents a different definition: “`min(0.5 * shortest incident edge length, 0.5 * distance from this edge's midpoint to the nearest non-incident edge midpoint)`”. `topo/build.ts:255-345` implements the midpoint-to-midpoint distance with a spatial hash; it never computes the distance from the edge's endpoints to other edges. The brute-force test (`edgeTable.test.ts:30-78`) re-implements the same midpoint formula, so it validates the implementation against itself, not against the plan.
- The kernel's fallback (`bevel/topology.ts:185-235`) is a third definition: `0.45 × min(two altitudes, shortest incident edge)`, with no distance term at all. The kernel tests call it without `maxWidth` (`kernel.test.ts:186, 207, 245`), so the fallback is the only limit there.
- The midpoint proxy is not a safe upper bound for a thin feature: two long edges 0.2 mm apart can have midpoints several millimetres apart when the opposing edge is split or offset. The simple plate is saved by the incident-edge term (the vertical 0.2 mm edges at the plate's corners), but a thin rib/crest whose opposite edge is split has no short incident edge at the crest and can get a width far above the wall thickness. The PLAN §10.3 fixture “0.01 mm thick plate — clamping prevents blow-through” is not in the suite.
- Note the clamp-induced self-intersections in E1 are the observed failure of this guard, not just a theoretical one.

**Fix:** compute the minimum segment-to-segment distance from the edge to nearby non-incident edges (or at least from each endpoint to those edges) using the existing spatial hash; use the true `0.45 × min(...)` formula. Add a thin-rib fixture with an offset/split opposing edge and assert the applied width is ≤ half the wall thickness and the result has no holes/SI.

### E9 — Acceptance is a printout, not a gate; the app's default is untested

**Evidence**

- `tools/acceptance.ts:92-101` runs two selections, writes STLs and `console.log`s the lines; there is no assertion, no `process.exitCode`, and no comparison with PLAN §10.2.
- `npm run acceptance` exits 0 with 2 672 tri / 12 783.72 mm³ (all convex) and 542 tri / 12 799.06 mm³ (outside only). The PLAN gate is 640–670 triangles / 12 660–12 920 mm³ / bbox ±0.02 / one shell / genus 0; the tool's triangle count is 4× the plan's and the README's “1 668 tri / 12 784.04” no longer matches the code (2 672 / 12 783.72).
- The script pins `clampOverlap:false` (`acceptance.ts:68`) and the hard-coded `midX < −16.9` wedge exclusion (`acceptance.ts:78`), so it does not test the shipped default selection or the default clamp — the exact configuration that produces 113 SI on the outside rim (E1).
- The architecture review already flags this as P1-6; the engine-specific addition is that even a passing volume assertion would not catch E1/E3/E4 because none of them change the volume beyond tolerance.

**Fix:** assert status, `shells === 1`, `meta.genus === 0`, volume range, bbox ±0.02, a re-import through `parseStl` with 0 boundary/non-manifold edges, and `countSelfIntersections === 0`; run both `clampOverlap:false` and `true`; exit non-zero on failure. Update the README/PLAN numbers or the gate.

---

## P2 findings

### E10 — Bevel-result metadata is wrong on failure and `edges` is always 0

**Evidence:** `kernel.ts:952-962` starts from `computeBasicMeta(chosen.mesh)` (which sets `edges: 0` at `meta.ts:30`, `genus: 0`, `shells: 1`, `watertight: false`) and overwrites volume/triangles/vertices/shells/watertight/genus, but never `edges`, `area`, `flippedTriangles` or `degenerateTriangles`. It then **hard-codes** `meta.boundaryEdges = 0` and `meta.nonManifoldEdges = 0` even when `chosen.ok` is false and the returned mesh is the pre-weld `source` (the `cleanup` not-ok path, `kernel.ts:415-424`). `chosen.shells` is `keep.length` (`kernel.ts:388`) before the `Manifold.union(keep)`, so two touching kept parts can be reported as 2 shells when the result is 1. The UI happens to show only triangles/volume/watertight (`Inspector.tsx:102-117`), so this is latent, but any consumer of `BevelResult.meta` gets false counts.

**Fix:** build the result meta from the actual result: set `meta.edges` from a `buildEdgeTable(chosen.mesh)` (or at least the topology's edge count), set boundary/non-manifold from an edge-use count or `-1` when unknown, and set `shells` from `chosen.manifold.decompose().length` (with deletes) rather than `keep.length`. Add a test that a deliberately failed result does not report 0/0.

### E11 — Five edge-table implementations; the frozen walk diverges on self-edges

**Evidence:** `topo/edgeOrder.ts:34-61` (`orderEdges`), `topo/topology.ts:50-69` (`buildTopology`), `bevel/topology.ts:44-183` (a second full builder), `experiments/spike/edges.ts:74-196` (a third), and `kernel.test.ts:27-130` (a fourth test helper). On clean meshes they agree — I verified ids match `orderEdges` on the cube and hook, and the convexity/opposite-vertex test is identical (`topo/build.ts:110-123` vs `bevel/topology.ts:147-153`) — but `orderEdges.add()` does not skip `a === b` (`edgeOrder.ts:52-59`), while `topo/topology.ts:56-59` does. With a degenerate triangle **first**, `orderEdges` has 19 edges vs `topo/topology` 18; `orderEdges[0] = [0,0]`, `topo[0] = [0,2]`; every subsequent id shifts by one. A caller that gets ids from `buildEdgeTable` and passes them to `bevelMesh` on the same unrepaired mesh bevels the wrong edges. Production is safe because `repairMesh` drops degenerate triangles first, but the kernel's public API and the test helper are not. The architecture review already has this as P2-11.

**Fix:** one canonical enumerator used by both sides (or make `orderEdges` skip `a === b`), plus a test that compares `orderEdges`, `buildEdgeTable` and `bevel/topology` ids on a mesh with one degenerate triangle at index 0.

### E12 — Fixed absolute tolerances and absolute-coordinate construction are not unit/scale safe

**Evidence:** `io/stl.ts:11` and `repair/repair.ts:6` use `1e-4` mm; `kernel.ts:45` `WELD_TOLERANCE=1e-4`; `kernel.ts:380` `simplify(1e-3)`; `topo/build.ts:18` `MAX_WIDTH=10`; `meta.ts:7` `AREA_EPS=1e-8`; `repair.ts:518` `1e-8`. PLAN §4.2 R1 says `max(1e-6, 1e-6 · bboxDiag)`. For a model in metres a 1e-4 weld is 0.1 mm (20 % of a 0.5 mm bevel) and 1e-3 simplify is larger than the bevel; for a model in inches the 10-unit max width is 254 mm. Measured far-origin effect on the same 20 mm cube edge at r=2: offset 0 → removed 18.7706; 1e4 → 18.7738; 1e5 → 18.6633; 1e6 → **17.6563** (−6 %); at 1e7 the cut solid's own volume is 20 instead of 18.77 (float32 ULP = 1 mm). No warning is raised. `cutSolid.ts:265-284` `orientOutward` also sums absolute-coordinate `a·(b×c)` terms (~1e18 at x=1e6) to decide the winding, which is numerically fragile.

**Fix:** derive `weldTol = max(1e-7, 1e-6 × bboxDiag)`, `simplifyTol = min(r × 0.002, bboxDiag × 1e-6)`, and `maxWidth` limits from the bbox; build cut solids relative to the edge midpoint (or the bbox min) and translate back; warn when `width < 8 × ULP(maxCoord)`. Add a test that translates the cube by 1e6 and asserts the removed volume is within 0.1 % of the origin case.

### E13 — Per-call full-mesh work and allocations; no chunked union; export recomputes

**Evidence:** `kernel.ts:634-687` scans **every vertex** of the mesh on every bevel to find corners, allocating a `normals: Vec3[]` per vertex; `kernel.ts:588-589` allocates `widthByEdge = new Float32Array(topo.edgeCount)` (6.4 MB at 1 M edges) and `kernel.ts:629` `cornerOk = new Uint8Array(vertexCount)` on every preview. `kernel.ts:792-793` passes all cut solids to one `Manifold.union(solids)`; PLAN §4.4.6 says chunk by 128. `worker.ts:112-123` re-runs the full bevel on export instead of reusing the preview. `repairMesh` re-welds the already-welded parse (`repair.ts:61`), uses string keys for duplicate faces (`repair.ts:213`), and `computeMeshMeta` builds a second component union-find after `finalizeComponents` already built one (`meta.ts:204-228`). Measured 1 M: parse 1 346 ms, repair+edges 5 315 ms, bevel 400 edges 5 469 ms (README 1.18 s / 3.64 s / 3.97 s); the bench prints numbers but asserts nothing.

**Fix:** iterate only the vertices in the `incident` map (already built at `kernel.ts:593-601`) and read their full incident lists; use a `Map`/stamped array for widths; chunk the union in groups of 128 and union the partials; cache the last `(params, selection, mesh)` in the worker for export. Add a bench budget assertion (the §4.6 table / a 25 % regression threshold) and report result triangle counts.

### E14 — Warning text is wrong for flat edges, and the UI drops the warnings

**Evidence:** `bevel/topology.ts:121-124` and `142-145` collapse flat, boundary and non-manifold into `convex = 2`; `kernel.ts:490-495` counts every non-convex/non-flat kind as `unusable` and `kernel.ts:544-550` says “Skipped N edges that are not two-sided.” A flat edge is two-sided; on the 64-gon prism the coplanar top-fan radial edges trigger this message. `useLivePreview.ts:45-50` stores only `mesh`/`meta`/`clampedEdges`/`stale` from the result, so `bevel.concave`, `bevel.short`, `bevel.narrow`, `bevel.retry`, `bevel.nonManifold`, `bevel.shells`, `bevel.fragments` never reach the UI. The architecture review already has the dropped-warnings half as P1-5.

**Fix:** keep the analyzer's `EdgeKind`/flags in the kernel topology (pass the `EdgeTable` or add flat/boundary/non-manifold counters) and report “flat or non-manifold” separately from “boundary”. Store `warnings` in the preview state and render them (the Inspector's chip row is the natural place). Add a test that a flat selected edge produces a flat-specific warning and that the preview state keeps all warnings.

### E15 — Dead code, dead options and stale spike copies

**Evidence:** `src/engine/bevel/index.ts:1-10` is imported by nothing (the worker imports `./bevel/kernel` directly). `experiments/spike/**` is not imported by production or tests; only `package.json:13` (`npm run spike`) and the docs reference it. `experiments/spike/load.ts:143` says `src/engine/io/stl.ts` uses “the naive one-cell version” — it actually checks 27 cells (`stl.ts:153-168`). `experiments/spike/run.ts:37` hard-codes `C:/Users/basti/AI_printing/example_stl_beveling/...`, so the script is not portable; `experiments/spike/out/*.stl` are 300 KB of generated artifacts. `types.ts:103-118` has `limitAngle` (default 30, while `topo/build.ts:15` hard-codes 20 and never reads the option), `miterJoin` (never read), `creaseAngle` (never read), and `smoothing` (read only by the Inspector toggle; `viewport/meshView.ts` always builds creased normals). `protocol.ts:13` has `draft`, ignored by `worker.ts`. The spike's `DEFAULT_CUT` and `sliverArea`/`expectedCutVolume` are unused by production — the production `bevelMesh` never computes the expected cut volume, so PLAN §4.4.7's “volume delta within 1.5× expected” is not implemented.

**Fix:** delete `bevel/index.ts`; keep `report.json` as the M0 evidence and either delete the spike source or move it under `experiments/` with a relative fixture path and a “not production” README; fix the stale weld comment. Either wire `limitAngle`/`miterJoin`/`creaseAngle`/`smoothing` or remove them from the frozen params (the architecture review's P2-13). Port `sliverArea`/`expectedCutVolume` into the validator (E1/E9).

### E16 — Binary STL with a `solid` header and trailing bytes; kernel throws on an open base

**Evidence**

- `io/stl.ts:50-57`: `looksBinary` returns true only if `84 + count×50 === length` exactly; otherwise it falls back to “header is not `solid`”. A valid binary STL whose 80-byte header starts with `solid` and has one trailing newline fails the length check, is decoded as ASCII, finds no `vertex` tokens, and throws “STL contains no triangles” (reproduced with a cube plus one 0x0a byte). Binary files with a `solid` header are common enough that the comment “the length check is authoritative” is not safe.
- `kernel.ts:450` calls `topologyFor` → `meshToManifold` with no try/catch. An open/non-manifold base throws `ManifoldError: Not manifold` (reproduced by selecting a boundary edge of a cube with one face removed). The worker catches it and posts an `error`, and `useLivePreview.ts:52-55` silently sets the preview to null; the `watertight` error warning says beveling is disabled, but the engine never returns the structured “disabled” result the UI could explain.

**Fix:** treat a length mismatch as binary when `84 + 50×count <= length` and the remainder is small, or when the first 80 bytes contain a NUL/non-printable; add a padded-`solid`-header test. Wrap `topologyFor`/`meshToManifold` in `bevelMesh` and return an `emptyResult` plus an error `MeshWarning` (or make the UI gate on `meta.watertight`); test that an open base yields a result with `manifold:false` and a readable warning, not a thrown error.

---

## Requested cases (what actually happens)

| Case | Behaviour | Evidence |
|---|---|---|
| Concave edge selected | Skipped, `bevel.concave` warning, base returned unchanged | `kernel.ts:487-542`; `kernel.test.ts:233-250` |
| Boundary / non-manifold edge selected | The kernel's `unusable` warning is unreachable because `meshToManifold` throws on the open base first; the worker posts an error and the preview silently clears | E16; `kernel.ts:450` |
| Edge shorter than the width | Per-edge 4r skip; on a chain this removes the whole bevel (64-gon rim, 1 M default) | E4; `kernel.ts:516-519` |
| Two disconnected shells | Both are beveled; `shells=2` and a `bevel.shells` warning; no test | `cleanup` `kernel.ts:388`; probe `shells:2` |
| >2 faces per edge | Analyzer flags `EDGE_NON_MANIFOLD` (`topo/build.ts:92`); the kernel topology marks `convex=2` and would skip it, but in practice `meshToManifold` on a non-manifold base throws first (same path as the boundary case) | E16; `bevel/topology.ts:93-97` |
| Chain ends mid-surface | Taper over `min(r, 0.25L)`; works on a single cube edge (7983.73 mm³) and chain extension works on a split 40 mm edge (35.0385 mm³ both ways); under clamp the taper is the main source of self-intersections | `kernel.ts:689-722`; E1 |
| Fully selected cube corner | Sphere cut per 3-face corner; 7786.44 mm³, manifold, 1 shell | `kernel.test.ts:201-214`; `cutSolid.ts:299-329` |

---

## Test gaps

The suite is good on repair regressions and volume, weak on the engine's actual failure modes. In priority order, with the smallest test that would have caught a real bug:

| Gap | Smallest test | Catches |
|---|---|---|
| No self-intersection check | Hook outside rim with `{...DEFAULT_BEVEL, width:0.5}`; assert `countSelfIntersections(result.mesh) === 0` | E1 (113 pairs today) |
| No memory test | 50 `bevelMesh` calls; assert RSS delta < 50 MB | E2 (~220 MB today) |
| No tessellated rim | 64-gon prism, top rim, width 1; assert `removed > 0` and no `bevel.short` | E4 (0 today) |
| No decimation guard | 10×10 subdivided cube, bevel one edge; assert result triangles ≥ 50 % of base | E3 (32 vs 1 200 today) |
| No non-planar/non-convex hole | 5×5 grid with an L hole; assert `holesUnresolved > 0` or one cap, not `holesFilled=2` + volume 0 | E6 |
| No small-shell retention | 20 mm cube + 300 mm cube; assert both shells survive or the drop is explicit | E7 |
| No profile/segment test | One cube edge at profile 0 / 0.5 / 1 and segments 1 / 4 / 8; assert removed volume is monotone (chamfer > arc > bulge) | profile/segment regressions |
| No two-shell / boundary test | Two separated cubes → `shells=2` + warning; boundary/non-manifold selection → structured refusal (E16), not a throw | E16 / shell paths |
| No ASCII/parse edge test | Binary cube with `solid` header + trailing byte; ASCII cube; truncated binary | E16 |
| No 1 M result assertion | Bench asserts result triangles ≥ base triangles and no `bevel.short` at the default width | E3/E4 |
| Acceptance not a gate | Assert volume/bbox/shell/genus/SI/re-import and exit non-zero | E9 |

The strongest existing tests are the cube analytic volumes (7981.23 / 7786.44), the hook volume window, the edge-id contract on the cube/hook, the maxWidth brute-force comparison, and the repair fixtures; keep them. The missing dimension is **geometry validity of the result** (self-intersection, decimation, chain coverage), not topology or volume.

## The 3 fixes I would do first

1. **Make the default bevel self-intersection-free (E1 + E5).** The app's default clamp path already fails the repo's own SAT check on the reference part (113 pairs), and no test/acceptance notices. Port the spike's `countSelfIntersections` into a validator, assert 0 in acceptance, and fix the trigger: clamp per chain/vertex instead of per edge, use `extend` at terminations, and drop the inset retry. Until that lands, return the base or exclude the offending edges rather than shipping a self-intersecting STL.
2. **Free the WASM objects (E2).** The kernel leaks ~4.4 MB per hook bevel; a slider drag will OOM the worker long before the user finishes a session. Add `try/finally` `delete()` calls around every intermediate Manifold/Mesh and a 50-iteration memory test. This is mechanical and low-risk, and it makes the live-preview promise sustainable.
3. **Fix the 1 M / tessellated path (E4 + E3).** The per-edge 4r check turns a 64-gon rim or the 1 M cube's 1 mm rim into a no-op at the default width, and `simplify(1e-3)` collapses 1.08 M triangles to 4 200. Make the short check chain-aware and remove or scope the global simplify, with a triangle-count guard. These two changes are what make “1 M triangles, bevel the outside edges” true rather than a benchmark special case.

After those, E6/E7 (repair data integrity) and E8/E9 (maxWidth + a real acceptance gate) are the next tier.
