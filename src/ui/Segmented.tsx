import { useRef } from 'react';
import type { CSSProperties } from 'react';

export type SegmentedProps = {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  size?: 'sm' | 'md';
};

/**
 * Single-select segmented control. The moving pill is a transform, so the
 * indicator glides without layout work; arrow keys / Home / End move selection.
 */
export function Segmented({ value, options, onChange, size = 'md' }: SegmentedProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const count = options.length;
  const found = options.findIndex((option) => option.value === value);
  const index = found < 0 ? 0 : found;
  const style = { '--seg-n': Math.max(1, count), '--seg-index': index } as CSSProperties;

  if (count === 0) return null;

  const move = (direction: 1 | -1, from: number) => {
    const next = (from + direction + count) % count;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div className={`bs-seg bs-seg--${size}`} style={style}>
      <span className="bs-seg__pill" aria-hidden="true" />
      {options.map((option, optionIndex) => (
        <button
          key={option.value}
          ref={(node) => {
            refs.current[optionIndex] = node;
          }}
          type="button"
          className="bs-seg__option"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault();
              move(1, optionIndex);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault();
              move(-1, optionIndex);
            } else if (event.key === 'Home') {
              event.preventDefault();
              onChange(options[0].value);
              refs.current[0]?.focus();
            } else if (event.key === 'End') {
              event.preventDefault();
              onChange(options[count - 1].value);
              refs.current[count - 1]?.focus();
            }
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
