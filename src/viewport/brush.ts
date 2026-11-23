import { Vector3, type PerspectiveCamera } from 'three';
import { EDGE_CONCAVE, EDGE_CONVEX, type EdgeTable } from '../engine/types';

/** Which feature edges the brush touches. */
export type BrushFilter = 'all' | 'outside' | 'inside';

/**
 * Sharper than this an edge is a feature the user can bevel. Softer creases
 * are the tessellation of a curved surface; brushing over a cylinder must not
 * pick its facet lines.
 */
export const BRUSH_FEATURE_DEG = 15;

/**
 * Edge ids the brush may affect: convex and/or concave feature edges. Flat
 * triangulation diagonals are never pickable, and neither are boundary or
 * non-manifold edges (the kernel cannot bevel them).
 */
export function brushableEdges(table: EdgeTable, filter: BrushFilter): Uint32Array {
  const mask =
    filter === 'outside' ? EDGE_CONVEX : filter === 'inside' ? EDGE_CONCAVE : EDGE_CONVEX | EDGE_CONCAVE;
  const ids: number[] = [];
  for (let i = 0; i < table.count; i++) {
    if (table.flags[i] & mask && table.dihedral[i] >= BRUSH_FEATURE_DEG) ids.push(i);
  }
  return Uint32Array.from(ids);
}

const a = new Vector3();
const b = new Vector3();
const point = new Vector3();

export interface BrushQuery {
  table: EdgeTable;
  ids: Uint32Array;
  camera: PerspectiveCamera;
  /** canvas size in CSS pixels */
  width: number;
  height: number;
  /** stroke from (x0, y0) to (x1, y1), canvas pixels; a hover is a zero-length stroke */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** brush radius in pixels */
  radius: number;
  /**
   * Visibility of a world point on the surface (not hidden behind other
   * geometry). Called only for edges already inside the brush.
   */
  visible: (p: Vector3) => boolean;
}

/**
 * Edges whose projected segment passes within `radius` pixels of the stroke
 * and whose closest point to it is visible. Results are sorted by screen
 * distance, nearest first.
 */
export function edgesInBrush(query: BrushQuery, out: number[]): number[] {
  out.length = 0;
  const { table, ids, camera, width, height, x0, y0, x1, y1, radius } = query;
  const found: { id: number; d: number }[] = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const o = id * 6;
    a.set(table.position[o], table.position[o + 1], table.position[o + 2]);
    b.set(table.position[o + 3], table.position[o + 4], table.position[o + 5]);

    // Clip the segment against the near plane before projecting, so an edge
    // that runs past the camera still projects sensibly.
    if (!clipToNear(camera, a, b)) continue;
    const pa = project(camera, a, width, height);
    const pb = project(camera, b, width, height);
    if (!pa || !pb) continue;

    const hit = closestBetweenSegments(pa[0], pa[1], pb[0], pb[1], x0, y0, x1, y1);
    if (hit.distance > radius) continue;

    // The screen parameter along the projected edge is not the world one
    // under perspective; interpolate in clip space via the homogeneous w.
    const s = perspectiveParameter(hit.s, pa[2], pb[2]);
    point.lerpVectors(a, b, s);
    if (!query.visible(point)) continue;
    found.push({ id, d: hit.distance });
  }

  found.sort((p, q) => p.d - q.d || p.id - q.id);
  for (const f of found) out.push(f.id);
  return out;
}

const view = new Vector3();

/** Moves a or b onto the near plane when the segment crosses it; false when wholly behind. */
function clipToNear(camera: PerspectiveCamera, pa: Vector3, pb: Vector3): boolean {
  const near = camera.near * 1.001;
  const da = -view.copy(pa).applyMatrix4(camera.matrixWorldInverse).z;
  const db = -view.copy(pb).applyMatrix4(camera.matrixWorldInverse).z;
  if (da < near && db < near) return false;
  if (da < near) pa.lerp(pb, (near - da) / (db - da));
  else if (db < near) pb.lerp(pa, (near - db) / (da - db));
  return true;
}

const clip = new Vector3();

/** [x, y, w] in canvas pixels, w = view depth; null when not projectable. */
function project(camera: PerspectiveCamera, p: Vector3, width: number, height: number): [number, number, number] | null {
  const depth = -view.copy(p).applyMatrix4(camera.matrixWorldInverse).z;
  if (!(depth > 0)) return null;
  clip.copy(p).project(camera);
  if (!Number.isFinite(clip.x) || !Number.isFinite(clip.y)) return null;
  return [(clip.x * 0.5 + 0.5) * width, (-clip.y * 0.5 + 0.5) * height, depth];
}

/** World parameter for a screen parameter `s` on a segment with end depths wa, wb. */
function perspectiveParameter(s: number, wa: number, wb: number): number {
  const denom = (1 - s) / wa + s / wb;
  if (!(denom > 0)) return s;
  return s / wb / denom;
}

/**
 * Closest approach between segment P (a → b) and segment Q (c → d) in 2-D.
 * `s` is the parameter on P of the closest point.
 */
export function closestBetweenSegments(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): { distance: number; s: number } {
  const ux = bx - ax;
  const uy = by - ay;
  const vx = dx - cx;
  const vy = dy - cy;
  const den = ux * vy - uy * vx;
  if (Math.abs(den) > 1e-12) {
    const wx = cx - ax;
    const wy = cy - ay;
    const s = (wx * vy - wy * vx) / den;
    const t = (wx * uy - wy * ux) / den;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return { distance: 0, s };
  }
  let best = { distance: Infinity, s: 0 };
  const consider = (distance: number, s: number) => {
    if (distance < best.distance) best = { distance, s };
  };
  // endpoints of Q against P
  for (const [px, py] of [
    [cx, cy],
    [dx, dy],
  ]) {
    const s = projectParam(px, py, ax, ay, ux, uy);
    consider(Math.hypot(ax + ux * s - px, ay + uy * s - py), s);
  }
  // endpoints of P against Q
  for (const [px, py, s] of [
    [ax, ay, 0],
    [bx, by, 1],
  ]) {
    const t = projectParam(px, py, cx, cy, vx, vy);
    consider(Math.hypot(cx + vx * t - px, cy + vy * t - py), s);
  }
  return best;
}

function projectParam(px: number, py: number, ox: number, oy: number, ux: number, uy: number): number {
  const lengthSq = ux * ux + uy * uy;
  if (lengthSq < 1e-12) return 0;
  return Math.max(0, Math.min(1, ((px - ox) * ux + (py - oy) * uy) / lengthSq));
}
