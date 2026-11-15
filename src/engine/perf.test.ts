import { describe, expect, it } from 'vitest';
import { analyzeMesh } from './analyze';
import { makeGrid } from './repair/testMeshes';

describe('performance', () => {
  it(
    'analyzes a synthetic 100k-triangle grid in under 1.5 s',
    { timeout: 20000 },
    () => {
      // 224 × 224 quads = 100 352 triangles, 50 625 shared vertices.
      const mesh = makeGrid(224, 224);
      expect(mesh.indices.length / 3).toBe(100352);

      const started = performance.now();
      const result = analyzeMesh(mesh, 'grid-100k');
      const elapsed = performance.now() - started;

      // The measured number is part of the M1 report.
      console.info(`[perf] 100k-triangle grid analyzeMesh: ${elapsed.toFixed(1)} ms`);

      expect(result.meta.triangles).toBe(100352);
      expect(result.edges.count).toBe(150976);
      expect(elapsed).toBeLessThan(1500);
    },
  );
});
