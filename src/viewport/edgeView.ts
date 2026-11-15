import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Sphere,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  EDGE_BOUNDARY,
  EDGE_NON_MANIFOLD,
  type EdgeTable,
} from '../engine/types';

/** Above this many selected edges, fat lines cost more than they are worth. */
export const FAT_EDGE_LIMIT = 30_000;

const EDGE_COLOR = 0x7f8f97;
const EDGE_OPACITY = 0.22;
const FAT_WIDTH = 2.2;

/**
 * Edge overlay.
 *
 * Two layers:
 *  - every edge as a thin `LineSegments` (one static buffer, zero-copy from the
 *    edge table's packed positions);
 *  - selected edges as screen-space fat lines (`LineSegments2`).
 *
 * The table-dependent buffers are built once per `EdgeTable`. Selection changes
 * only rewrite the selection buffer (fat lines) or the draw range of the thin
 * fallback, so a click never rebuilds the 1 M-edge base layer.
 */
export class EdgeView {
  readonly group = new Group();

  private readonly baseMaterial: LineBasicMaterial;
  private readonly fatMaterial: LineMaterial;
  private worldPerPixel = 0.05;
  private readonly fallbackMaterial: LineBasicMaterial;

  private table: EdgeTable | null = null;
  private selection: Uint8Array | null = null;
  private edgeCount = 0;

  private baseGeometry: BufferGeometry | null = null;
  private baseLines: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;

  private fatGeometry: LineSegmentsGeometry | null = null;
  private fatBuffer: InstancedInterleavedBuffer | null = null;
  private fatData: Float32Array | null = null;
  private fatCore: LineSegments2 | null = null;

  private fallbackGeometry: BufferGeometry | null = null;
  private fallbackData: Float32Array | null = null;
  private fallbackCapacity = 0;
  private fallbackLines: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;

