import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useApp } from '../state/store';
import { getActiveViewport } from './registry';
import { EdgePicker } from './picking';
import { candidateEdges, edgesAlongStroke } from './strokePick';

const HISTORY_LIMIT = 40;
/** How close (in pixels) a stroke must pass to an edge to count as a hit. */
const STROKE_THRESHOLD_PX = 10;

/**
 * Click / drag edge selection.
 *
 * A drag is a swept stroke in screen space: every candidate edge whose projected
 * segment comes within 10 px of the pointer path is added (left button) or
 * removed (right button), so fast drags do not skip edges. A depth band rejects
 * edges on the far side of the part that project onto the same pixels.
 */
export function useEdgeSelection(stageRef: React.RefObject<HTMLDivElement | null>) {
  const picker = useRef<EdgePicker | null>(null);
  const candidates = useRef<Uint32Array>(new Uint32Array(0));
  const hits = useRef<number[]>([]);
  const paint = useRef<{
    value: 0 | 1;
    pointerId: number;
    lastX: number;
    lastY: number;
    lastDepth: number;
    radius: number;
  } | null>(null);
  const history = useRef<Uint8Array[]>([]);
  const future = useRef<Uint8Array[]>([]);

  const edges = useApp((state) => state.edges);

  useEffect(() => {
    if (!edges) {
      picker.current = null;
      candidates.current = new Uint32Array(0);
      return;
    }
    const next = new EdgePicker();
    next.build(edges);
    picker.current = next;
    candidates.current = candidateEdges(edges);
    history.current = [];
    future.current = [];
  }, [edges]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      return Boolean(
        element &&
          (element.isContentEditable ||
            element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA' ||
            element.tagName === 'SELECT'),
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      const state = useApp.getState();
      if (!state.selected) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        const stack = event.shiftKey ? future : history;
        const target = event.shiftKey ? history : future;
        const previous = stack.current.pop();
        if (!previous) return;
        target.current.push(state.selected.slice());
        state.setSelection(previous);
        return;
      }

      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        state.selectCandidates(!event.shiftKey);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const pickRadius = (hit: { distanceTo: (v: never) => number }): number => {
    const controller = getActiveViewport();
    if (!controller) return 0.5;
    const distance = controller.camera.position.distanceTo(hit as never);
    const height = controller.renderer.domElement.clientHeight || 1;
    const worldPerPixel =
      (2 * Math.tan((controller.camera.fov * Math.PI) / 360) * distance) / height;
    return Math.max(worldPerPixel * 10, 0.12);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    const state = useApp.getState();
    if (!state.selected || !state.edges) return;

    const controller = getActiveViewport();
    if (!controller) return;
    const point = controller.pickSurface(event.clientX, event.clientY);
    if (!point) return;

    event.preventDefault();
    stageRef.current?.setPointerCapture(event.pointerId);
    controller.controls.enabled = false;

    // Left adds, right removes. Alt+left also removes for trackpad users.
    const value: 0 | 1 = event.button === 2 || event.altKey ? 0 : 1;
    const radius = pickRadius(point);

    history.current.push(state.selected.slice());
    if (history.current.length > HISTORY_LIMIT) history.current.shift();
    future.current = [];

    paint.current = {
      value,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      lastDepth: controller.camera.position.distanceTo(point),
      radius,
    };

    const id = picker.current?.pick(point, radius) ?? null;
    if (id !== null) state.toggleEdge(id, value === 1);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = paint.current;
    if (!active || active.pointerId !== event.pointerId) return;

    const controller = getActiveViewport();
    const table = useApp.getState().edges;
    if (!controller || !table) return;

    const point = controller.pickSurface(event.clientX, event.clientY);
    if (!point) return;

    const referenceDepth = controller.camera.position.distanceTo(point);
    const canvas = controller.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.clientWidth || 1;
    const height = rect.height || canvas.clientHeight || 1;

    edgesAlongStroke(
      table,
      candidates.current,
      controller.camera,
      width,
      height,
      active.lastX - rect.left,
      active.lastY - rect.top,
      event.clientX - rect.left,
      event.clientY - rect.top,
      STROKE_THRESHOLD_PX,
      Math.max(active.radius * 6, 2),
      active.lastDepth,
      referenceDepth,
      hits.current,
    );

    if (hits.current.length > 0) {
      const state = useApp.getState();
      state.toggleEdges(hits.current, active.value === 1);
    }

    active.lastX = event.clientX;
    active.lastY = event.clientY;
    active.lastDepth = referenceDepth;
  };

  const endPaint = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paint.current || paint.current.pointerId !== event.pointerId) return;
    paint.current = null;
    stageRef.current?.releasePointerCapture?.(event.pointerId);
    const controller = getActiveViewport();
    if (controller) controller.controls.enabled = true;
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endPaint,
    onPointerCancel: endPaint,
    onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => event.preventDefault(),
  };
}
