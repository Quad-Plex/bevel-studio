import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Ray, Vector3 } from 'three';
import { useApp } from '../state/store';
import { brushableEdges, edgesInBrush } from './brush';
import type { HoverMode } from './edgeView';
import { getActiveViewport } from './registry';
import { SurfaceIndex } from './surface';

const HISTORY_LIMIT = 40;

/**
 * Brush selection.
 *
 * A screen-space ring of `brush.radius` pixels follows the cursor. Every
 * feature edge (outside, inside or both, per `brush.filter`) whose projected
 * segment passes through the ring, and whose nearest point is not hidden
 * behind the part, is under the brush:
 *
 *   - hover highlights exactly those edges, in the colour of the action;
 *   - left click / drag adds them, right click / drag (or Alt) removes them;
 *     a drag sweeps the ring along the stroke so fast moves skip nothing;
 *   - `[` / `]` shrink and grow the ring.
 *
 * A press that hits neither an edge nor the model falls through to the
 * orbit controls. Occlusion is tested with a ray against a BVH of the source
 * mesh, so it stays exact on curved parts (no depth band) and fast on large
 * meshes.
 */
export function useEdgeSelection(
  stageRef: React.RefObject<HTMLDivElement | null>,
  ringRef: React.RefObject<HTMLDivElement | null>,
) {
  const surface = useRef(new SurfaceIndex());
  const brushable = useRef<Uint32Array>(new Uint32Array(0));
  const hits = useRef<number[]>([]);
  const pointer = useRef<{ x: number; y: number; alt: boolean; over: boolean }>({
    x: 0,
    y: 0,
    alt: false,
    over: false,
  });
  const frame = useRef(0);
  const paint = useRef<{
    value: 0 | 1;
    pointerId: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const history = useRef<Uint8Array[]>([]);
  const future = useRef<Uint8Array[]>([]);

  const edges = useApp((state) => state.edges);
  const mesh = useApp((state) => state.mesh);
  const filter = useApp((state) => state.brush.filter);
  const radius = useApp((state) => state.brush.radius);

  useEffect(() => {
    surface.current.setMesh(mesh);
  }, [mesh]);

  useEffect(() => {
    brushable.current = edges ? brushableEdges(edges, filter) : new Uint32Array(0);
    scheduleHover();
    // scheduleHover only reads refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, filter]);

  useEffect(() => {
    history.current = [];
    future.current = [];
  }, [edges]);

  // The highlight shows what the action would change, so it depends on the
  // selection too (Clear, A, undo all change it without moving the pointer).
  const selected = useApp((state) => state.selected);
  useEffect(() => {
    scheduleHover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radius, selected]);

  // Hover follows camera moves too (wheel zoom, orbit with the keyboard).
  useEffect(() => {
    let attached: ReturnType<typeof getActiveViewport> = null;
    const onChange = () => scheduleHover();
    const attach = () => {
      const controller = getActiveViewport();
      if (controller === attached) return;
      attached?.controls.removeEventListener('change', onChange);
      controller?.controls.addEventListener('change', onChange);
      attached = controller;
    };
    attach();
    const timer = window.setInterval(attach, 1000);
    return () => {
      window.clearInterval(timer);
      attached?.controls.removeEventListener('change', onChange);
      // StrictMode remounts: a cancelled frame must not block the next one.
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (event.key === 'Alt') {
        pointer.current.alt = true;
        scheduleHover();
      }
      if (isEditable(event.target)) return;
      const state = useApp.getState();

      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        const step = Math.max(1, Math.round(state.brush.radius * 0.2));
        state.setBrush({ radius: state.brush.radius + (event.key === ']' ? step : -step) });
        return;
      }
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
        remember(state.selected);
        state.selectCandidates(!event.shiftKey);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        pointer.current.alt = false;
        scheduleHover();
      }
    };
    const onBlur = () => {
      pointer.current.alt = false;
      scheduleHover();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function remember(selected: Uint8Array) {
    history.current.push(selected.slice());
    if (history.current.length > HISTORY_LIMIT) history.current.shift();
    future.current = [];
  }

  /** Edges under the ring swept from (x0, y0) to (x1, y1), client pixels. */
  function brushHits(x0: number, y0: number, x1: number, y1: number, out: number[]): number[] {
    out.length = 0;
    const controller = getActiveViewport();
    const table = useApp.getState().edges;
    if (!controller || !table || brushable.current.length === 0) return out;
    const canvas = controller.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.clientWidth || 1;
    const height = rect.height || canvas.clientHeight || 1;
    const camera = controller.camera;
    camera.updateMatrixWorld();
    const eye = camera.position;
    const pixelAt = (p: Vector3) =>
      (2 * Math.tan((camera.fov * Math.PI) / 360) * eye.distanceTo(p)) / height;
    return edgesInBrush(
      {
        table,
        ids: brushable.current,
        camera,
        width,
        height,
        x0: x0 - rect.left,
        y0: y0 - rect.top,
        x1: x1 - rect.left,
        y1: y1 - rect.top,
        radius: useApp.getState().brush.radius,
        visible: (p) => surface.current.visible(eye, p, Math.max(pixelAt(p) * 4, 1e-3)),
      },
      out,
    );
  }

  const ray = new Ray();
  function overModel(clientX: number, clientY: number): boolean {
    const controller = getActiveViewport();
    if (!controller || !surface.current.ready) return false;
    controller.screenToRay(clientX, clientY, ray);
    return surface.current.pick(ray) !== null;
  }

  function currentMode(): HoverMode {
    const active = paint.current;
    if (active) return active.value === 1 ? 'add' : 'remove';
    return pointer.current.alt ? 'remove' : 'add';
  }

  function updateRing(visible: boolean, active: boolean, count: number) {
    const ring = ringRef.current;
    if (!ring) return;
    const r = useApp.getState().brush.radius;
    ring.style.width = `${2 * r}px`;
    ring.style.height = `${2 * r}px`;
    ring.style.transform = `translate(${pointer.current.x - r}px, ${pointer.current.y - r}px)`;
    ring.dataset.mode = currentMode();
    ring.classList.toggle('is-visible', visible);
    ring.classList.toggle('is-active', active);
    ring.classList.toggle('has-hits', count > 0);
  }

  function scheduleHover() {
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const controller = getActiveViewport();
      const state = useApp.getState();
      const show = pointer.current.over && Boolean(state.edges) && Boolean(state.selected);
      if (!controller || !show) {
        controller?.edgeView.setHover(null);
        updateRing(false, false, 0);
        return;
      }
      const { x, y } = pointer.current;
      const under = brushHits(x, y, x, y, []);
      const selected = state.selected!;
      // Everything under the ring: unselected edges are add candidates,
      // selected ones are removal candidates.
      const add = under.filter((id) => !selected[id]);
      const remove = under.filter((id) => selected[id]);
      controller.edgeView.setHover({ add, remove }, currentMode());
      updateRing(true, paint.current !== null, under.length);
    });
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    const state = useApp.getState();
    if (!state.selected || !state.edges) return;
    const controller = getActiveViewport();
    if (!controller) return;

    pointer.current = { x: event.clientX, y: event.clientY, alt: event.altKey, over: true };
    const under = brushHits(event.clientX, event.clientY, event.clientX, event.clientY, hits.current);
    if (under.length === 0 && !overModel(event.clientX, event.clientY)) return; // orbit / pan

    event.preventDefault();
    stageRef.current?.setPointerCapture(event.pointerId);
    controller.controls.enabled = false;

    // Left adds, right removes. Alt+left also removes for trackpad users.
    const value: 0 | 1 = event.button === 2 || event.altKey ? 0 : 1;
    remember(state.selected);
    paint.current = { value, pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
    if (under.length > 0) state.toggleEdges(under, value === 1);
    scheduleHover();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointer.current.x = event.clientX;
    pointer.current.y = event.clientY;
    pointer.current.alt = event.altKey;
    pointer.current.over = true;

    const active = paint.current;
    if (active && active.pointerId === event.pointerId) {
      const swept = brushHits(active.lastX, active.lastY, event.clientX, event.clientY, hits.current);
      if (swept.length > 0) useApp.getState().toggleEdges(swept, active.value === 1);
      active.lastX = event.clientX;
      active.lastY = event.clientY;
    }
    scheduleHover();
  };

  const endPaint = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paint.current || paint.current.pointerId !== event.pointerId) return;
    paint.current = null;
    stageRef.current?.releasePointerCapture?.(event.pointerId);
    const controller = getActiveViewport();
    if (controller) controller.controls.enabled = true;
    scheduleHover();
  };

  const onPointerLeave = () => {
    if (paint.current) return;
    pointer.current.over = false;
    scheduleHover();
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endPaint,
    onPointerCancel: endPaint,
    onPointerLeave,
    onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => event.preventDefault(),
  };
}

