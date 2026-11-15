/** Internal numeric helpers shared by Slider and NumberField. Not part of the kit API. */

export function clamp(value: number, min?: number, max?: number): number {
  const lo = min ?? Number.NEGATIVE_INFINITY;
  const hi = max ?? Number.POSITIVE_INFINITY;
  return Math.min(hi, Math.max(lo, value));
}

/** Decimals implied by a step value: 1 → 0, 0.05 → 2, 0.001 → 3. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const exponent = text.match(/e-(\d+)$/);
  if (exponent) return Math.min(6, Number(exponent[1]));
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(6, text.length - dot - 1);
}

/** Snap to a step grid anchored at `origin`, avoiding 0.30000000000000004. */
export function snapToStep(value: number, step: number, origin = 0): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  const snapped = origin + Math.round((value - origin) / step) * step;
  return Number(snapped.toFixed(Math.min(6, decimalsOf(step))));
}

/**
 * Display formatting for a control value. Uses the step's precision (so a
 * 0.05 mm control reads 0.50) and never hides typed decimals in a field with
 * an integer step.
 */
export function formatValue(value: number, step: number): string {
  if (!Number.isFinite(value)) return '—';
  const fraction = Math.abs(value % 1);
  const decimals = Math.min(4, Math.max(decimalsOf(step), decimalsOf(fraction)));
  return value.toFixed(decimals);
}
