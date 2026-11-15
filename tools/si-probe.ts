import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseStl } from '../src/engine/io/stl';
import { analyzeParsedStl } from '../src/engine/analyze';
import { initKernel, bevelMesh } from '../src/engine/bevel/kernel';
import { DEFAULT_BEVEL, EDGE_CONVEX } from '../src/engine/types';

const buffer = readFileSync(resolve('public/fixtures/hook-base.stl'));
const parsed = parseStl(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
const analyzed = analyzeParsedStl(parsed, 'hook');
const ids: number[] = [];
for (let i = 0; i < analyzed.edges.count; i++) {
  if ((analyzed.edges.flags[i] & EDGE_CONVEX) !== 0 && analyzed.edges.dihedral[i] >= 20) ids.push(i);
}
await initKernel();

const variants: { label: string; params: typeof DEFAULT_BEVEL; options?: { taper?: 'auto' | 'none' } }[] = [
  { label: 'default (clamp on)', params: { ...DEFAULT_BEVEL, width: 0.5, segments: 4 } },
  { label: 'taper none', params: { ...DEFAULT_BEVEL, width: 0.5, segments: 4 }, options: { taper: 'none' } },
  { label: 'w=0.35', params: { ...DEFAULT_BEVEL, width: 0.35, segments: 4 } },
  { label: 'w=0.25', params: { ...DEFAULT_BEVEL, width: 0.25, segments: 4 } },
  { label: 'w=0.35 taper none', params: { ...DEFAULT_BEVEL, width: 0.35, segments: 4 }, options: { taper: 'none' } },
];

for (const variant of variants) {
  const started = performance.now();
  const result = bevelMesh(analyzed.mesh, Uint32Array.from(ids), variant.params, analyzed.edges.maxWidth, variant.options);
  console.log(
    variant.label.padEnd(24),
    String(result.mesh.indices.length / 3).padStart(5),
    'tri',
    result.volumeAfter.toFixed(2).padStart(9),
    'mm³',
    'SI',
    String(result.selfIntersections ?? -1).padStart(4),
    `${(performance.now() - started).toFixed(0)} ms`,
  );
}
