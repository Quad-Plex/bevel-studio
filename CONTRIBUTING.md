# Contributing

Thanks for taking a look. This document covers the local setup, the house rules
and what a change needs before it is merged.

## Setup

Requirements are Node 26+ and npm 11+. The desktop build additionally needs
Rust stable with the MSVC toolchain, Visual Studio Build Tools (C++ workload)
and the WebView2 runtime.

```bash
npm ci
npm run dev        # http://localhost:5183
```

Run `npm run typecheck`, `npm test` and `npm run build` before opening a pull
request. `npm run acceptance` must stay green when you touch geometry.

## Layout

| Path | What lives there |
|---|---|
| `src/engine/` | Pure geometry code: STL I/O, repair, topology, bevel kernel, worker |
| `src/viewport/` | three.js scene, edge overlay, picking, selection gestures |
| `src/panels/`, `src/ui/` | Inspector, status bar, shared controls |
| `src/state/` | zustand store, engine client, live preview, export |
| `src-tauri/` | Desktop shell and packaging |
| `tools/` | Acceptance, benchmark and browser checks |
| `public/fixtures/` | Reference models used by the app and acceptance |

## Ground rules

1. **Keep the engine pure.** `src/engine/**` must not import three.js, React or
   the DOM. It runs in a worker, in Node tools and in tests.
2. **Respect the contracts.** `src/engine/types.ts` and
   `src/engine/protocol.ts` are shared by every layer. Propose a change in an
   issue before editing them.
3. **Repair before topology.** Edge ids are only canonical for a repaired mesh;
   anything that calls the kernel must go through the repair pipeline first.
4. **Never ship bad geometry.** A result that fails the watertight check stays
   export-blocked. Do not weaken the check to make a test pass.
5. **Deterministic output.** The same mesh and parameters must produce the same
   mesh and STL bytes.
6. **Measure before claiming.** Performance numbers in the README come from
   `npm run bench` and the browser runs in `tools/`. Do not add estimates.
7. **Dependencies are a decision, not a detail.** Open an issue before adding
   one; the engine deliberately has a small dependency set.
8. **No per-frame allocations** and no O(n) passes over the full mesh in code
   that runs on pointer or frame events.

## Tests

- Unit tests live next to the code (`*.test.ts`) and run with `npm test`.
- Geometry changes need a test that would fail without the change.
- `npm run acceptance` compares against the hand-made Blender reference and is
  the release gate for the kernel.
- Browser checks in `tools/e2e-*.mjs` need `npm run preview` and Chrome; they
  are manual, not part of CI.

## Commits and pull requests

- Write an imperative subject (`Fix preview coalescing on import`), keep the
  body focused on why the change is needed.
- One logical change per pull request; keep refactors out of feature branches.
- Describe the verification you ran. A pull request that changes geometry must
  say whether `npm run acceptance` passed.
- Update `README.md` or `docs/ARCHITECTURE.md` when behaviour or contracts
  change. Release-visible changes also get a `CHANGELOG.md` entry.

## Reporting bugs

Include the STL (or a minimal reproducer), the parameters, the browser or
desktop build, and what the Inspector reported (watertight, warnings). For
security issues, follow [`SECURITY.md`](SECURITY.md) instead of opening a
public issue.
