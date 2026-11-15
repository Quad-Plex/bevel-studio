import type { SceneController } from './scene';

let active: SceneController | null = null;

/**
 * The selection workstream (and any other viewport consumer) reaches the live
 * controller through this registry instead of importing the React component.
 * Returns null while the viewport is unmounted or WebGL failed to start.
 */
export function getActiveViewport(): SceneController | null {
  return active;
}

export function setActiveViewport(controller: SceneController): void {
  active = controller;
}

export function clearActiveViewport(controller: SceneController): void {
  if (active === controller) active = null;
}
