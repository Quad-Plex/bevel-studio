# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Bevel-band tint: triangles created by the cut solids are shaded light purple,
  so the fillet is distinguishable from the untouched surface.
- Wireframe toggle for the shaded model, in the inspector and with `W`.
- Concave edges are beveled as additive rolling-ball fillets; their faces are
  tinted like cut bevels.

### Fixed

- Selected edge chains are beveled continuously: short segments are no longer
  dropped, and joints keep their full radius instead of tapering into gaps.
- Sweeps at a chain joint are extended by the miter length, so two 90° bevels
  meet at an object corner instead of leaving a sharp ridge.
- Cut-solid side walls are inset by 1e-3 mm so the boolean never sees them
  coplanar with the base faces.
- Corrections for the reference model's 0.02 mm sliver wall: the repair
  pipeline collapses sliver faces, so the bend-to-plate junction is a real edge
  and is beveled instead of being skipped as a narrow knife edge.
- A smooth chain of short segments shares one clamped width, so per-edge sweep
  caps no longer scallop the band at large widths.
- Knife-edge fillets fade over their own footprint at cap faces instead of
  ending in a 90° side wall (the notch step on the reference hook).
- The boolean result is welded at 1e-3 mm, and sub-weld contacts are tested as
  coplanar rather than reported as crossings, so the all-convex hook selection
  is exportable.

## [0.1.0] — 2026-11-15

First working release.

### Added

- STL import (binary and ASCII) with vertex welding, winding repair, hole
  filling and shell cleanup.
- Canonical edge table with dihedral angle, convexity, per-edge width clamp and
  automatic candidate detection.
- Click, paint and erase selection with undo/redo, select-all and view refit.
- Rolling-ball bevel kernel with cut solids and a Manifold WASM boolean; live
  preview in a dedicated worker with request coalescing and document epochs.
- Width, segments and profile controls with clamped-edge warnings, watertight
  validation and blocked export on failure.
- Binary STL export preserving units and origin.
- Tauri v2 desktop build with NSIS installer and a strict content security
  policy.
- Acceptance harness against the hand-made Blender reference, plus a
  1 M-triangle benchmark and browser checks.
- MIT license, CI workflow and contributor documentation.

### Known issues

- Beveling all convex edges can self-intersect at the tight plate corners of
  the reference hook; the result is detected, flagged and export-blocked until
  the clamp is chain-consistent.
- Loop/ring and silhouette-sweep selection are not implemented.
- Pointer picking on million-triangle meshes is linear and slow.
- Concave edges are rejected by design.

[0.1.0]: https://github.com/Quad-Plex/bevel-studio/releases/tag/v0.1.0
