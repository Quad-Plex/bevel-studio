import { Chip } from '../ui';
import { countSelected, useApp } from '../state/store';
import { EDGE_CANDIDATE } from '../engine/types';

/** Bottom-left selection summary; the quiet place for counts and hints. */
export function StatusBar() {
  const edges = useApp((state) => state.edges);
  const selected = useApp((state) => state.selected);
  const params = useApp((state) => state.params);
  const preview = useApp((state) => state.preview);

  if (!edges || !selected) return null;

  let candidates = 0;
  for (let i = 0; i < edges.count; i++) {
    if (edges.flags[i] & EDGE_CANDIDATE) candidates++;
  }

  const count = countSelected(selected);

  return (
    <div className="statusbar">
      <Chip tone="neutral">
        {count} of {candidates} candidates
      </Chip>
      <Chip tone="neutral">
        {params.width.toFixed(2)} mm × {params.segments}
      </Chip>
      {preview && preview.clampedEdges > 0 && (
        <Chip tone="warning">{preview.clampedEdges} limited</Chip>
      )}
    </div>
  );
}