  constructor(
    private readonly invalidate: () => void,
    selectionColor: string,
  ) {
    this.group.name = 'edge-overlay';

    this.baseMaterial = new LineBasicMaterial({
      color: EDGE_COLOR,
      transparent: true,
      opacity: EDGE_OPACITY,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.fatMaterial = new LineMaterial({
      color: selectionColor,
      linewidth: FAT_WIDTH,
      worldUnits: false,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      alphaToCoverage: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    this.fallbackMaterial = new LineBasicMaterial({
      color: selectionColor,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }

  /** The material resolution is in CSS pixels; call this whenever the canvas resizes. */
  setResolution(width: number, height: number): void {
    this.fatMaterial.resolution.set(width, height);
  }

  /**
   * `setEdges(table, null)` clears everything. Passing the same table again is
   * cheap: only the selection overlay is refreshed.
   */
  /** World units per screen pixel at the model, used to overlap fat segments. */
  setPixelScale(worldPerPixel: number): void {
    if (Number.isFinite(worldPerPixel) && worldPerPixel > 0) this.worldPerPixel = worldPerPixel;
  }

  /** Zoom changes the overlap needed to close segment joins; refill when it drifts. */
  refreshScale(worldPerPixel: number): void {
    if (!(worldPerPixel > 0)) return;
    if (Math.abs(worldPerPixel - this.worldPerPixel) / this.worldPerPixel < 0.05) return;
    this.worldPerPixel = worldPerPixel;
    this.applySelection();
    this.invalidate();
  }

  setEdges(table: EdgeTable | null, selection: Uint8Array | null): void {
    if (table !== this.table) this.rebuild(table);
    this.selection = selection;
    this.applySelection();
    this.invalidate();
  }

  /** Selection-only update. Does nothing when no table has been set yet. */
  setSelection(selection: Uint8Array | null): void {
    this.selection = selection;
    this.applySelection();
    this.invalidate();
  }

  dispose(): void {
    this.releaseTable();
    this.baseMaterial.dispose();
    this.fatMaterial.dispose();
    this.fallbackMaterial.dispose();
    this.group.removeFromParent();
  }

  private rebuild(table: EdgeTable | null): void {
    this.releaseTable();
    this.table = table;
    this.selection = null;
    if (!table) return;

    const edgeCount = Math.min(table.count, Math.floor(table.position.length / 6));
    this.edgeCount = edgeCount;
    if (edgeCount <= 0) return;

    // Base layer: only feature edges. Drawing every triangle diagonal turns a
    // curved wall into a moiré of faint lines; flat edges carry no information.
    const feature: number[] = [];
    for (let i = 0; i < edgeCount; i++) {
      const flags = table.flags[i];
      if (table.dihedral[i] >= 15 || (flags & (EDGE_BOUNDARY | EDGE_NON_MANIFOLD)) !== 0) {
        feature.push(i);
      }
    }
    const featurePositions = new Float32Array(feature.length * 6);
    for (let i = 0; i < feature.length; i++) {
      const from = feature[i] * 6;
      featurePositions.set(table.position.subarray(from, from + 6), i * 6);
    }

    const baseGeometry = new BufferGeometry();
    baseGeometry.setAttribute('position', new BufferAttribute(featurePositions, 3));
    this.baseGeometry = baseGeometry;
    this.baseLines = new LineSegments(baseGeometry, this.baseMaterial);
    this.baseLines.name = 'edges-feature';
    this.baseLines.frustumCulled = false;
    this.baseLines.renderOrder = 1;
    this.group.add(this.baseLines);

    // Fat layer: room for the cap only, positions are written on selection change.
    const capacity = Math.min(FAT_EDGE_LIMIT, edgeCount);
    const data = new Float32Array(capacity * 6);
    const buffer = new InstancedInterleavedBuffer(data, 6, 1);
    buffer.setUsage(DynamicDrawUsage);

    const fatGeometry = new LineSegmentsGeometry();
    fatGeometry.setAttribute('instanceStart', new InterleavedBufferAttribute(buffer, 3, 0));
    fatGeometry.setAttribute('instanceEnd', new InterleavedBufferAttribute(buffer, 3, 3));
    fatGeometry.instanceCount = 0;
    fatGeometry.boundingSphere = new Sphere(new Vector3(), Infinity);

    this.fatGeometry = fatGeometry;
    this.fatBuffer = buffer;
    this.fatData = data;

    this.fatCore = new LineSegments2(fatGeometry, this.fatMaterial);
    this.fatCore.name = 'edges-selected';
    this.fatCore.frustumCulled = false;
    this.fatCore.renderOrder = 3;
    this.fatCore.visible = false;

    this.group.add(this.fatCore);
  }

  private applySelection(): void {
    const table = this.table;
    const selection = this.selection;

    if (!table || !selection || this.edgeCount <= 0) {
      this.hideFat();
      return;
    }

    const count = this.edgeCount;
    let selectedCount = 0;
    for (let i = 0; i < count; i++) {
      if (selection[i]) selectedCount++;
    }

    if (selectedCount === 0) {
      this.hideFat();
      return;
    }

    if (selectedCount <= FAT_EDGE_LIMIT) {
      this.fillFat(table, selection, count, selectedCount);
    } else {
      this.fillFallback(table, selection, count, selectedCount);
    }
  }

  private fillFat(
    table: EdgeTable,
    selection: Uint8Array,
    count: number,
    selectedCount: number,
  ): void {
    const data = this.fatData;
    const buffer = this.fatBuffer;
    const geometry = this.fatGeometry;
    const core = this.fatCore;
    if (!data || !buffer || !geometry || !core) return;

    // LineSegments2 draws each segment as an independent screen-space quad with
    // square caps. At a joint the outer corner leaves a wedge that shows the
    // background through it, which reads as a notch along a curve. Overlap the
    // segments by half a line width to close those wedges.
    const overlap = Math.max(this.worldPerPixel * FAT_WIDTH * 0.6, 1e-4);

    const positions = table.position;
    let offset = 0;
    for (let i = 0; i < count; i++) {
      if (!selection[i]) continue;
      const p = i * 6;
      const x0 = positions[p];
      const y0 = positions[p + 1];
      const z0 = positions[p + 2];
      const x1 = positions[p + 3];
      const y1 = positions[p + 4];
      const z1 = positions[p + 5];

      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      const length = Math.hypot(dx, dy, dz);
      const extend = length > overlap * 2 ? overlap / length : 0;

      data[offset] = x0 - dx * extend;
      data[offset + 1] = y0 - dy * extend;
      data[offset + 2] = z0 - dz * extend;
      data[offset + 3] = x1 + dx * extend;
      data[offset + 4] = y1 + dy * extend;
      data[offset + 5] = z1 + dz * extend;
      offset += 6;
    }

    buffer.clearUpdateRanges();
    buffer.addUpdateRange(0, offset);
    buffer.needsUpdate = true;
    geometry.instanceCount = selectedCount;

    core.visible = true;
    if (this.fallbackLines) this.fallbackLines.visible = false;
  }

  /**
   * More than the fat-line cap: draw the selection as thin amber lines instead.
   * The buffer is only allocated once the user actually selects that many edges.
   */
  private fillFallback(
    table: EdgeTable,
    selection: Uint8Array,
    count: number,
    selectedCount: number,
  ): void {
    if (!this.fallbackGeometry || this.fallbackCapacity < selectedCount) {
      this.releaseFallback();
      const capacity = Math.max(selectedCount, Math.ceil(selectedCount * 1.25));
      const data = new Float32Array(capacity * 6);
      const geometry = new BufferGeometry();
      const attribute = new BufferAttribute(data, 3);
      attribute.setUsage(DynamicDrawUsage);
      geometry.setAttribute('position', attribute);
      geometry.setDrawRange(0, 0);
      geometry.boundingSphere = new Sphere(new Vector3(), Infinity);

      const lines = new LineSegments(geometry, this.fallbackMaterial);
      lines.name = 'edges-selected-thin';
      lines.frustumCulled = false;
      lines.renderOrder = 3;
      lines.visible = false;
      this.group.add(lines);

      this.fallbackGeometry = geometry;
      this.fallbackData = data;
      this.fallbackCapacity = capacity;
      this.fallbackLines = lines;
    }

    const data = this.fallbackData;
    const geometry = this.fallbackGeometry;
    const lines = this.fallbackLines;
    if (!data || !geometry || !lines) return;

    const positions = table.position;
    let offset = 0;
    for (let i = 0; i < count; i++) {
      if (!selection[i]) continue;
      const p = i * 6;
      data[offset] = positions[p];
      data[offset + 1] = positions[p + 1];
      data[offset + 2] = positions[p + 2];
      data[offset + 3] = positions[p + 3];
      data[offset + 4] = positions[p + 4];
      data[offset + 5] = positions[p + 5];
      offset += 6;
    }

    const attribute = geometry.getAttribute('position') as BufferAttribute;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, offset);
    attribute.needsUpdate = true;
    geometry.setDrawRange(0, selectedCount * 2);
    lines.visible = true;

    this.hideFat(true);
  }

  /** Hide the fat layer; optionally keep the thin fallback untouched. */
  private hideFat(keepFallback = false): void {
    if (this.fatCore) this.fatCore.visible = false;
    if (this.fatGeometry) this.fatGeometry.instanceCount = 0;
    if (!keepFallback && this.fallbackLines) this.fallbackLines.visible = false;
  }

  private releaseTable(): void {
    this.group.clear();
    this.baseGeometry?.dispose();
    this.baseGeometry = null;
    this.baseLines = null;

    this.fatGeometry?.dispose();
    this.fatGeometry = null;
    this.fatBuffer = null;
    this.fatData = null;
    this.fatCore = null;

    this.releaseFallback();
    this.table = null;
    this.selection = null;
    this.edgeCount = 0;
  }

  private releaseFallback(): void {
    this.fallbackLines?.removeFromParent();
    this.fallbackGeometry?.dispose();
    this.fallbackGeometry = null;
    this.fallbackData = null;
    this.fallbackCapacity = 0;
    this.fallbackLines = null;
  }
}
