import { useCallback, useRef, useState, type RefObject } from 'react';
import { useApp } from '../state/store';
import { getEngine } from '../state/engine';

export const STL_ACCEPT = '.stl,model/stl';

const SAMPLE_NAME = 'hook-base.stl';
const SAMPLE_URL = `${import.meta.env.BASE_URL}fixtures/${SAMPLE_NAME}`;

export interface StlImport {
  inputRef: RefObject<HTMLInputElement | null>;
  accept: string;
  /** True while a file is being read/parsed; the store phase is the renderer's cue. */
  busy: boolean;
  /** Local validation error (wrong file type); parse failures land in the store. */
  error: string | null;
  dismissError: () => void;
  openPicker: () => void;
  loadFiles: (files: FileList | File[] | null | undefined) => Promise<void>;
  loadSample: () => Promise<void>;
}

/**
 * File loading for the viewport. Sets the store's `importing` phase, yields one
 * paint so the loading card is visible, then parses on the UI thread. Parsing
 * moves to the worker with the engine workstream; the viewport contract stays.
 */
export function useStlImport(): StlImport {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dismissError = useCallback(() => setError(null), []);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const loadFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    const candidates = files ? Array.from(files) : [];
    if (candidates.length === 0) return;
    if (busyRef.current) return;

    const file = candidates.find((candidate) => isStl(candidate.name));
    if (!file) {
      setError(
        `${candidates[0].name} is not an STL file. Drop a .stl file — binary or ASCII.`,
      );
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      useApp.getState().beginImport(file.name);
      await nextPaint();

      const buffer = await file.arrayBuffer();
      const { result, mesh } = await getEngine().importStl(buffer, file.name);
      useApp.getState().setImported(file.name, mesh, result.edges, result.meta, result.warnings);
    } catch (reason) {
      useApp.getState().fail(`Could not read ${file.name}. ${describe(reason)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const loadSample = useCallback(async () => {
    if (busyRef.current) return;

    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      useApp.getState().beginImport(SAMPLE_NAME);
      await nextPaint();

      const response = await fetch(SAMPLE_URL);
      if (!response.ok) {
        throw new Error(`the sample is missing (HTTP ${response.status})`);
      }

      const buffer = await response.arrayBuffer();
      const { result, mesh } = await getEngine().importStl(buffer, SAMPLE_NAME);
      useApp.getState().setImported(SAMPLE_NAME, mesh, result.edges, result.meta, result.warnings);
    } catch (reason) {
      useApp.getState().fail(`Could not load the sample hook. ${describe(reason)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return {
    inputRef,
    accept: STL_ACCEPT,
    busy,
    error,
    dismissError,
    openPicker,
    loadFiles,
    loadSample,
  };
}

function isStl(name: string): boolean {
  return name.toLowerCase().endsWith('.stl');
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Resolve after the browser had a chance to paint the loading state. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(finish));
      // Hidden tabs throttle rAF; do not stall the import forever.
      setTimeout(finish, 150);
    } else {
      setTimeout(finish, 0);
    }
  });
}
