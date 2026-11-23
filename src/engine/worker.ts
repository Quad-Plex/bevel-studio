/// <reference lib="webworker" />
import { parseStl } from './io/stl';
import { analyzeParsedStl } from './analyze';
import { bevelMesh, initKernel, meshToStl } from './bevel/kernel';
import { edgeTableToBuffers, type WorkerRequest, type WorkerResponse } from './protocol';
import type { BevelParams, EdgeTable, MeshData } from './types';

/**
 * Geometry worker. Owns the only copy of the repaired source mesh and the
 * canonical edge table for the session; the main thread only holds render
 * copies. Every response copies buffers before transferring them so the
 * worker never detaches its own data.
 *
 * Messages are serialized through `chain`: `bevelMesh` is synchronous, so two
 * handlers must never interleave at an `await` (an import would otherwise
 * replace `source` in the middle of a preview).
 */

let source: MeshData | null = null;
let edgeTable: EdgeTable | null = null;
let sourceName = 'model';
let kernelReady: Promise<void> | null = null;
let docEpoch = 0;
let chain: Promise<void> = Promise.resolve();

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  chain = chain.then(() => handle(request));
};

async function handle(request: WorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'import':
        await importMesh(request);
        return;
      case 'preview':
        await preview(request);
        return;
      case 'export':
        await exportStl(request);
        return;
      case 'cancel':
        // Synchronous geometry cannot be preempted; the client coalesces jobs
        // so at most one preview is in flight. A cancel only affects jobs that
        // have not started yet, which the client drops before posting.
        return;
    }
  } catch (reason) {
    post({
      id: request.id,
      type: 'error',
      message: reason instanceof Error ? reason.message : String(reason),
      stage: request.type,
    });
  }
}

async function importMesh(request: Extract<WorkerRequest, { type: 'import' }>): Promise<void> {
  progress('Reading triangles', 0.05);
  const parsed = parseStl(request.buffer);
  progress('Repairing mesh and building edges', 0.3);

  const analyzed = analyzeParsedStl(parsed, request.name);
  source = analyzed.mesh;
  edgeTable = analyzed.edges;
  sourceName = request.name.replace(/\.stl$/i, '');
  docEpoch += 1;

  const { mesh, edges, ...result } = analyzed;
  const edgeBuffers = edgeTableToBuffers(edges);
  const positions = mesh.positions.slice();
  const indices = mesh.indices.slice();

  progress('Ready', 1);
  post(
    {
      id: request.id,
      type: 'imported',
      result,
      edges: edgeBuffers.buffers,
      positions: positions.buffer,
      indices: indices.buffer,
      epoch: docEpoch,
    },
    [positions.buffer, indices.buffer, ...edgeBuffers.transfer],
  );
}

async function preview(request: Extract<WorkerRequest, { type: 'preview' }>): Promise<void> {
  if (!source) throw new Error('No model loaded');
  if (request.epoch !== docEpoch) {
    post({ id: request.id, type: 'error', code: 'superseded', message: 'Document changed' });
    return;
  }

  await ensureKernel();
  if (request.epoch !== docEpoch) {
    post({ id: request.id, type: 'error', code: 'superseded', message: 'Document changed' });
    return;
  }

  progress('Building bevel', 0.4);
  const result = bevelMesh(source, request.edges, request.params);

  const { mesh, bevelFaces, ...payload } = result;
  const positions = mesh.positions.slice();
  const indices = mesh.indices.slice();
  const faces = bevelFaces ? bevelFaces.slice() : new Uint8Array(0);

  progress('Ready', 1);
  post(
    {
      id: request.id,
      type: 'previewed',
      result: payload,
      positions: positions.buffer,
      indices: indices.buffer,
      bevelFaces: faces.buffer,
    },
    [positions.buffer, indices.buffer, faces.buffer],
  );
}

async function exportStl(request: Extract<WorkerRequest, { type: 'export' }>): Promise<void> {
  if (!source) throw new Error('No model loaded');
  if (request.epoch !== docEpoch) {
    post({ id: request.id, type: 'error', code: 'superseded', message: 'Document changed' });
    return;
  }

  await ensureKernel();
  if (request.epoch !== docEpoch) {
    post({ id: request.id, type: 'error', code: 'superseded', message: 'Document changed' });
    return;
  }

  progress('Applying bevel', 0.3);
  const params: BevelParams = request.params;
  const result = bevelMesh(source, request.edges, params);
  progress('Writing STL', 0.85);

  const bytes = meshToStl(result.mesh);
  post({ id: request.id, type: 'exported', bytes, name: `${sourceName}-beveled.stl` }, [bytes]);
}

function ensureKernel(): Promise<void> {
  if (!kernelReady) {
    progress('Loading geometry kernel', 0.15);
    // A failed init must not poison the session: clear the cache so the next
    // request retries instead of returning the same rejected promise.
    kernelReady = initKernel().catch((reason: unknown) => {
      kernelReady = null;
      throw reason;
    });
  }
  return kernelReady;
}

function progress(stage: string, value: number): void {
  post({ type: 'progress', stage, value, epoch: docEpoch, id: 0 });
}

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}
