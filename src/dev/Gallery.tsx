import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Button,
  Chip,
  Divider,
  IconButton,
  NumberField,
  Panel,
  Progress,
  Segmented,
  Slider,
  Toggle,
  Tooltip,
} from '../ui';
import {
  BoxIcon,
  BrushIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CursorIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FitIcon,
  LayersIcon,
  RedoIcon,
  RotateIcon,
  UndoIcon,
  WarningIcon,
} from '../ui/icons';
import './gallery.css';

type Backdrop = 'calm' | 'busy';

const TYPE_ROWS = [
  { token: '--text-xl', px: '20 px', use: 'Screen title', sample: 'Glass kit' },
  { token: '--text-lg', px: '16 px', use: 'Panel title', sample: 'Bevel settings' },
  { token: '--text-md', px: '14 px', use: 'Body', sample: 'Sharp edges are already marked.' },
  { token: '--text-sm', px: '12.5 px', use: 'Control label', sample: 'Width' },
  { token: '--text-xs', px: '11 px', use: 'Eyebrow · chip · hint', sample: 'WATERTIGHT' },
];

const SWATCHES = [
  { token: '--bg', value: '#0B0E10' },
  { token: '--bg-elev', value: '#12171A' },
  { token: '--viewport-top', value: '#171E22' },
  { token: '--fg', value: '#E8EDEF' },
  { token: '--fg-muted', value: '#8C9AA1' },
  { token: '--fg-subtle', value: '#5C6A71' },
  { token: '--accent', value: '#7DE2C3' },
  { token: '--accent-2', value: '#56C8FF' },
  { token: '--selection', value: '#FFB65C' },
  { token: '--danger', value: '#FF6B6B' },
  { token: '--warning', value: '#F5C26B' },
  { token: '--success', value: '#7DE2C3' },
  { token: '--info', value: '#8AB4F8' },
  { token: '--glass-bg', value: 'rgba(22,28,32,.55)' },
  { token: '--glass-border', value: 'rgba(255,255,255,.10)' },
];

const ICONS = [
  { name: 'cursor', node: <CursorIcon size={16} /> },
  { name: 'brush', node: <BrushIcon size={16} /> },
  { name: 'box', node: <BoxIcon size={16} /> },
  { name: 'download', node: <DownloadIcon size={16} /> },
  { name: 'undo', node: <UndoIcon size={16} /> },
  { name: 'redo', node: <RedoIcon size={16} /> },
  { name: 'close', node: <CloseIcon size={16} /> },
  { name: 'chevron-down', node: <ChevronDownIcon size={16} /> },
  { name: 'check', node: <CheckIcon size={16} /> },
  { name: 'warning', node: <WarningIcon size={16} /> },
  { name: 'eye', node: <EyeIcon size={16} /> },
  { name: 'eye-off', node: <EyeOffIcon size={16} /> },
  { name: 'fit', node: <FitIcon size={16} /> },
  { name: 'rotate', node: <RotateIcon size={16} /> },
  { name: 'layers', node: <LayersIcon size={16} /> },
  { name: 'file', node: <FileIcon size={16} /> },
];

function Demo({
  title,
  note,
  className,
  children,
}: {
  title: string;
  note?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Panel className={`g-demo${className ? ` ${className}` : ''}`}>
      <div className="g-demo__head">
        <h3 className="g-demo__title">{title}</h3>
        {note && <p className="g-demo__note">{note}</p>}
      </div>
      <div className="g-demo__body">{children}</div>
    </Panel>
  );
}

function SliderDemo() {
  const [width, setWidth] = useState(0.5);
  const [profile, setProfile] = useState(0.5);
  return (
    <Demo title="Slider" note="Native range input; accent fill, 14 px thumb, mono value pill.">
      <Slider
        label="Width"
        value={width}
        min={0.05}
        max={1.2}
        step={0.05}
        unit="mm"
        onChange={setWidth}
        hint="Clamped per edge: the safe maximum for this selection is 0.62 mm."
      />
      <Slider label="Profile" value={profile} min={0} max={1} step={0.05} onChange={setProfile} />
      <Slider
        label="Falloff"
        value={0.3}
        min={0}
        max={1}
        step={0.05}
        onChange={() => undefined}
        disabled
        hint="Disabled while the mesh is rebuilding."
      />
    </Demo>
  );
}

