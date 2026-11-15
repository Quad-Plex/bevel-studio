import type { MeshData } from '../types';

export interface ParsedStl {
  mesh: MeshData;
  format: 'binary' | 'ascii';
  triangles: number;
  /** Raw STL vertices merged away by the weld (3 per triangle before welding). */
  weldedVertices: number;
}

const DEFAULT_TOLERANCE = 1e-4;
/** Refuse absurd inputs before allocating: 2 GB / 50 M triangles / ±1e9 mm. */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TRIANGLES = 50_000_000;
const MAX_COORDINATE = 1e9;

/**
 * STL reader. Binary and ASCII. Produces a welded, indexed mesh: identical
 * corner positions are merged within `tolerance` mm so that a triangle-soup STL
 * becomes a connected surface the topology pass can walk.
 *
 * The API is frozen (`mesh`, `format`, `triangles`); `weldedVertices` is
 * additive so the worker can report the weld in the repair summary.
 *
 * Units are millimetres throughout. Nothing is rescaled or recentred.
 */
export function parseStl(buffer: ArrayBuffer, tolerance = DEFAULT_TOLERANCE): ParsedStl {
  const bytes = new Uint8Array(buffer);

  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`STL is ${(bytes.length / 1e6).toFixed(0)} MB; the limit is 2 GB.`);
  }

  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new Error(
      'This file is a ZIP archive (3MF or similar), not an STL. Open it in a 3MF viewer or export it as STL.',
    );
  }

  const isBinary = looksBinary(bytes, buffer.byteLength);
  const raw = isBinary ? readBinary(new DataView(buffer)) : readAscii(decodeAscii(bytes));

  if (raw.positions.length === 0) throw new Error('STL contains no triangles');
  if (raw.indices.length % 3 !== 0) {
    throw new Error(`STL contains ${raw.indices.length / 3} vertices, not a multiple of 3 triangles`);
  }

  const mesh = weld(raw.positions, raw.indices, tolerance);
  const rawVertices = raw.positions.length / 3;
  return {
    mesh,
    format: isBinary ? 'binary' : 'ascii',
    triangles: raw.indices.length / 3,
    weldedVertices: rawVertices - mesh.positions.length / 3,
  };
}

