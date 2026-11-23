import { create } from 'zustand';
import {
  DEFAULT_BEVEL,
  EDGE_CANDIDATE,
  EDGE_CONCAVE,
  EDGE_CONVEX,
  type BevelParams,
  type EdgeTable,
  type MeshData,
  type MeshMeta,
  type MeshWarning,
} from '../engine/types';

export type Phase = 'idle' | 'importing' | 'ready' | 'beveling' | 'error';

/** Which feature edges the selection brush and bulk selection act on. */
export type EdgeKind = 'all' | 'outside' | 'inside';

export interface BrushSettings {
  /** brush radius in CSS pixels */
  radius: number;
  filter: EdgeKind;
}

export const BRUSH_MIN = 4;
export const BRUSH_MAX = 80;
/** Bulk selection uses the same feature threshold as the auto candidates. */
const SHARP_DEG = 20;

export interface PreviewState {
  mesh: MeshData;
  meta: MeshMeta;
  clampedEdges: number;
  stale: boolean;
  warnings: MeshWarning[];
  /** Crossings reported by the kernel; export is refused while this is > 0. */
  selfIntersections: number;
  /** 0/1 per triangle; 1 marks a face created by the bevel cut. */
  bevelFaces: Uint8Array;
}

export interface AppStore {
  phase: Phase;
  fileName: string | null;
  /** repaired source mesh, never mutated */
  mesh: MeshData | null;
  edges: EdgeTable | null;
  meta: MeshMeta | null;
  warnings: MeshWarning[];
  /** 1 byte per edge id, 0/1 */
  selected: Uint8Array | null;
  params: BevelParams;
  preview: PreviewState | null;
  showPreview: boolean;
  showWireframe: boolean;
  brush: BrushSettings;
  progress: { stage: string; value: number } | null;
  error: string | null;

  beginImport(fileName: string): void;
  /** Temporary shell-only import (no topology yet); engine import uses setImported. */
  setMeshOnly(fileName: string, mesh: MeshData, meta: MeshMeta): void;
  setImported(
    fileName: string,
    mesh: MeshData,
    edges: EdgeTable,
    meta: MeshMeta,
    warnings: MeshWarning[],
  ): void;
  fail(message: string): void;
  toggleEdge(id: number, on?: boolean): void;
  /** Apply one value to many edges with a single mask copy (stroke painting). */
  toggleEdges(ids: Iterable<number>, on: boolean): void;
  setSelection(mask: Uint8Array): void;
  selectCandidates(on: boolean): void;
  /** Select or clear every sharp (≥ 20°) edge of one kind. */
  selectSharp(kind: EdgeKind, on: boolean): void;
  setBrush(patch: Partial<BrushSettings>): void;
  clearSelection(): void;
  setParams(patch: Partial<BevelParams>): void;
  setPreview(preview: PreviewState | null): void;
  setShowPreview(on: boolean): void;
  setShowWireframe(on: boolean): void;
  setError(message: string | null): void;
  setBeveling(on: boolean): void;
  setProgress(progress: { stage: string; value: number } | null): void;
  reset(): void;
}

export const useApp = create<AppStore>((set, get) => ({
  phase: 'idle',
  fileName: null,
  mesh: null,
  edges: null,
  meta: null,
  warnings: [],
  selected: null,
  params: DEFAULT_BEVEL,
  preview: null,
  showPreview: true,
  showWireframe: false,
  brush: { radius: 14, filter: 'all' },
  progress: null,
  error: null,

  beginImport: (fileName) => set({ phase: 'importing', fileName, error: null }),

  setMeshOnly: (fileName, mesh, meta) =>
    set({
      phase: 'ready',
      fileName,
      mesh,
      meta,
      edges: null,
      selected: null,
      preview: null,
      warnings: [],
      progress: null,
      error: null,
    }),

  setImported: (fileName, mesh, edges, meta, warnings) => {
    const selected = new Uint8Array(edges.count);
    for (let i = 0; i < edges.count; i++) {
      if (edges.flags[i] & EDGE_CANDIDATE) selected[i] = 1;
    }
    set({
      phase: 'ready',
      fileName,
      mesh,
      edges,
      meta,
      warnings,
      selected,
      preview: null,
      progress: null,
      error: null,
    });
  },

  fail: (message) => set({ phase: 'error', error: message, progress: null, preview: null }),

  toggleEdge: (id, on) => {
    const { selected } = get();
    if (!selected || id < 0 || id >= selected.length) return;
    const next = selected.slice();
    next[id] = on === undefined ? (next[id] ? 0 : 1) : on ? 1 : 0;
    set({ selected: next });
  },

  setSelection: (mask) => set({ selected: mask }),

  toggleEdges: (ids, on) => {
    const { selected } = get();
    if (!selected) return;
    const next = selected.slice();
    for (const id of ids) {
      if (id >= 0 && id < next.length) next[id] = on ? 1 : 0;
    }
    set({ selected: next });
  },

  selectCandidates: (on) => {
    const { edges, selected } = get();
    if (!edges || !selected) return;
    const next = selected.slice();
    for (let i = 0; i < edges.count; i++) {
      if (edges.flags[i] & EDGE_CANDIDATE) next[i] = on ? 1 : 0;
    }
    set({ selected: next });
  },
  selectSharp: (kind, on) => {
    const { edges, selected } = get();
    if (!edges || !selected) return;
    const mask = kind === 'outside' ? EDGE_CONVEX : kind === 'inside' ? EDGE_CONCAVE : EDGE_CONVEX | EDGE_CONCAVE;
    const next = selected.slice();
    for (let i = 0; i < edges.count; i++) {
      if (edges.flags[i] & mask && edges.dihedral[i] >= SHARP_DEG) next[i] = on ? 1 : 0;
    }
    set({ selected: next });
  },
  setBrush: (patch) =>
    set((s) => {
      const next = { ...s.brush, ...patch };
      next.radius = Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, Math.round(next.radius)));
      return { brush: next };
    }),
  clearSelection: () => {
    const { selected } = get();
    if (selected) set({ selected: new Uint8Array(selected.length) });
  },

  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
  setPreview: (preview) => set({ preview }),
  setShowPreview: (showPreview) => set({ showPreview }),
  setShowWireframe: (showWireframe) => set({ showWireframe }),
  setError: (error) => set({ error }),
  setBeveling: (on) =>
    set((state) => {
      if (on) return state.phase === 'importing' ? state : { phase: 'beveling' };
      return state.phase === 'beveling' ? { phase: 'ready' } : state;
    }),
  setProgress: (progress) => set({ progress }),
  reset: () =>
    set({
      phase: 'idle',
      fileName: null,
      mesh: null,
      edges: null,
      meta: null,
      warnings: [],
      selected: null,
      preview: null,
      showWireframe: false,
      progress: null,
      error: null,
    }),
}));

export function countSelected(selected: Uint8Array | null): number {
  if (!selected) return 0;
  let n = 0;
  for (let i = 0; i < selected.length; i++) n += selected[i];
  return n;
}