function NumberDemo() {
  const [width, setWidth] = useState(0.62);
  const [segments, setSegments] = useState(4);
  return (
    <Demo title="Number field" note="Drag the label to scrub. Blur clamps, focus selects, arrows step.">
      <NumberField
        label="Width"
        value={width}
        min={0.05}
        max={1.2}
        step={0.05}
        unit="mm"
        onChange={setWidth}
      />
      <NumberField
        label="Segments"
        value={segments}
        min={1}
        max={12}
        step={1}
        onChange={setSegments}
      />
    </Demo>
  );
}

function SegmentedDemo() {
  const [segments, setSegments] = useState('4');
  const [shading, setShading] = useState('smooth');
  return (
    <Demo title="Segmented" note="Sliding pill on transform; arrow keys move the selection.">
      <Segmented
        value={segments}
        options={[
          { value: '1', label: '1' },
          { value: '2', label: '2' },
          { value: '3', label: '3' },
          { value: '4', label: '4' },
          { value: '6', label: '6' },
          { value: '8', label: '8' },
        ]}
        onChange={setSegments}
      />
      <Segmented
        value={shading}
        options={[
          { value: 'smooth', label: 'Smooth' },
          { value: 'faceted', label: 'Faceted' },
          { value: 'wire', label: 'Wire' },
        ]}
        onChange={setShading}
        size="sm"
      />
    </Demo>
  );
}

function IconDemo() {
  const [tool, setTool] = useState('select');
  return (
    <Demo title="Icon buttons" note="The label is both the accessible name and the tooltip.">
      <div className="g-row">
        <IconButton
          label="Select tool"
          icon={<CursorIcon />}
          variant="primary"
          active={tool === 'select'}
          onClick={() => setTool('select')}
        />
        <IconButton
          label="Paint tool"
          icon={<BrushIcon />}
          variant="secondary"
          active={tool === 'paint'}
          onClick={() => setTool('paint')}
        />
        <IconButton
          label="Inspect tool"
          icon={<BoxIcon />}
          active={tool === 'inspect'}
          onClick={() => setTool('inspect')}
        />
        <IconButton label="Fit view" icon={<FitIcon />} />
        <IconButton label="Exclude edges" icon={<CloseIcon />} variant="danger" />
        <IconButton label="Unavailable" icon={<LayersIcon />} disabled />
      </div>
      <div className="g-row">
        <IconButton label="Undo" icon={<UndoIcon />} />
        <IconButton label="Redo" icon={<RedoIcon />} disabled />
        <IconButton label="Show mesh" icon={<EyeIcon />} />
        <IconButton label="Hide mesh" icon={<EyeOffIcon />} />
        <IconButton label="Rotate view" icon={<RotateIcon />} />
      </div>
    </Demo>
  );
}

function ToggleDemo() {
  const [mesh, setMesh] = useState(true);
  const [ghost, setGhost] = useState(false);
  return (
    <Demo title="Toggle" note="role=switch, spring thumb, 36×20 track with a 32 px hit area.">
      <Toggle
        label="Mesh overlay"
        description="Draw edges on the beveled result."
        checked={mesh}
        onChange={setMesh}
      />
      <Toggle label="Ghost original" checked={ghost} onChange={setGhost} />
    </Demo>
  );
}