function looksBinary(bytes: Uint8Array, length: number): boolean {
  if (length < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  // The length check is authoritative; a binary file may still start with "solid".
  if (84 + count * 50 === length) return true;
  const head = new TextDecoder().decode(bytes.subarray(0, 5)).toLowerCase();
  return head !== 'solid';
}

function decodeAscii(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function readBinary(view: DataView): { positions: Float32Array; indices: Uint32Array } {
  if (view.byteLength < 84) throw new Error('Binary STL is truncated: header is shorter than 84 bytes');
  const count = view.getUint32(80, true);
  if (count > MAX_TRIANGLES) {
    throw new Error(`STL claims ${count.toLocaleString()} triangles; the limit is 50 million.`);
  }
  const needed = 84 + count * 50;
  if (needed > view.byteLength) {
    throw new Error(
      `Binary STL is truncated: ${count} triangles need ${needed} bytes but the file has ${view.byteLength}`,
    );
  }
  const positions = new Float32Array(count * 9);
  const indices = new Uint32Array(count * 3);
  let o = 84;
  for (let t = 0; t < count; t++) {
    o += 12; // facet normal — recomputed from winding later
    for (let k = 0; k < 3; k++) {
      positions[t * 9 + k * 3] = view.getFloat32(o, true);
      positions[t * 9 + k * 3 + 1] = view.getFloat32(o + 4, true);
      positions[t * 9 + k * 3 + 2] = view.getFloat32(o + 8, true);
      indices[t * 3 + k] = t * 3 + k;
      o += 12;
    }
    o += 2;
  }
  return { positions, indices };
}

function readAscii(text: string): { positions: Float32Array; indices: Uint32Array } {
  const out: number[] = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    const z = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error('ASCII STL contains an invalid vertex coordinate');
    }
    out.push(x, y, z);
  }
  if (out.length === 0) throw new Error('STL contains no triangles');
  if (out.length % 9 !== 0) {
    throw new Error(`ASCII STL has ${out.length / 3} vertices, not a multiple of 3 triangles`);
  }
  const positions = new Float32Array(out);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

/**
 * Merge coincident vertices within `tolerance` mm.
 *
 * Uses a spatial hash on a grid of `tolerance` cells and checks all 27
 * neighbouring cells, so two points a hair apart that straddle a cell boundary
 * still merge. Buckets are linked lists (`head` + `next`) instead of arrays of
 * arrays: 3 M raw STL vertices must not allocate 3 M small arrays.
 */
export function weld(
  positions: Float32Array,
  indices: Uint32Array,
  tolerance = DEFAULT_TOLERANCE,
): MeshData {
  const vertexCount = positions.length / 3;
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : DEFAULT_TOLERANCE;
  const inv = 1 / tol;
  const tol2 = tol * tol;

  const outPos = new Float32Array(positions.length);
  const outIdx = new Uint32Array(indices.length);
  const remap = new Uint32Array(vertexCount);
  const next = new Int32Array(vertexCount);
  next.fill(-1);
  const head = new Map<number, number>();
  let outCount = 0;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    if (
      Math.abs(x) > MAX_COORDINATE ||
      Math.abs(y) > MAX_COORDINATE ||
      Math.abs(z) > MAX_COORDINATE
    ) {
      throw new Error(
        'STL contains coordinates beyond ±1e9; it is probably not in millimetres.',
      );
    }

    let id = -1;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      const cx = Math.round(x * inv);
      const cy = Math.round(y * inv);
      const cz = Math.round(z * inv);

      search: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = head.get(cellHash(cx + dx, cy + dy, cz + dz));
            for (let cand = bucket; cand !== undefined && cand >= 0; cand = next[cand]) {
              const ex = outPos[cand * 3] - x;
              const ey = outPos[cand * 3 + 1] - y;
              const ez = outPos[cand * 3 + 2] - z;
              if (ex * ex + ey * ey + ez * ez <= tol2) {
                id = cand;
                break search;
              }
            }
          }
        }
      }

      if (id < 0) {
        id = outCount++;
        outPos[id * 3] = x;
        outPos[id * 3 + 1] = y;
        outPos[id * 3 + 2] = z;
        const h = cellHash(cx, cy, cz);
        next[id] = head.get(h) ?? -1;
        head.set(h, id);
      }
    } else {
      // Non-finite vertices cannot be hashed. Keep them unique; the repair
      // pass drops every triangle that references them.
      id = outCount++;
      outPos[id * 3] = x;
      outPos[id * 3 + 1] = y;
      outPos[id * 3 + 2] = z;
    }

    remap[i] = id;
  }

  for (let i = 0; i < indices.length; i++) outIdx[i] = remap[indices[i]];
  return { positions: outPos.slice(0, outCount * 3), indices: outIdx };
}

function cellHash(cx: number, cy: number, cz: number): number {
  let h =
    Math.imul(cx | 0, 0x8da6b343) ^
    Math.imul(cy | 0, 0xd8163841) ^
    Math.imul(cz | 0, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) | 0;
}

/**
 * Drop triangles that collapse after welding, contain a non-finite coordinate,
 * or have an area below `tolerance²`. Triangle order is preserved.
 */
export function dropDegenerate(mesh: MeshData, tolerance = DEFAULT_TOLERANCE): MeshData {
  const { positions, indices } = mesh;
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : DEFAULT_TOLERANCE;
  const areaEps = tol * tol;
  const keep: number[] = [];

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    if (a === b || b === c || a === c) continue;

    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const bx = positions[b * 3];
    const by = positions[b * 3 + 1];
    const bz = positions[b * 3 + 2];
    const cx = positions[c * 3];
    const cy = positions[c * 3 + 1];
    const cz = positions[c * 3 + 2];
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
      !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    ) {
      continue;
    }

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const area2 = Math.hypot(nx, ny, nz);
    if (!(area2 * 0.5 >= areaEps)) continue;

    keep.push(a, b, c);
  }

  if (keep.length === indices.length) return mesh;
  return { positions, indices: new Uint32Array(keep) };
}
