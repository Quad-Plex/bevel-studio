/**
 * Reads a design token from `:root` so canvas materials share the CSS palette.
 * Canvas colours cannot use `var()`, so this is the one bridge between the two.
 */
export function readColorToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}