function InspectorDemo() {
  const [width, setWidth] = useState(0.5);
  const [segments, setSegments] = useState('4');
  const [profile, setProfile] = useState(0.5);
  const [mesh, setMesh] = useState(true);

  return (
    <div className="g-inspector">
      <Panel padding="md" className="g-inspector__panel">
        <div className="g-panel-head">
          <span className="bs-eyebrow">Bevel</span>
          <span className="g-panel-head__meta">2 edges limited</span>
        </div>

        <Slider
          label="Width"
          value={width}
          min={0.05}
          max={1.2}
          step={0.05}
          unit="mm"
          onChange={setWidth}
        />

        <div className="g-field">
          <div className="g-field__head">
            <span className="bs-field__label">Segments</span>
            <span className="bs-value">{segments}</span>
          </div>
          <Segmented
            value={segments}
            options={[
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
              { value: '4', label: '4' },
              { value: '6', label: '6' },
              { value: '8', label: '8' },
            ]}
            onChange={setSegments}
            size="sm"
          />
        </div>

        <Slider
          label="Profile"
          value={profile}
          min={0}
          max={1}
          step={0.05}
          onChange={setProfile}
        />

        <Chip tone="warning" icon={<WarningIcon size={12} />}>
          Width limited to 0.50 mm — 2 edges are narrower.
        </Chip>

        <Divider />

        <div className="g-panel-head">
          <span className="bs-eyebrow">Mesh</span>
          <Chip tone="success" icon={<CheckIcon size={12} />}>
            Watertight
          </Chip>
        </div>

        <Toggle
          label="Mesh overlay"
          description="Edges follow the beveled topology."
          checked={mesh}
          onChange={setMesh}
        />

        <div className="g-stats">
          <div className="g-stat">
            <span>Triangles</span>
            <span>654</span>
          </div>
          <div className="g-stat">
            <span>Volume</span>
            <span>12 788 mm³</span>
          </div>
        </div>

        <Progress value={0.62} label="Rebuilding preview" />

        <Button variant="primary" icon={<DownloadIcon size={15} />}>
          Export STL
        </Button>
      </Panel>
    </div>
  );
}

