import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { MeshData } from '../engine/types';
import { useApp } from '../state/store';
import { useStlImport } from './import';
import { useEdgeSelection } from './useEdgeSelection';
import { clearActiveViewport, setActiveViewport } from './registry';
import { SceneController } from './scene';
import '../app/app.css';

/**
 * Full-window viewport. Owns the renderer, the model, the edge overlay and the
 * import drop target; all document state lives in the store.
 */
export function Viewport() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const brushRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const dragDepth = useRef(0);
  const fittedMesh = useRef<MeshData | null>(null);

  const [glError, setGlError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [building, setBuilding] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const baseMesh = useApp((state) => state.mesh);
  const previewMesh = useApp((state) => state.preview?.mesh ?? null);
  const previewBevelFaces = useApp((state) => state.preview?.bevelFaces ?? null);
  const showPreview = useApp((state) => state.showPreview);
  const showWireframe = useApp((state) => state.showWireframe);
  const meta = useApp((state) => state.meta);
  const edges = useApp((state) => state.edges);
  const selected = useApp((state) => state.selected);
  const phase = useApp((state) => state.phase);
  const smoothing = useApp((state) => state.params.smoothing);
  const fileName = useApp((state) => state.fileName);
  const storeError = useApp((state) => state.error);

  const importer = useStlImport();
  const selection = useEdgeSelection(hostRef, brushRef);

  // Dev affordance for automated screenshots: /?sample=1 loads the fixture.
  const autoSample = useRef(false);
  useEffect(() => {
    if (autoSample.current) return;
    if (!new URLSearchParams(location.search).has('sample')) return;
    autoSample.current = true;
    void importer.loadSample();
  }, [importer]);

  // Renderer lifecycle. StrictMode mounts, disposes and mounts again in dev, so
  // everything is created and released inside this one effect.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let controller: SceneController;
    try {
      controller = new SceneController(host);
    } catch (reason) {
      setGlError(reason instanceof Error ? reason.message : String(reason));
      return;
    }

    controllerRef.current = controller;
    fittedMesh.current = null;
    setActiveViewport(controller);
    controller.setWireframe(useApp.getState().showWireframe);

    return () => {
      controllerRef.current = null;
      clearActiveViewport(controller);
      controller.dispose();
    };
  }, []);

  // Swap the shaded mesh. The build (creased normals) is synchronous, so yield
  // one frame first to let the loading card paint.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;

    const mesh = showPreview ? previewMesh ?? baseMesh : baseMesh;
    if (!mesh) {
      controller.setMesh(null);
      fittedMesh.current = null;
      setBuilding(false);
      return;
    }

    const isBaseMesh = showPreview ? previewMesh === null : true;
    if (isBaseMesh) setBuilding(true);

    let cancelled = false;
    // setTimeout, not rAF: a background tab never fires animation frames, and the
    // model would sit on "Preparing model" until the tab is focused again.
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      const current = controllerRef.current;
      if (!current) {
        setBuilding(false);
        return;
      }

      try {
        current.setMesh(
          mesh,
          isBaseMesh ? meta?.bbox : undefined,
          smoothing === 'flat',
          isBaseMesh ? null : previewBevelFaces,
        );
        if (isBaseMesh && baseMesh && fittedMesh.current !== baseMesh) {
          fittedMesh.current = baseMesh;
          current.frame(meta?.bbox);
        }
      } finally {
        setBuilding(false);
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [baseMesh, previewMesh, previewBevelFaces, meta, showPreview, smoothing]);

  useEffect(() => {
    controllerRef.current?.setWireframe(showWireframe);
  }, [showWireframe]);

  // The overlay stays visible while previewing: the selection lives on the base
  // mesh, and hiding it would make the marked edges impossible to refine.
  useEffect(() => {
    controllerRef.current?.setEdges(edges, selected);
  }, [edges, selected]);

  // A new import starts with a clean slate for the toast.
  useEffect(() => {
    if (!storeError || phase === 'importing') setDismissedError(null);
  }, [storeError, phase]);

  // F refits the model; W toggles the wireframe overlay.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'f' && key !== 'w') return;

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }

      event.preventDefault();
      if (key === 'f') {
        controllerRef.current?.frame();
      } else {
        const state = useApp.getState();
        state.setShowWireframe(!state.showWireframe);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Dropping outside the viewport must not navigate the window to the file.
  useEffect(() => {
    const guard = (event: globalThis.DragEvent) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault();
      }
    };

    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  const hasFileDrag = (event: ReactDragEvent<HTMLDivElement>): boolean =>
    Array.from(event.dataTransfer.types).includes('Files');

  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);

    if (event.dataTransfer.files.length > 0) {
      void importer.loadFiles(Array.from(event.dataTransfer.files));
    }
  };

  const onStageDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (controller.isPointerOverModel(event.clientX, event.clientY)) return;
    controller.frame();
  };

  const hasMesh = Boolean(previewMesh ?? baseMesh);
  const busy = phase === 'importing' || building;
  const error =
    importer.error ?? (storeError && storeError !== dismissedError ? storeError : null);

  const dismissError = () => {
    if (importer.error) importer.dismissError();
    else setDismissedError(storeError);
  };

  return (
    <div
      className={`vp${dragging ? ' is-dragging' : ''}`}
      aria-busy={busy}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        ref={hostRef}
        className={`vp-stage${edges ? ' has-brush' : ''}`}
        onDoubleClick={onStageDoubleClick}
        {...selection}
      />
      <div ref={brushRef} className="vp-brush" aria-hidden="true" />

      {glError ? (
        <div className="vp-center">
          <section className="vp-card">
            <h1 className="vp-title">3D preview unavailable</h1>
            <p className="vp-sub">{glError}</p>
          </section>
        </div>
      ) : (
        <>
          {!hasMesh && !busy && (
            <div className="vp-center">
              <section
                className={`vp-card${dragging ? ' is-drop' : ''}`}
                aria-labelledby="vp-empty-title"
              >
                <CubeGlyph />
                <h1 id="vp-empty-title" className="vp-title">
                  {dragging ? 'Release to load' : 'Drop an STL to begin'}
                </h1>
                <p className="vp-sub vp-sub--mono">STL · binary or ASCII · millimetres</p>
                <button type="button" className="vp-primary" onClick={importer.openPicker}>
                  Browse files
                </button>
                <button
                  type="button"
                  className="vp-link"
                  onClick={() => void importer.loadSample()}
                  disabled={importer.busy}
                >
                  Load sample hook
                </button>
              </section>
            </div>
          )}

          {busy && (
            <div className="vp-center">
              <div className="vp-card vp-card--loading" role="status" aria-live="polite">
                <span className="vp-spinner" aria-hidden="true" />
                <h1 className="vp-title vp-title--sm">
                  {phase === 'importing'
                    ? `Reading ${fileName ?? 'STL'}`
                    : 'Preparing model'}
                </h1>
                <p className="vp-sub">
                  {phase === 'importing'
                    ? 'Parsing triangles and measuring the model.'
                    : 'Building the shaded view.'}
                </p>
              </div>
            </div>
          )}

          {hasMesh && dragging && (
            <div className="vp-drop-pill" aria-hidden="true">
              Release to load
            </div>
          )}
        </>
      )}

      {dragging && <div className="vp-drop-ring" aria-hidden="true" />}

      {error && (
        <div className="vp-toast" role="alert">
          <span className="vp-toast-dot" aria-hidden="true" />
          <p className="vp-toast-text">{error}</p>
          <button
            type="button"
            className="vp-toast-close"
            aria-label="Dismiss error"
            onClick={dismissError}
          >
            ×
          </button>
        </div>
      )}

      <input
        ref={importer.inputRef}
        className="vp-file"
        type="file"
        accept={importer.accept}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = event.currentTarget.files
            ? Array.from(event.currentTarget.files)
            : [];
          event.currentTarget.value = '';
          void importer.loadFiles(files);
        }}
      />
    </div>
  );
}

function CubeGlyph() {
  return (
    <svg className="vp-glyph" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path className="vp-glyph-top" d="M24 5 42 15 24 25 6 15Z" />
      <path className="vp-glyph-edge" d="M24 5 42 15v18L24 43 6 33V15Z" />
      <path className="vp-glyph-edge" d="M24 25v18M24 25 42 15M24 25 6 15" />
    </svg>
  );
}
