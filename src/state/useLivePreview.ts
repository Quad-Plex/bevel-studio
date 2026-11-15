import { useEffect, useRef } from 'react';
import { SupersededError } from '../engine/client';
import type { EdgeTable } from '../engine/types';
import { getEngine } from './engine';
import { useApp } from './store';

/**
 * Latest-wins live preview.
 *
 * - The first effect after an import is suppressed: the base mesh stays visible
 *   until the user changes a parameter or refines the selection.
 * - Every later selection/parameter change schedules one job; the client
 *   coalesces bursts and drops superseded requests.
 * - Kernel or worker failures surface in the store instead of being swallowed.
 */
export function useLivePreview(): void {
  const edges = useApp((state) => state.edges);
  const selected = useApp((state) => state.selected);
  const params = useApp((state) => state.params);

  const lastEdges = useRef<EdgeTable | null>(null);
  const suppress = useRef(true);

  useEffect(() => {
    if (edges !== lastEdges.current) {
      lastEdges.current = edges;
      suppress.current = true;
    }
    if (!edges || !selected) return;

    const state = useApp.getState();
    if (suppress.current) {
      suppress.current = false;
      return;
    }

    const ids: number[] = [];
    for (let i = 0; i < selected.length; i++) if (selected[i]) ids.push(i);

    if (ids.length === 0) {
      state.setPreview(null);
      state.setBeveling(false);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(() => {
      state.setBeveling(true);
      state.setError(null);
      getEngine()
        .preview(Uint32Array.from(ids), params)
        .then(({ result, mesh, bevelFaces }) => {
          if (cancelled) return;
          state.setPreview({
            mesh,
            meta: result.meta,
            clampedEdges: result.clampedEdges,
            stale: false,
            warnings: result.warnings,
            selfIntersections: result.selfIntersections ?? 0,
            bevelFaces,
          });
        })
        .catch((error: unknown) => {
          if (cancelled || error instanceof SupersededError) return;
          state.setPreview(null);
          state.setError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!cancelled) state.setBeveling(false);
        });
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [edges, selected, params]);
}
