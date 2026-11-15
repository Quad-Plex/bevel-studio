import { getEngine } from './engine';
import { useApp } from './store';

/**
 * Export the current bevel as a binary STL, preserving millimetres and origin.
 * Refuses to write a mesh the engine already knows is not watertight, and
 * reports failures instead of leaving an unhandled rejection.
 */
export async function exportModel(): Promise<void> {
  const state = useApp.getState();
  const { edges, selected, params, preview, meta, phase } = state;
  if (!edges || !selected || phase === 'importing') return;

  const ids: number[] = [];
  for (let i = 0; i < selected.length; i++) if (selected[i]) ids.push(i);
  if (ids.length === 0) return;

  const current = preview?.meta ?? meta;
  if (current && !current.watertight) {
    state.setError('The current result is not watertight. Adjust the bevel before exporting.');
    return;
  }
  if ((preview?.selfIntersections ?? 0) > 0) {
    state.setError(
      `The result has ${preview?.selfIntersections} self-intersecting triangle pairs. Deselect the tight corner edges before exporting.`,
    );
    return;
  }

  state.setBeveling(true);
  state.setError(null);
  try {
    const { bytes, name } = await getEngine().exportStl(Uint32Array.from(ids), params);
    const blob = new Blob([bytes], { type: 'model/stl' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (error) {
    state.setError(
      error instanceof Error ? `Export failed: ${error.message}` : 'Export failed.',
    );
  } finally {
    state.setBeveling(false);
  }
}
