/**
 * Small, allocation-free union-find used by orientation, non-manifold vertex
 * detection, shell extraction and metadata. Deterministic: unions are always
 * performed with the lower root as the parent when ranks tie, so the same mesh
 * produces the same component numbering on every run.
 */
export class UnionFind {
  readonly parent: Int32Array;
  private readonly rank: Uint8Array;

  constructor(count: number) {
    this.parent = new Int32Array(count);
    this.rank = new Uint8Array(count);
    for (let i = 0; i < count; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    let node = x;
    while (this.parent[node] !== node) {
      const next = this.parent[node];
      this.parent[node] = root;
      node = next;
    }
    return root;
  }

  union(a: number, b: number): boolean {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb]) {
      const tmp = ra;
      ra = rb;
      rb = tmp;
    }
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
    return true;
  }
}
