import type { AnalysisResult, BevelParams, BevelResult, EdgeTable, MeshData } from './types';
import {
  edgeTableFromBuffers,
  type EdgeBuffers,
  type ImportPayload,
  type PreviewPayload,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';

export class SupersededError extends Error {
  constructor() {
    super('Superseded by a newer request');
    this.name = 'SupersededError';
  }
}

export interface ImportedMesh {
  result: AnalysisResult;
  mesh: MeshData;
}

export interface PreviewMesh {
  result: PreviewPayload;
  mesh: MeshData;
  /** 0/1 per triangle of `mesh`; empty when the kernel could not attribute. */
  bevelFaces: Uint8Array;
}

interface Pending {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PreviewJob {
  edges: Uint32Array;
  params: BevelParams;
  epoch: number;
  resolve: (value: PreviewMesh) => void;
  reject: (error: Error) => void;
}

export interface EngineClientOptions {
  /**
   * Injected by the app so this module never statically references the worker
   * entry point (keeps typecheck/build independent of the engine workstreams).
   */
  createWorker: () => Worker;
  onProgress?: (stage: string, value: number) => void;
  /** Milliseconds before a request is considered dead. 1 M bevels take ~4 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Main-thread façade over the geometry worker.
 *
 * Only one geometry job runs at a time. A burst of previews collapses to the
 * newest one (`queued`), because `bevelMesh` is synchronous inside the worker
 * and cannot be preempted; this is what keeps a slider drag from queuing
 * several multi-second jobs behind a stale one.
 */
export class EngineClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly createWorker: () => Worker;
  private readonly onProgress?: (stage: string, value: number) => void;
  private readonly timeoutMs: number;
  private seq = 1;
  private epoch = 0;
  private busy = false;
  private queued: PreviewJob | null = null;
  private disposed = false;

  constructor(options: EngineClientOptions) {
    this.createWorker = options.createWorker;
    this.onProgress = options.onProgress;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.worker = this.spawn();
  }

  async importStl(buffer: ArrayBuffer, name: string): Promise<ImportedMesh> {
    this.dropQueued(new SupersededError());

    const id = this.seq++;
    this.post({ id, type: 'import', buffer, name }, [buffer]);
    const message = (await this.wait(id)) as Extract<WorkerResponse, { type: 'imported' }>;

    this.epoch = message.epoch;
    const edges = edgeTableFromBuffers(message.edges as EdgeBuffers);
    return {
      result: { ...(message.result as ImportPayload), edges },
      mesh: meshFromBuffers(message.positions, message.indices),
    };
  }

  /**
   * Request a bevel preview. Resolves with the newest result; a request made
   * while another is running replaces the queued one instead of stacking.
   */
  preview(edges: Uint32Array, params: BevelParams): Promise<PreviewMesh> {
    return new Promise<PreviewMesh>((resolve, reject) => {
      this.queued?.reject(new SupersededError());
      this.queued = { edges: edges.slice(), params, epoch: this.epoch, resolve, reject };
      void this.pump();
    });
  }

  async exportStl(edges: Uint32Array, params: BevelParams): Promise<{ bytes: ArrayBuffer; name: string }> {
    const copy = edges.slice();
    const id = this.seq++;
    this.post(
      { id, type: 'export', edges: copy, params, format: 'stl', epoch: this.epoch },
      [copy.buffer],
    );
    const message = (await this.wait(id)) as Extract<WorkerResponse, { type: 'exported' }>;
    return { bytes: message.bytes, name: message.name };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropQueued(new SupersededError());
    this.failAll(new SupersededError());
    this.worker?.terminate();
    this.worker = null;
  }

  // ---------------------------------------------------------------- internals

  private spawn(): Worker {
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The geometry worker stopped unexpectedly.');
      this.failAll(error);
      this.worker?.terminate();
      this.worker = null;
      this.epoch = 0;
      this.busy = false;
    };
    return worker;
  }

  private ensureWorker(): Worker {
    if (!this.worker) this.worker = this.spawn();
    return this.worker;
  }

  private post(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.ensureWorker().postMessage(message, transfer);
  }

  private async pump(): Promise<void> {
    if (this.busy || this.disposed || !this.queued) return;

    const job = this.queued;
    this.queued = null;
    this.busy = true;
    const id = this.seq++;

    try {
      this.post({ id, type: 'preview', edges: job.edges, params: job.params, epoch: job.epoch }, [
        job.edges.buffer,
      ]);
      const message = (await this.wait(id)) as Extract<WorkerResponse, { type: 'previewed' }>;
      if (job.epoch !== this.epoch) throw new SupersededError();
      job.resolve({
        result: message.result,
        mesh: meshFromBuffers(message.positions, message.indices),
        bevelFaces: new Uint8Array(message.bevelFaces),
      });
    } catch (error) {
      job.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  private wait(id: number): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The geometry worker did not answer in time.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private handle(message: WorkerResponse): void {
    if (message.type === 'progress') {
      this.onProgress?.(message.stage, message.value);
      return;
    }

    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.type === 'error') {
      entry.reject(
        message.code === 'superseded'
          ? new SupersededError()
          : new Error(message.stage ? `${message.stage}: ${message.message}` : message.message),
      );
      return;
    }
    entry.resolve(message);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private dropQueued(error: Error): void {
    this.queued?.reject(error);
    this.queued = null;
  }
}

function meshFromBuffers(positions: ArrayBuffer, indices: ArrayBuffer): MeshData {
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
