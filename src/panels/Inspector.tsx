import { Button, Chip, Divider, Panel, Segmented, Slider, Toggle } from '../ui';
import { BRUSH_MAX, BRUSH_MIN, countSelected, useApp } from '../state/store';
import { exportModel } from '../state/export';

/**
 * Right-hand inspector. Every control writes straight to the store; the live
 * preview hook watches the store, so no control needs its own apply button.
 */
export function Inspector() {
  const meta = useApp((state) => state.meta);
  const preview = useApp((state) => state.preview);
  const params = useApp((state) => state.params);
  const setParams = useApp((state) => state.setParams);
  const selected = useApp((state) => state.selected);
  const phase = useApp((state) => state.phase);
  const showPreview = useApp((state) => state.showPreview);
  const setShowPreview = useApp((state) => state.setShowPreview);
  const showWireframe = useApp((state) => state.showWireframe);
  const setShowWireframe = useApp((state) => state.setShowWireframe);
  const brush = useApp((state) => state.brush);
  const setBrush = useApp((state) => state.setBrush);
  const selectSharp = useApp((state) => state.selectSharp);
  const clearSelection = useApp((state) => state.clearSelection);

  if (!meta) return null;

  const count = countSelected(selected);
  const shown = (showPreview && preview?.meta) || meta;
  const clamped = showPreview ? preview?.clampedEdges ?? 0 : 0;
  const blocking = preview?.warnings.filter((warning) => warning.severity === 'error') ?? [];
  const crossings = preview?.selfIntersections ?? 0;
  const busy = phase === 'beveling';

  return (
    <Panel className="inspector" padding="md">
      <header className="inspector-head">
        <div>
          <p className="eyebrow">Bevel</p>
          <h2 className="inspector-title">
            {count === 0
              ? 'No edges selected'
              : `${count} edge${count === 1 ? '' : 's'} selected`}
          </h2>
        </div>
        <Chip tone={count > 0 ? 'accent' : 'neutral'}>{count > 0 ? 'Live' : 'Idle'}</Chip>
      </header>

      <Divider />

      <div className="field">
        <span className="field-label">Brush picks</span>
        <Segmented
          value={brush.filter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'outside', label: 'Outside' },
            { value: 'inside', label: 'Inside' },
          ]}
          onChange={(filter) => setBrush({ filter: filter as typeof brush.filter })}
        />
      </div>

      <Slider
        label="Brush size"
        value={brush.radius}
        min={BRUSH_MIN}
        max={BRUSH_MAX}
        step={1}
        unit="px"
        onChange={(radius) => setBrush({ radius })}
        hint="[ and ] resize it in the viewport."
      />

      <div className="inspector-actions">
        <Button size="sm" onClick={() => selectSharp('outside', true)}>
          All outside
        </Button>
        <Button size="sm" onClick={() => selectSharp('inside', true)}>
          All inside
        </Button>
        <Button size="sm" variant="ghost" onClick={clearSelection} disabled={count === 0}>
          Clear
        </Button>
      </div>

      <Divider />

      <Slider
        label="Width"
        value={params.width}
        min={0.05}
        max={3}
        step={0.05}
        unit="mm"
        onChange={(width) => setParams({ width })}
        disabled={count === 0}
      />

      <div className="field">
        <span className="field-label">Segments</span>
        <Segmented
          value={String(params.segments)}
          options={[1, 2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(value) => setParams({ segments: Number(value) })}
        />
      </div>

      <Slider
        label="Profile"
        value={params.profile}
        min={0}
        max={1}
        step={0.05}
        onChange={(profile) => setParams({ profile })}
        disabled={count === 0 || params.segments === 1}
        hint="0.5 is a circular fillet; lower is flatter."
      />

      <Divider />

      <Toggle
        label="Clamp overlap"
        checked={params.clampOverlap}
        onChange={(clampOverlap) => setParams({ clampOverlap })}
        description="Keep each bevel within the room the walls and gaps around it allow."
      />
      <Toggle
        label="Smooth shading"
        checked={params.smoothing === 'creased'}
        onChange={(on) => setParams({ smoothing: on ? 'creased' : 'flat' })}
        description="Creased at 30°, so flat faces stay flat."
      />
      <Toggle
        label="Wireframe"
        checked={showWireframe}
        onChange={setShowWireframe}
        description="Show triangle edges over the shaded model (W)."
      />
      <Toggle
        label="Show result"
        checked={showPreview}
        onChange={setShowPreview}
        description="Hide to edit edges on the original surface."
      />

      {clamped > 0 && (
        <Chip tone="warning">
          Width limited on {clamped} edge{clamped === 1 ? '' : 's'}
        </Chip>
      )}

      {blocking.map((warning) => (
        <Chip key={warning.code} tone="danger">
          {warning.message}
        </Chip>
      ))}

      <Divider />

      <dl className="stats">
        <div>
          <dt>Triangles</dt>
          <dd>{shown.triangles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Volume</dt>
          <dd>
            {shown.volume.toFixed(1)} <span>mm³</span>
          </dd>
        </div>
        <div>
          <dt>Mesh</dt>
          <dd>{shown.watertight ? 'Watertight' : 'Open'}</dd>
        </div>
      </dl>

      <Button
        variant="primary"
        icon={<span aria-hidden="true">↓</span>}
        onClick={() => void exportModel()}
        disabled={count === 0 || !shown.watertight || crossings > 0}
        loading={busy}
      >
        Export STL
      </Button>
      {(!shown.watertight || crossings > 0) && (
        <p className="inspector-note">
          {crossings > 0
            ? 'Export is disabled: deselect the tight corner edges.'
            : 'Export is disabled while the result is not watertight.'}
        </p>
      )}
    </Panel>
  );
}
