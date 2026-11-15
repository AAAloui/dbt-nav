/** A node in the dbt DAG (model, seed, snapshot, source, test, exposure, ...). */
export interface DbtNode {
  /** Unique id, e.g. `model.jaffle_shop.stg_orders` or `source.jaffle_shop.raw.orders`. */
  id: string;
  /** Short name, e.g. `stg_orders` (for sources: the table name). */
  name: string;
  resourceType: string;
  packageName: string;
  /** For sources only: the source name (the first argument of `source()`). */
  sourceName?: string;
  /** Absolute path of the file that defines the node, when known. */
  filePath?: string;
  /** Column names documented in YAML (manifest only). */
  columns?: string[];
  /** True for nodes referenced by a ref()/source() that could not be resolved. */
  missing?: boolean;
}

export interface UpstreamEntry {
  node: DbtNode;
  /** Parents of this node (empty when `repeated` or when the depth limit was hit). */
  parents: UpstreamEntry[];
  /** The node was already expanded earlier in the tree (diamond dependency). */
  repeated: boolean;
  /** The node has parents that were not expanded because of `maxDepth`. */
  depthLimited: boolean;
}

export interface UpstreamTree {
  roots: UpstreamEntry[];
  /** Number of distinct ancestors, regardless of display limits. */
  totalAncestors: number;
  /** True when `maxNodes` stopped the tree from being fully rendered. */
  truncated: boolean;
}

export interface UpstreamOptions {
  /** 0 or undefined = unlimited. */
  maxDepth?: number;
  /** Maximum number of entries in the tree. */
  maxNodes?: number;
}

const REFABLE = new Set(['model', 'seed', 'snapshot']);

const TYPE_ORDER: Record<string, number> = {
  model: 0,
  snapshot: 1,
  seed: 2,
  source: 3,
  semantic_model: 4,
  metric: 5,
  saved_query: 6,
  exposure: 7,
  analysis: 8,
  test: 9,
  unit_test: 10,
};

export function compareNodes(a: DbtNode, b: DbtNode): number {
  const ta = TYPE_ORDER[a.resourceType] ?? 99;
  const tb = TYPE_ORDER[b.resourceType] ?? 99;
  return ta - tb || displayName(a).localeCompare(displayName(b));
}

export function displayName(n: DbtNode): string {
  return n.resourceType === 'source' && n.sourceName ? `${n.sourceName}.${n.name}` : n.name;
}

export class LineageGraph {
  readonly nodes = new Map<string, DbtNode>();
  private readonly parentIds = new Map<string, Set<string>>();
  private readonly childIds = new Map<string, Set<string>>();
  private readonly byPath = new Map<string, DbtNode>();
  private readonly byName = new Map<string, DbtNode[]>();

  constructor(
    /** Name of the root dbt project; refs from unknown files resolve against it first. */
    readonly rootPackage: string,
  ) {}

  addNode(node: DbtNode): void {
    this.nodes.set(node.id, node);
    if (REFABLE.has(node.resourceType)) {
      if (node.filePath) {
        this.byPath.set(node.filePath, node);
      }
      const same = this.byName.get(node.name) ?? [];
      same.push(node);
      this.byName.set(node.name, same);
    }
  }

  addEdge(parentId: string, childId: string): void {
    if (parentId === childId) {
      return;
    }
    getOrCreate(this.parentIds, childId).add(parentId);
    getOrCreate(this.childIds, parentId).add(childId);
  }

  getParents(id: string): DbtNode[] {
    return this.lookup(this.parentIds.get(id));
  }

  getChildren(id: string): DbtNode[] {
    return this.lookup(this.childIds.get(id));
  }

  nodeForFile(filePath: string): DbtNode | undefined {
    return this.byPath.get(filePath);
  }

  /**
   * Resolve `ref('name')` / `ref('package', 'name')`. Without an explicit
   * package, the caller's package wins, then the root project, then anything.
   */
  resolveRef(name: string, packageName?: string, fromPackage?: string): DbtNode | undefined {
    const candidates = this.byName.get(name) ?? [];
    if (packageName) {
      return pickLatest(candidates.filter((n) => n.packageName === packageName));
    }
    for (const pkg of [fromPackage, this.rootPackage]) {
      const match = pickLatest(candidates.filter((n) => n.packageName === pkg));
      if (match) {
        return match;
      }
    }
    return pickLatest(candidates);
  }

  resolveSource(sourceName: string, table: string): DbtNode | undefined {
    for (const n of this.nodes.values()) {
      if (n.resourceType === 'source' && n.sourceName === sourceName && n.name === table) {
        return n;
      }
    }
    return undefined;
  }

  /** Every ancestor of `id`, as a tree. Each ancestor is expanded once; later sightings are marked `repeated`. */
  upstreamTree(id: string, opts: UpstreamOptions = {}): UpstreamTree {
    const maxDepth = opts.maxDepth && opts.maxDepth > 0 ? opts.maxDepth : Infinity;
    const maxNodes = opts.maxNodes && opts.maxNodes > 0 ? opts.maxNodes : Infinity;
    const expanded = new Set<string>([id]);
    let emitted = 0;
    let truncated = false;

    const build = (nodeId: string, depth: number): UpstreamEntry[] => {
      const out: UpstreamEntry[] = [];
      for (const parent of this.getParents(nodeId).sort(compareNodes)) {
        if (emitted >= maxNodes) {
          truncated = true;
          break;
        }
        emitted++;
        const repeated = expanded.has(parent.id);
        const hasParents = (this.parentIds.get(parent.id)?.size ?? 0) > 0;
        const entry: UpstreamEntry = { node: parent, parents: [], repeated, depthLimited: false };
        if (!repeated) {
          expanded.add(parent.id);
          if (depth < maxDepth) {
            entry.parents = build(parent.id, depth + 1);
          } else {
            entry.depthLimited = hasParents;
          }
        }
        out.push(entry);
      }
      return out;
    };

    const roots = build(id, 1);
    return { roots, totalAncestors: this.countAncestors(id), truncated };
  }

  /** Direct children only, optionally without tests. */
  downstream(id: string, includeTests = false): DbtNode[] {
    return this.getChildren(id)
      .filter((n) => includeTests || (n.resourceType !== 'test' && n.resourceType !== 'unit_test'))
      .sort(compareNodes);
  }

  private countAncestors(id: string): number {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      for (const p of this.parentIds.get(stack.pop()!) ?? []) {
        if (p !== id && !seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return seen.size;
  }

  private lookup(ids: Set<string> | undefined): DbtNode[] {
    const out: DbtNode[] = [];
    for (const id of ids ?? []) {
      const n = this.nodes.get(id);
      if (n) {
        out.push(n);
      }
    }
    return out;
  }
}

function getOrCreate<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  return s;
}

/** Versioned models share a name (`model.pkg.dim_customers.v2`); prefer the highest version id. */
function pickLatest(nodes: DbtNode[]): DbtNode | undefined {
  if (nodes.length <= 1) {
    return nodes[0];
  }
  return [...nodes].sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
}
