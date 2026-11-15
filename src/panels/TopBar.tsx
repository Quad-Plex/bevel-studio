import { Chip, IconButton } from '../ui';
import { FitIcon } from '../ui/icons';
import { useApp } from '../state/store';
import { getActiveViewport } from '../viewport/registry';

/** Floating document capsule: what is open, how big it is, and how to refit. */
export function TopBar() {
  const fileName = useApp((state) => state.fileName);
  const meta = useApp((state) => state.meta);

  if (!meta) return null;

  return (
    <div className="topbar">
      <span className="topbar-file">{fileName ?? 'Untitled'}</span>
      <Chip tone="neutral">{meta.triangles.toLocaleString()} tri</Chip>
      <Chip tone={meta.watertight ? 'success' : 'warning'}>
        {meta.watertight ? 'Watertight' : 'Open mesh'}
      </Chip>
      <span className="topbar-sep" aria-hidden="true" />
      <IconButton
        label="Fit view (F)"
        icon={<FitIcon />}
        onClick={() => getActiveViewport()?.frame()}
      />
    </div>
  );
}
