import { clamp } from './format';

export type ProgressProps = {
  value: number;
  label?: string;
};

/** Determinate progress, 0..1. Always exposes a labelled progressbar. */
export function Progress({ value, label }: ProgressProps) {
  const ratio = clamp(value, 0, 1);
  const percent = Math.round(ratio * 100);

  return (
    <div className={`bs-progress${label ? ' has-label' : ''}`}>
      {label && (
        <div className="bs-progress__head">
          <span className="bs-progress__label">{label}</span>
          <span className="bs-progress__percent bs-num">{percent}%</span>
        </div>
      )}
      <div
        className="bs-progress__track"
        role="progressbar"
        aria-label={label ?? 'Progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className="bs-progress__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
