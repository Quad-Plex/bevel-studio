import { useId } from 'react';
import type { CSSProperties } from 'react';
import { clamp, formatValue } from './format';

export type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
  hint?: string;
};

/**
 * Native range input under a custom skin: keyboard and screen-reader behaviour
 * come from the platform, the filled track and 14 px thumb are ours.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  disabled = false,
  hint,
}: SliderProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const range = max - min;
  const pct = range > 0 ? clamp(((value - min) / range) * 100, 0, 100) : 0;
  const style = { '--_fill': `${pct.toFixed(3)}%` } as CSSProperties;
  const display = `${formatValue(value, step)}${unit ? ` ${unit}` : ''}`;

  return (
    <div className={`bs-field bs-slider${disabled ? ' is-disabled' : ''}`}>
      <div className="bs-field__head">
        <label className="bs-field__label" htmlFor={id}>
          {label}
        </label>
        <span className="bs-value" aria-hidden="true">
          {formatValue(value, step)}
          {unit && <span className="bs-value__unit">{unit}</span>}
        </span>
      </div>

      <input
        id={id}
        className="bs-slider__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={style}
        aria-valuetext={display}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />

      {hint && (
        <p className="bs-field__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}
