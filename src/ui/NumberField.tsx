import { useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clamp, formatValue, snapToStep } from './format';

export type NumberFieldProps = {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
};

/**
 * Numeric field with a unit suffix. The label is a drag handle (pointer capture,
 * 4 px per step, 10 px on touch); blur clamps, focus selects, arrows step.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const scrub = useRef<{ startX: number; startValue: number } | null>(null);
  const lastEmitted = useRef(value);
  const cancelNext = useRef(false);
  const dragged = useRef(false);

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(parsed)) {
      const next = clamp(parsed, min, max);
      lastEmitted.current = next;
      onChange(next);
    }
    setDraft(null);
  };

  const endScrub = (event: ReactPointerEvent<HTMLLabelElement>) => {
    if (!scrub.current) return;
    scrub.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    delete event.currentTarget.dataset.scrubbing;
  };

  return (
    <div className="bs-field bs-number">
      <div className="bs-field__head">
        <label
          className="bs-field__label bs-number__label"
          htmlFor={id}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.dataset.scrubbing = 'true';
            scrub.current = { startX: event.clientX, startValue: value };
            lastEmitted.current = value;
            dragged.current = false;
          }}
          onPointerMove={(event) => {
            const state = scrub.current;
            if (!state) return;
            const perStep = event.pointerType === 'touch' ? 10 : 4;
            const steps = Math.round((event.clientX - state.startX) / perStep);
            const snapped = snapToStep(state.startValue + steps * step, step, min ?? 0);
            const next = clamp(snapped, min, max);
            if (!Number.isFinite(next) || next === lastEmitted.current) return;
            lastEmitted.current = next;
            dragged.current = true;
            onChange(next);
          }}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onLostPointerCapture={() => {
            scrub.current = null;
          }}
          onClick={(event) => {
            if (dragged.current) {
              event.preventDefault();
              dragged.current = false;
            }
          }}
        >
          {label}
        </label>
      </div>

      <div className={`bs-number__field${unit ? ' has-unit' : ''}`}>
        <input
          id={id}
          className="bs-number__input"
          type="number"
          inputMode="decimal"
          value={draft ?? formatValue(value, step)}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            setDraft(raw);
            if (raw.trim() === '') return;
            const parsed = Number(raw);
            if (!Number.isFinite(parsed)) return;
            const next = clamp(parsed, min, max);
            lastEmitted.current = next;
            onChange(next);
          }}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => {
            if (cancelNext.current) {
              cancelNext.current = false;
              setDraft(null);
              return;
            }
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              cancelNext.current = true;
              event.currentTarget.blur();
            }
          }}
        />
        {unit && (
          <span className="bs-number__unit" aria-hidden="true">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}
