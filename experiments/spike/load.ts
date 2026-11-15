/**
 * Spike STL reader — binary + ASCII, welded at 1e-4 mm.
 *
 * Deliberately a standalone copy of the approach in `src/engine/io/stl.ts`
 * (workstream K owns only `experiments/spike/**`, and must not import from
 * `src`). The parse path is the same; the additions are the statistics the
 * spike reports (bounds, signed volume, degenerate count, format).
 *
 * Units are millimetres throughout. Nothing is rescaled or recentred.
 */
import { readFileSync } from 'node:fs';

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface LoadStats {
  format: 'binary' | 'ascii';
  bytes: number;
  /** triangles in the file */
  triangles: number;
  /** vertices before welding (3 per triangle for STL) */
  rawVertices: number;
  /** vertices after welding */
  vertices: number;
  weldedAway: number;
  /** triangles that collapse to a line/point after welding */
  degenerateTriangles: number;
  bounds: Bounds;
  /** signed volume; negative means the file is inside-out */
  volume: number;
  surfaceArea: number;
}

export interface LoadedMesh {
  name: string;
  mesh: MeshData;
  stats: LoadStats;
}

/** Parse a binary or ASCII STL buffer and weld it. */
export function parseStlBuffer(buffer: ArrayBuffer, tolerance = 1e-4): { mesh: MeshData; stats: LoadStats } {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const binary = looksBinary(bytes, buffer.byteLength);
  const raw = binary ? readBinary(view) : readAscii(new TextDecoder('utf-8').decode(bytes));

  if (raw.positions.length === 0) throw new Error('STL contains no triangles');

  const mesh = weld(raw.positions, raw.indices, tolerance);
  const rawVertices = raw.positions.length / 3;
  const degenerateTriangles = countDegenerate(mesh);
  const bounds = meshBounds(mesh);
  const volume = signedVolume(mesh);
  const surfaceArea = triangleAreaSum(mesh);

  return {
    mesh,
    stats: {
      format: binary ? 'binary' : 'ascii',
      bytes: buffer.byteLength,
      triangles: raw.indices.length / 3,
      rawVertices,
      vertices: mesh.positions.length / 3,
      weldedAway: rawVertices - mesh.positions.length / 3,
      degenerateTriangles,
      bounds,
      volume,
      surfaceArea,
    },
  };
}

export function loadStl(path: string, tolerance = 1e-4): LoadedMesh {
  const file = readFileSync(path);
  const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  const { mesh, stats } = parseStlBuffer(buf, tolerance);
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return { name, mesh, stats };
}

// ---------------------------------------------------------------------------
// format detection and parsing
// ---------------------------------------------------------------------------

function looksBinary(bytes: Uint8Array, length: number): boolean {
  if (length < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  if (84 + count * 50 === length) return true;
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 5)).toLowerCase();
  return head !== 'solid';
}

function readBinary(view: DataView): { positions: Float32Array; indices: Uint32Array } {
  const count = view.getUint32(80, true);
  if (84 + count * 50 > view.byteLength) throw new Error(`binary STL truncated: ${count} triangles declared`);
  const positions = new Float32Array(count * 9);
  const indices = new Uint32Array(count * 3);
  let o = 84;
  for (let t = 0; t < count; t++) {
    o += 12; // facet normal — recomputed from winding later
    for (let k = 0; k < 3; k++) {
      const b = t * 9 + k * 3;
      positions[b] = view.getFloat32(o, true);
      positions[b + 1] = view.getFloat32(o + 4, true);
      positions[b + 2] = view.getFloat32(o + 8, true);
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
    out.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
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
 * Hashes on a quantised grid but checks the 27 neighbouring cells, so two
 * points a hair apart that straddle a cell boundary still merge (the naive
 * one-cell version in `src/engine/io/stl.ts` does not).
 */
export function weld(positions: Float32Array, indices: Uint32Array, tolerance: number): MeshData {
  const inv = 1 / tolerance;
  const tol2 = tolerance * tolerance;
  const cells = new Map<string, number[]>();
  const outPos: number[] = [];
  const remap = new Uint32Array(positions.length / 3);

  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const cx = Math.round(x * inv);
    const cy = Math.round(y * inv);
    const cz = Math.round(z * inv);
    let id = -1;
    for (let dx = -1; dx <= 1 && id < 0; dx++) {
      for (let dy = -1; dy <= 1 && id < 0; dy++) {
        for (let dz = -1; dz <= 1 && id < 0; dz++) {
          const bucket = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const cand of bucket) {
            const ex = outPos[cand * 3] - x;
            const ey = outPos[cand * 3 + 1] - y;
            const ez = outPos[cand * 3 + 2] - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) {
              id = cand;
              break;
            }
          }
        }
      }
    }
    if (id < 0) {
      id = outPos.length / 3;
      outPos.push(x, y, z);
      const key = `${cx},${cy},${cz}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(id);
      else cells.set(key, [id]);
    }
    remap[i] = id;
  }

  const outIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) outIdx[i] = remap[indices[i]];
  return { positions: new Float32Array(outPos), indices: outIdx };
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

export function meshBounds(mesh: MeshData): Bounds {
  const p = mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Divergence-theorem volume; positive when triangles are wound CCW outward. */
export function signedVolume(mesh: MeshData): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    // a · (b × c)
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

function triangleAreaSum(mesh: MeshData): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let sum = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    sum += Math.hypot(nx, ny, nz) / 2;
  }
  return sum;
}

export function countDegenerate(mesh: MeshData): number {
  const idx = mesh.indices;
  let n = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a === b || b === c || a === c) n++;
  }
  return n;
}
