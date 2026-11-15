import { useApp } from '../state/store';

interface Hint {
  keys: string[];
  label: string;
}

const HINTS: Hint[] = [
  { keys: ['LMB'], label: 'Add edge' },
  { keys: ['RMB'], label: 'Remove' },
  { keys: ['MMB'], label: 'Pan' },
  { keys: ['Wheel'], label: 'Zoom' },
  { keys: ['A'], label: 'Select all' },
  { keys: ['F'], label: 'Fit' },
  { keys: ['Ctrl', 'Z'], label: 'Undo' },
];

/**
 * Permanent control legend. Kept on screen (not a transient toast) because the
 * left/right button split is the one interaction nobody guesses.
 */
export function HintBar() {
  const meta = useApp((state) => state.meta);
  if (!meta) return null;

  return (
    <div className="hintbar" role="note" aria-label="Mouse and keyboard controls">
      {HINTS.map((hint) => (
        <span key={hint.label} className="hint">
          <span className="hint-keys">
            {hint.keys.map((key) => (
              <kbd key={key}>{key}</kbd>
            ))}
          </span>
          <span className="hint-label">{hint.label}</span>
        </span>
      ))}
    </div>
  );
}
