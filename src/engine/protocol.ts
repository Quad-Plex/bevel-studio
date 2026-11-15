/**
 * Worker protocol. The main thread only ever talks to the geometry engine
 * through these messages; nothing here may import three.js or React.
 *
 * Large arrays travel as transferable ArrayBuffers next to a plain result
 * object, never nested inside it, so a million-triangle mesh or edge table is
 * not copied twice by structured clone.
 *
 * `epoch` is the document generation: incremented on every import, carried by
 * preview/export. A job carrying an old epoch is rejected instead of being
 * applied to a different document.
 */
import type { AnalysisResult, BevelParams, BevelResult, EdgeTable } from './types';

export type WorkerRequest =
  | { id: number; type: 'import'; buffer: ArrayBuffer; name: string }
  | { id: number; type: 'preview'; edges: Uint32Array; params: BevelParams; epoch: number }
  | {
      id: number;
      type: 'export';
      edges: Uint32Array;
      params: BevelParams;
      format: 'stl';
      epoch: number;
    }
  | { id: number; type: 'cancel'; target: number };

/** Edge table split into transferable buffers (ArrayBuffer each). */
export interface EdgeBuffers {
  count: number;
  v: ArrayBuffer;
  position: ArrayBuffer;
  dihedral: ArrayBuffer;
  flags: ArrayBuffer;
  maxWidth: ArrayBuffer;
  tris: ArrayBuffer;
}

export type ImportPayload = Omit<AnalysisResult, 'edges'>;
export type PreviewPayload = Omit<BevelResult, 'mesh'>;

export type WorkerResponse =
  | {
      id: number;
      type: 'imported';
      result: ImportPayload;
      edges: EdgeBuffers;
      positions: ArrayBuffer;
      indices: ArrayBuffer;
      epoch: number;
    }
  | {
      id: number;
      type: 'previewed';
      result: PreviewPayload;
      positions: ArrayBuffer;
      indices: ArrayBuffer;
    }
  | { id: number; type: 'exported'; bytes: ArrayBuffer; name: string }
  | { id: number; type: 'progress'; stage: string; value: number; epoch: number }
  | { id: number; type: 'error'; message: string; stage?: string; code?: 'superseded' };

export function edgeTableFromBuffers(buffers: EdgeBuffers): EdgeTable {
  return {
    count: buffers.count,
    v: new Uint32Array(buffers.v),
    position: new Float32Array(buffers.position),
    dihedral: new Float32Array(buffers.dihedral),
    flags: new Uint8Array(buffers.flags),
    maxWidth: new Float32Array(buffers.maxWidth),
    tris: new Uint32Array(buffers.tris),
  };
}

export function edgeTableToBuffers(edges: EdgeTable): { buffers: EdgeBuffers; transfer: ArrayBuffer[] } {
  const v = edges.v.slice();
  const position = edges.position.slice();
  const dihedral = edges.dihedral.slice();
  const flags = edges.flags.slice();
  const maxWidth = edges.maxWidth.slice();
  const tris = edges.tris.slice();
  return {
    buffers: {
      count: edges.count,
      v: v.buffer,
      position: position.buffer,
      dihedral: dihedral.buffer,
      flags: flags.buffer,
      maxWidth: maxWidth.buffer,
      tris: tris.buffer,
    },
    transfer: [v.buffer, position.buffer, dihedral.buffer, flags.buffer, maxWidth.buffer, tris.buffer],
  };
}
