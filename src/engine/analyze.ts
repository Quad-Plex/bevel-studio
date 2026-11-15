import type { AnalysisResult, MeshData, MeshMeta, MeshWarning } from './types';
import { computeMeshMeta } from './meta';
import { MAX_HOLE_EDGES, repairMesh, type RepairStats } from './repair/repair';
import { buildEdgeTable } from './topo/build';
import type { ParsedStl } from './io/stl';

/**
 * Import-time analysis: repair R1–R8, build the canonical edge table, then
 * recompute metadata on the repaired mesh.
 *
 * The mesh is never recentred or rescaled; triangle order is preserved except
 * for triangles the repair pass had to drop.
 */
export function analyzeMesh(
  mesh: MeshData,
  name: string,
): AnalysisResult & { mesh: MeshData } {
  const repaired = repairMesh(mesh);
  const edges = buildEdgeTable(repaired.mesh, repaired.topology);
  const meta = computeMeshMeta(repaired.mesh, name, edges, repaired.topology);
  return {
    mesh: repaired.mesh,
    meta,
    edges,
    repairs: repaired.repairs,
    warnings: buildWarnings(meta, repaired.stats),
  };
}

/**
 * Convenience for the worker: parseStl welds before analyzeMesh sees the mesh,
 * so the weld count would otherwise be lost from the repair report.
 */
export function analyzeParsedStl(
  parsed: ParsedStl,
  name: string,
): AnalysisResult & { mesh: MeshData } {
  const result = analyzeMesh(parsed.mesh, name);
  if (parsed.weldedVertices > 0) {
    const existing = result.repairs.find((record) => record.code === 'weld');
    if (existing) {
      existing.count += parsed.weldedVertices;
      existing.detail = `welded ${existing.count} duplicate vertices`;
    } else {
      result.repairs.unshift({
        code: 'weld',
        count: parsed.weldedVertices,
        detail: `welded ${parsed.weldedVertices} duplicate vertices`,
      });
    }
  }
  return result;
}

function buildWarnings(meta: MeshMeta, stats: RepairStats): MeshWarning[] {
  const warnings: MeshWarning[] = [];

  if (meta.triangles === 0) {
    warnings.push({
      code: 'empty',
      severity: 'error',
      message: 'Mesh contains no triangles.',
    });
    return warnings;
  }

  if (!meta.watertight) {
    const reasons: string[] = [];
    if (meta.boundaryEdges > 0) reasons.push(`${meta.boundaryEdges} boundary edges`);
    if (meta.nonManifoldEdges > 0) reasons.push(`${meta.nonManifoldEdges} non-manifold edges`);
    if (meta.degenerateTriangles > 0) reasons.push(`${meta.degenerateTriangles} degenerate triangles`);
    warnings.push({
      code: 'watertight',
      severity: 'error',
      message: `Mesh is not watertight: ${reasons.join(', ')}. Beveling is disabled until this is resolved.`,
    });
  }

  if (meta.volume <= 0) {
    warnings.push({
      code: 'volume',
      severity: 'error',
      message: 'Mesh encloses no positive volume; it may be open or inside-out.',
    });
  }

  if (stats.holesUnresolved > 0) {
    warnings.push({
      code: 'holes',
      severity: 'warning',
      message: `${stats.holesUnresolved} hole(s) exceed the ${MAX_HOLE_EDGES}-edge automatic limit and were left open.`,
    });
  }

  if (meta.shells > 1) {
    warnings.push({
      code: 'shells',
      severity: 'warning',
      message: `Mesh contains ${meta.shells} separate shells; bevels apply to all of them.`,
    });
  }

  if (stats.droppedComponents > 0) {
    warnings.push({
      code: 'shellDropped',
      severity: 'info',
      message: `Removed ${stats.droppedComponents} tiny disconnected component(s) (${stats.droppedVolume.toFixed(3)} mm³).`,
    });
  }

  if (stats.windingConflicts > 0) {
    warnings.push({
      code: 'orientation',
      severity: 'warning',
      message: `${stats.windingConflicts} winding conflict(s) remain; the surface may be non-orientable.`,
    });
  }

  return warnings;
}
