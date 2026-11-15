import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type TooltipProps = {
  content: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
};

type Side = 'top' | 'bottom' | 'left' | 'right';
type Coords = { top: number; left: number; side: Side };

const GAP = 8;
const VIEWPORT_PAD = 8;
const DELAY = 400;
const OPPOSITE: Record<Side, Side> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/**
 * Glass tooltip in a portal. Opens on hover and keyboard focus after 400 ms,
 * measures itself and flips away from the viewport edge, so it is never clipped
 * by a scrolling panel or an overflow-hidden stage.
 */
export function Tooltip({ content, side = 'top', children }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [coords, setCoords] = useState<Coords>({ top: 0, left: 0, side });

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setReady(false);
      setOpen(true);
    }, DELAY);
  }, [clearTimer]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
    setReady(false);
  }, [clearTimer]);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;

    const rect = anchor.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const room: Record<Side, number> = {
      top: rect.top - GAP,
      bottom: vh - rect.bottom - GAP,
      left: rect.left - GAP,
      right: vw - rect.right - GAP,
    };
    const fits = (s: Side) =>
      s === 'top' || s === 'bottom' ? room[s] >= tipRect.height : room[s] >= tipRect.width;

    let actual = side;
    if (!fits(actual) && fits(OPPOSITE[actual])) actual = OPPOSITE[actual];

    let top = 0;
    let left = 0;
    switch (actual) {
      case 'top':
        top = rect.top - tipRect.height - GAP;
        left = rect.left + rect.width / 2 - tipRect.width / 2;
        break;
      case 'bottom':
        top = rect.bottom + GAP;
        left = rect.left + rect.width / 2 - tipRect.width / 2;
        break;
      case 'left':
        top = rect.top + rect.height / 2 - tipRect.height / 2;
        left = rect.left - tipRect.width - GAP;
        break;
      case 'right':
        top = rect.top + rect.height / 2 - tipRect.height / 2;
        left = rect.right + GAP;
        break;
    }

    top = Math.min(Math.max(VIEWPORT_PAD, top), vh - tipRect.height - VIEWPORT_PAD);
    left = Math.min(Math.max(VIEWPORT_PAD, left), vw - tipRect.width - VIEWPORT_PAD);

    setCoords({ top: Math.round(top), left: Math.round(left), side: actual });
  }, [side]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    setReady(true);
  }, [open, place, content]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => place();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, place, hide]);

  useEffect(() => clearTimer, [clearTimer]);

  return (
    <span
      ref={anchorRef}
      className="bs-tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            className="bs-tooltip"
            role="tooltip"
            data-side={coords.side}
            style={{
              top: coords.top,
              left: coords.left,
              visibility: ready ? 'visible' : 'hidden',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