export function Gallery() {
  const [backdrop, setBackdrop] = useState<Backdrop>('calm');

  return (
    <div className={`gallery${backdrop === 'busy' ? ' gallery--busy' : ''}`}>
      <div className="gallery__inner">
        <header className="g-head">
          <div className="g-head__text">
            <div className="g-kicker">
              <span className="g-dot" aria-hidden="true" />
              Bevel Studio · M5 design system
            </div>
            <h1>Glass kit</h1>
            <p>
              Review surface for the shared controls. Hover and Tab through everything; the
              inspector on the dark stage is the composition to judge.
            </p>
          </div>
          <div className="g-toolbar">
            <span className="g-toolbar__label">Backdrop</span>
            <Segmented
              size="sm"
              value={backdrop}
              options={[
                { value: 'calm', label: 'Calm' },
                { value: 'busy', label: 'Busy' },
              ]}
              onChange={(next) => setBackdrop(next as Backdrop)}
            />
          </div>
        </header>

        <section className="g-section" aria-labelledby="g-composed">
          <div className="g-section__head">
            <h2 id="g-composed">Composed inspector</h2>
            <p>
              320 px glass column over the workspace gradient. Toggle the backdrop to judge the
              blur against a calm field and a busy one.
            </p>
          </div>

          <div className={`g-stage g-stage--${backdrop}`}>
            <div className="g-stage__grid" aria-hidden="true" />

            <div className="g-orb g-orb--teal" aria-hidden="true" />
            <div className="g-orb g-orb--blue" aria-hidden="true" />
            <div className="g-orb g-orb--amber" aria-hidden="true" />

            <svg className="g-model" viewBox="0 0 300 300" aria-hidden="true">
              <ellipse className="g-model__shadow" cx="150" cy="246" rx="82" ry="14" />
              <polygon
                className="g-model__face g-model__face--top"
                points="150,70 230,110 150,150 70,110"
              />
              <polygon
                className="g-model__face g-model__face--left"
                points="70,110 150,150 150,230 70,190"
              />
              <polygon
                className="g-model__face g-model__face--right"
                points="150,150 230,110 230,190 150,230"
              />
              <g className="g-model__wire">
                <path d="M150 70 230 110 150 150 70 110Z" />
                <path d="M70 110v80M150 150v80M230 110v80" />
                <path d="M70 190 150 230 230 190" />
              </g>
              <g className="g-model__sel">
                <path className="g-model__glow" d="M70 110 150 70 230 110" />
                <path d="M70 110 150 70 230 110" />
                <path d="M70 110v80M230 110v80" />
              </g>
            </svg>

            <Panel padding="none" className="g-capsule">
              <span className="g-capsule__dot" aria-hidden="true" />
              <span className="g-capsule__name">Desk_Hook_v3.stl</span>
              <span className="g-capsule__sep" aria-hidden="true" />
              <span className="g-capsule__meta">140 tri</span>
              <Chip>mm</Chip>
              <span className="g-capsule__sep" aria-hidden="true" />
              <IconButton label="Undo" icon={<UndoIcon size={15} />} />
              <IconButton label="Redo" icon={<RedoIcon size={15} />} disabled />
              <IconButton label="Fit view" icon={<FitIcon size={15} />} />
            </Panel>

            <InspectorDemo />

            <div className="g-stage__chips">
              <Chip icon={<LayersIcon size={12} />}>14 edges · 2 chains</Chip>
              <Chip tone="accent">0.50 mm × 4</Chip>
              <Chip tone="warning" icon={<WarningIcon size={12} />}>
                2 excluded
              </Chip>
            </div>
          </div>
        </section>

        <section className="g-section" aria-labelledby="g-type">
          <div className="g-section__head">
            <h2 id="g-type">Type scale</h2>
            <p>Five sizes. Every number is mono with tabular figures.</p>
          </div>
          <Panel padding="sm">
            <div className="g-type">
              {TYPE_ROWS.map((row) => (
                <div className="g-type__row" key={row.token}>
                  <span className="g-type__meta">
                    {row.px} · {row.token}
                  </span>
                  <span className="g-type__sample" style={{ fontSize: `var(${row.token})` }}>
                    {row.sample}
                  </span>
                  <span className="g-type__num">
                    {row.use} · 12 788 mm³
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </section>

        <section className="g-section" aria-labelledby="g-colour">
          <div className="g-section__head">
            <h2 id="g-colour">Colour</h2>
            <p>Tokens only. Translucent swatches sit on the same gradient the glass sees.</p>
          </div>
          <Panel padding="sm">
            <div className="g-swatches">
              {SWATCHES.map((swatch) => (
                <div className="g-swatch" key={swatch.token}>
                  <span
                    className="g-swatch__chip"
                    style={{ '--swatch': `var(${swatch.token})` } as CSSProperties}
                  />
                  <span className="g-swatch__name">{swatch.token}</span>
                  <span className="g-swatch__value">{swatch.value}</span>
                </div>
              ))}
            </div>
          </Panel>
        </section>

        <section className="g-section" aria-labelledby="g-controls">
          <div className="g-section__head">
            <h2 id="g-controls">Controls</h2>
            <p>Default, hover and focus are live. Disabled and loading states are shown below.</p>
          </div>

          <div className="g-grid">
            <Demo
              title="Buttons"
              note="One primary per surface. Danger is tinted, not solid."
              className="g-span-2"
            >
              <div className="g-row">
                <Button variant="primary" icon={<DownloadIcon size={15} />}>
                  Export STL
                </Button>
                <Button variant="secondary">Choose file</Button>
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger">Exclude 3 edges</Button>
              </div>
              <div className="g-row">
                <Button size="sm" variant="primary" icon={<DownloadIcon size={14} />}>
                  Export
                </Button>
                <Button size="sm" variant="secondary">
                  Save copy
                </Button>
                <Button size="sm" variant="ghost">
                  Reset
                </Button>
                <Button size="sm" variant="danger">
                  Remove
                </Button>
              </div>
              <div className="g-row">
                <Button disabled>Disabled</Button>
                <Button variant="primary" disabled>
                  Disabled
                </Button>
                <Button loading>Saving…</Button>
                <Button variant="primary" loading>
                  Beveling…
                </Button>
              </div>
            </Demo>

            <IconDemo />
            <SliderDemo />
            <NumberDemo />
            <SegmentedDemo />
            <ToggleDemo />

            <Demo title="Chips" note="Status tones with a matching icon; long chips wrap.">
              <div className="g-row">
                <Chip icon={<BoxIcon size={12} />}>140 tri</Chip>
                <Chip tone="accent">0.50 mm × 4</Chip>
                <Chip tone="warning" icon={<WarningIcon size={12} />}>
                  Width limited
                </Chip>
                <Chip tone="danger" icon={<CloseIcon size={12} />}>
                  3 excluded
                </Chip>
                <Chip tone="success" icon={<CheckIcon size={12} />}>
                  Watertight
                </Chip>
              </div>
              <div className="g-row">
                <Chip tone="warning">
                  Width limited to 0.31 mm — six edges are narrower.
                </Chip>
              </div>
            </Demo>

            <Demo title="Progress" note="Determinate, 0..1; the label is the accessible name.">
              <Progress value={0.34} label="Warming up" />
              <Progress value={0.72} label="Rebuilding preview" />
              <Progress value={1} label="Export ready" />
              <Progress value={0.5} />
            </Demo>

            <Demo title="Tooltip" note="400 ms delay, portal-positioned, flips at the viewport edge.">
              <div className="g-row">
                <Tooltip content="Above the control" side="top">
                  <Button size="sm">Top</Button>
                </Tooltip>
                <Tooltip content="Below the control" side="bottom">
                  <Button size="sm">Bottom</Button>
                </Tooltip>
                <Tooltip content="To the left" side="left">
                  <Button size="sm">Left</Button>
                </Tooltip>
                <Tooltip content="To the right" side="right">
                  <Button size="sm">Right</Button>
                </Tooltip>
              </div>
              <div className="g-row">
                <Tooltip content="Values are model units; nothing is rescaled on import or export.">
                  <Button size="sm" variant="ghost" icon={<FileIcon size={14} />}>
                    Units
                  </Button>
                </Tooltip>
              </div>
            </Demo>

            <Demo title="Panel & divider" note="One glass primitive, three paddings.">
              <div className="g-padgrid">
                <Panel padding="none" className="g-padbox">
                  none
                </Panel>
                <Panel padding="sm" className="g-padbox">
                  sm
                </Panel>
                <Panel padding="md" className="g-padbox">
                  md
                </Panel>
              </div>
              <Divider />
              <div className="g-row">
                <Chip tone="accent">0.50 mm × 4</Chip>
                <Chip>654 tri</Chip>
              </div>
            </Demo>

            <Demo
              title="Failure state"
              note="Composed from the kit; every message offers the next step."
              className="g-span-2"
            >
              <div className="g-error">
                <span className="g-error__icon" aria-hidden="true">
                  <WarningIcon size={18} />
                </span>
                <div>
                  <div className="g-error__title">
                    The bevel on 3 edges would cut through the part.
                  </div>
                  <p className="g-error__body">
                    Exclude them and try again? The other 11 edges in the selection are
                    untouched, and the mesh stays watertight.
                  </p>
                  <div className="g-error__actions">
                    <Button size="sm" variant="danger">
                      Exclude 3 edges
                    </Button>
                    <Button size="sm" variant="ghost">
                      Show them
                    </Button>
                  </div>
                </div>
              </div>
            </Demo>

            <Demo title="Icons" note="16 glyphs, 20×20 view box, 1.6 px stroke." className="g-span-2">
              <div className="g-icons">
                {ICONS.map((icon) => (
                  <span className="g-icon" key={icon.name}>
                    {icon.node}
                    <span>{icon.name}</span>
                  </span>
                ))}
              </div>
            </Demo>
          </div>
        </section>

        <footer className="g-foot">
          <span className="g-kicker">
            <span className="g-dot" aria-hidden="true" />
            Glass kit · 11 components · 16 icons
          </span>
          <span>Hover for tooltips · Tab for focus rings · reduced motion respected</span>
        </footer>
      </div>
    </div>
  );
}
