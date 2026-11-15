import { Vector3, type PerspectiveCamera } from 'three';
import { EDGE_CANDIDATE, type EdgeTable } from '../engine/types';

const a = new Vector3();
const b = new Vector3();
const mid = new Vector3();

/**
 * Edges whose projected segment comes within `thresholdPx` of the stroke
 * segment. Screen-space is the right space for a paint stroke: the user is
 * saying "these edges", not "this surface path".
 *
 * A depth band rejects edges on the far side of the part that happen to project
 * onto the same pixels; `referenceDepth` is the distance to the surface point
 * under the cursor.
 */
export function edgesAlongStroke(
  table: EdgeTable,
  candidates: Uint32Array,
  camera: PerspectiveCamera,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thresholdPx: number,
  depthBand: number,
  depthStart: number,
  depthEnd: number,
  out: number[],
): void {
  out.length = 0;
  const cameraPosition = camera.position;
  const sx = x1 - x0;
  const sy = y1 - y0;
  const strokeLengthSq = sx * sx + sy * sy;

  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];
    const o = id * 6;
    a.set(table.position[o], table.position[o + 1], table.position[o + 2]);
    b.set(table.position[o + 3], table.position[o + 4], table.position[o + 5]);
    mid.addVectors(a, b).multiplyScalar(0.5);

    a.project(camera);
    b.project(camera);
    if (a.z > 1 || b.z > 1 || a.z < -1 || b.z < -1) continue;

    const ax = (a.x * 0.5 + 0.5) * width;
    const ay = (-a.y * 0.5 + 0.5) * height;
    const bx = (b.x * 0.5 + 0.5) * width;
    const by = (-b.y * 0.5 + 0.5) * height;

    if (segmentDistance(ax, ay, bx, by, x0, y0, x1, y1) > thresholdPx) continue;

    // Depth changes along a stroke on a curved part, so compare against the
    // reference depth interpolated at the edge's position along the stroke.
    const mx = (ax + bx) * 0.5 - x0;
    const my = (ay + by) * 0.5 - y0;
    const t =
      strokeLengthSq < 1e-9
        ? 0
        : Math.max(0, Math.min(1, (mx * sx + my * sy) / strokeLengthSq));
    const referenceDepth = depthStart + (depthEnd - depthStart) * t;

    if (Math.abs(cameraPosition.distanceTo(mid) - referenceDepth) > depthBand) continue;

    out.push(id);
  }
}

/** Shortest distance between two 2D segments. */
function segmentDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegment(ax, ay, cx, cy, dx, dy),
    pointSegment(bx, by, cx, cy, dx, dy),
    pointSegment(cx, cy, ax, ay, bx, by),
    pointSegment(dx, dy, ax, ay, bx, by),
  );
}

function pointSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const lengthSq = vx * vx + vy * vy;
  const t =
    lengthSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lengthSq));
  const x = ax + vx * t - px;
  const y = ay + vy * t - py;
  return Math.hypot(x, y);
}

function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const value = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const o1 = orientation(ax, ay, bx, by, cx, cy);
  const o2 = orientation(ax, ay, bx, by, dx, dy);
  const o3 = orientation(cx, cy, dx, dy, ax, ay);
  const o4 = orientation(cx, cy, dx, dy, bx, by);
  return o1 !== o2 && o3 !== o4;
}

/** Candidate edge ids for a table, in canonical order. */
export function candidateEdges(table: EdgeTable): Uint32Array {
  const ids: number[] = [];
  for (let i = 0; i < table.count; i++) {
    if (table.flags[i] & EDGE_CANDIDATE) ids.push(i);
  }
  return Uint32Array.from(ids);
}
