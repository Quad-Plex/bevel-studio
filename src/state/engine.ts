import { EngineClient } from '../engine/client';
import { useApp } from './store';

/**
 * One worker for the whole session. Created lazily so the first import pays the
 * startup cost, and wired to the store's progress slot for the loading card.
 */
let client: EngineClient | null = null;

export function getEngine(): EngineClient {
  if (!client) {
    client = new EngineClient({
      createWorker: () =>
        new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' }),
      onProgress: (stage, value) => useApp.getState().setProgress({ stage, value }),
    });
  }
  return client;
}

export function resetEngine(): void {
  client?.dispose();
  client = null;
}
