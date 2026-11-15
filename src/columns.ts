import * as fs from 'fs';
import { DbtNode, LineageGraph } from './graph';
import { DbtCall } from './parse';
import { ColumnRef, FromItem, Query, Select, SelectItem, Token, parseSql } from './sql';

export interface ColumnOrigin {
  /** The direct upstream (model, seed, snapshot, source, or a plain table). */
  node: DbtNode;
  /** Column name in that upstream. */
  column: string;
}

export interface ColumnLineage {
  /** The hovered column, as written. */
  column: string;
  /** `direct`: passed through (possibly renamed) from an upstream; `transformation`: computed from upstream columns. */
  kind: 'direct' | 'transformation';
  origins: ColumnOrigin[];
  /** For transformations: the expression that computes the column. */
  expression?: string;
  /** Several upstreams could provide the column and dbt-nav could not tell which. */
  ambiguous: boolean;
  /** Part of the lineage could not be traced (Jinja, table functions, unknown columns). */
  unresolved: boolean;
  /** Offsets of the hovered token. */
  start: number;
  end: number;
}

export interface ColumnContext {
  /** Resolve a `ref()` / `source()` call of the current file. */
  resolve(call: DbtCall): DbtNode | undefined;
  /** Output columns of an upstream node (lower-cased), or undefined when unknown. */
  columnsOf(node: DbtNode): string[] | undefined;
}

interface Trace {
  direct: boolean;
  origins: ColumnOrigin[];
  expression?: string;
  ambiguous: boolean;
  unresolved: boolean;
}

const MAX_DEPTH = 40;

const unresolved = (): Trace => ({ direct: true, origins: [], ambiguous: false, unresolved: true });

/** Lineage of the column under `offset`, or undefined when the offset isn't on a column. */
export function columnLineageAt(text: string, offset: number, ctx: ColumnContext): ColumnLineage | undefined {
  const parsed = parseSql(text);
  const tok = parsed.tokens.find((t) => offset >= t.start && offset < t.end);
  if (!tok || (tok.kind !== 'word' && tok.kind !== 'quoted')) {
    return undefined;
  }
  // Innermost select around the token.
  let sel: Select | undefined;
  for (const s of parsed.selects) {
    if (s.start <= tok.start && tok.end <= s.end && (!sel || s.end - s.start < sel.end - sel.start)) {
      sel = s;
    }
  }
  if (!sel) {
    return undefined;
  }
  const tracer = new Tracer(ctx);
  const done = (t: Trace, column: string): ColumnLineage => ({
    column,
    kind: t.direct ? 'direct' : 'transformation',
    origins: t.origins,
    expression: t.direct ? undefined : t.expression,
    ambiguous: t.ambiguous,
    unresolved: t.unresolved,
    start: tok.start,
    end: tok.end,
  });

  const item = sel.items.find((it) => it.aliasToken === tok || (it.direct && it.refs[0].token === tok));
  if (item) {
    return done(tracer.item(sel, item, 0), item.display ?? item.expr);
  }
  const ref = findRef(sel, tok);
  return ref ? done(tracer.ref(sel, ref, 0), ref.display) : undefined;
}

/** Output columns of a model's SQL (lower-cased), or undefined when they can't be determined. */
export function outputColumns(text: string, ctx: ColumnContext): string[] | undefined {
  const { root } = parseSql(text);
  return root ? new Tracer(ctx).queryColumns(root, 0) : undefined;
}

function findRef(sel: Select, tok: Token): ColumnRef | undefined {
  for (const it of sel.items) {
    const r = it.refs.find((x) => x.token === tok);
    if (r) {
      return r;
    }
  }
  return sel.refs.find((x) => x.token === tok);
}

function merge(into: Trace, t: Trace): void {
  for (const o of t.origins) {
    if (!into.origins.some((x) => x.node.id === o.node.id && x.column.toLowerCase() === o.column.toLowerCase())) {
      into.origins.push(o);
    }
  }
  into.direct &&= t.direct;
  into.ambiguous ||= t.ambiguous;
  into.unresolved ||= t.unresolved;
  into.expression ??= t.expression;
}

function lookupCte(q: Query | undefined, name: string): Query | undefined {
  for (let x = q; x; x = x.parent) {
    const cte = x.ctes.get(name);
    if (cte) {
      return cte;
    }
  }
  return undefined;
}

class Tracer {
  constructor(private readonly ctx: ColumnContext) {}

  item(sel: Select, item: SelectItem, depth: number): Trace {
    if (item.direct) {
      return this.ref(sel, item.refs[0], depth);
    }
    const t: Trace = { direct: false, origins: [], expression: item.expr, ambiguous: false, unresolved: item.opaque };
    for (const r of item.refs) {
      merge(t, this.ref(sel, r, depth + 1));
    }
    return t;
  }

  ref(sel: Select, ref: ColumnRef, depth: number): Trace {
    if (depth > MAX_DEPTH) {
      return unresolved();
    }
    const q = ref.qualifier;
    const fis = q
      ? sel.from.filter((f) => f.alias === q || f.tableName === q || f.tableName?.endsWith(`.${q}`))
      : sel.from;
    // A select-list alias reused elsewhere (`order by total`, lateral aliases).
    const aliased = q ? undefined : sel.items.find((it) => it.outName === ref.name && !it.refs.includes(ref));
    const inSelectList = sel.items.some((it) => it.refs.includes(ref));

    let from = fis;
    let ambiguous = false;
    if (fis.length > 1 || aliased) {
      const { known, unknown } = this.split(sel, fis, ref.name, depth);
      if (known.length) {
        from = known;
        ambiguous = known.length > 1;
      } else if (aliased && (!inSelectList || unknown.length === 0)) {
        // Outside the select list the alias wins; inside it, upstream columns win.
        return this.item(sel, aliased, depth + 1);
      } else if (unknown.length) {
        from = unknown;
        ambiguous = unknown.length > 1;
      } else {
        ambiguous = fis.length > 1;
      }
    }
    if (from.length === 0) {
      return unresolved();
    }
    const t: Trace = { direct: true, origins: [], ambiguous, unresolved: false };
    for (const fi of from) {
      merge(t, this.fromItem(sel, fi, ref.name, ref.display, depth + 1));
    }
    return t;
  }

  /** Split from-items into those known to provide column `name` and those whose columns are unknown. */
  private split(sel: Select, fis: FromItem[], name: string, depth: number): { known: FromItem[]; unknown: FromItem[] } {
    const known: FromItem[] = [];
    const unknown: FromItem[] = [];
    for (const fi of fis) {
      const cols = this.columns(sel, fi, depth + 1);
      if (!cols) {
        unknown.push(fi);
      } else if (cols.includes(name)) {
        known.push(fi);
      }
    }
    return { known, unknown };
  }

  private fromItem(sel: Select, fi: FromItem, name: string, display: string, depth: number): Trace {
    if (fi.call) {
      return { direct: true, origins: [{ node: this.node(fi.call), column: display }], ambiguous: false, unresolved: false };
    }
    if (fi.func) {
      return unresolved();
    }
    const q = fi.query ?? (fi.tableName ? lookupCte(sel.query, fi.tableName) : undefined);
    if (q) {
      return this.output(q, name, display, depth + 1);
    }
    if (!fi.tableName) {
      return unresolved();
    }
    const node: DbtNode = { id: `table.${fi.tableName}`, name: fi.display, resourceType: 'table', packageName: '' };
    return { direct: true, origins: [{ node, column: display }], ambiguous: false, unresolved: false };
  }

  /** Trace output column `name` of a CTE or subquery. */
  private output(q: Query, name: string, display: string, depth: number): Trace {
    const [first, ...rest] = q.branches;
    if (!first || depth > MAX_DEPTH) {
      return unresolved();
    }
    const idx = first.items.findIndex((it) => it.outName === name);
    if (idx >= 0) {
      const t = this.item(first, first.items[idx], depth + 1);
      // Union branches line up by position.
      if (!first.items.slice(0, idx).some((it) => it.star || it.opaque)) {
        for (const b of rest) {
          const it = b.items[idx];
          if (it && !it.star) {
            merge(t, this.item(b, it, depth + 1));
          }
        }
      }
      return t;
    }
    const stars = first.items.filter((it) => it.star);
    const fis = new Set<FromItem>();
    for (const s of stars) {
      const qual = s.star!.qualifier;
      for (const f of first.from) {
        if (!qual || f.alias === qual || f.tableName === qual || f.tableName?.endsWith(`.${qual}`)) {
          fis.add(f);
        }
      }
    }
    const { known, unknown } = this.split(first, [...fis], name, depth);
    const from = known.length ? known : unknown;
    if (!from.length) {
      return unresolved();
    }
    const t: Trace = { direct: true, origins: [], ambiguous: from.length > 1, unresolved: false };
    for (const fi of from) {
      merge(t, this.fromItem(first, fi, name, display, depth + 1));
    }
    return t;
  }

  private columns(sel: Select, fi: FromItem, depth: number): string[] | undefined {
    if (fi.call) {
      const node = this.ctx.resolve(fi.call);
      return node ? this.ctx.columnsOf(node) : undefined;
    }
    const q = fi.query ?? (fi.tableName ? lookupCte(sel.query, fi.tableName) : undefined);
    return q ? this.queryColumns(q, depth + 1) : undefined;
  }

  queryColumns(q: Query, depth: number): string[] | undefined {
    const first = q.branches[0];
    if (!first || depth > MAX_DEPTH) {
      return undefined;
    }
    const out: string[] = [];
    for (const it of first.items) {
      if (it.star) {
        const qual = it.star.qualifier;
        for (const f of first.from) {
          if (!qual || f.alias === qual || f.tableName === qual || f.tableName?.endsWith(`.${qual}`)) {
            const cols = this.columns(first, f, depth + 1);
            if (!cols) {
              return undefined;
            }
            out.push(...cols);
          }
        }
      } else if (it.outName) {
        out.push(it.outName);
      } else if (it.opaque) {
        return undefined;
      }
    }
    return out;
  }

  private node(call: DbtCall): DbtNode {
    return (
      this.ctx.resolve(call) ?? {
        id: `missing.${call.kind === 'ref' ? call.name : `${call.sourceName}.${call.table}`}`,
        name: call.kind === 'ref' ? call.name : call.table,
        sourceName: call.kind === 'source' ? call.sourceName : undefined,
        resourceType: call.kind === 'ref' ? 'model' : 'source',
        packageName: (call.kind === 'ref' && call.packageName) || '',
        missing: true,
      }
    );
  }
}

const columnCache = new WeakMap<LineageGraph, Map<string, string[] | undefined>>();

/**
 * A ColumnContext backed by the lineage graph. Upstream columns come from the
 * upstream model's SQL, a seed's CSV header, or columns documented in YAML (manifest).
 * Results are cached per graph, which is rebuilt whenever project files change.
 */
export function columnContext(graph: LineageGraph, fromPackage?: string): ColumnContext {
  let memo = columnCache.get(graph);
  if (!memo) {
    memo = new Map();
    columnCache.set(graph, memo);
  }
  const cache = memo;
  const visiting = new Set<string>();
  const resolver = (pkg?: string) => (call: DbtCall) =>
    call.kind === 'ref' ? graph.resolveRef(call.name, call.packageName, pkg) : graph.resolveSource(call.sourceName, call.table);

  const columnsOf = (node: DbtNode): string[] | undefined => {
    if (cache.has(node.id)) {
      return cache.get(node.id);
    }
    if (visiting.has(node.id)) {
      return undefined;
    }
    visiting.add(node.id);
    try {
      const cols = readColumns(node, { resolve: resolver(node.packageName), columnsOf });
      cache.set(node.id, cols);
      return cols;
    } finally {
      visiting.delete(node.id);
    }
  };
  return { resolve: resolver(fromPackage ?? graph.rootPackage), columnsOf };
}

function readColumns(node: DbtNode, ctx: ColumnContext): string[] | undefined {
  const file = node.filePath;
  if (file && node.resourceType === 'model' && file.endsWith('.sql')) {
    const text = readFile(file);
    const cols = text === undefined ? undefined : outputColumns(text, ctx);
    if (cols) {
      return cols;
    }
  }
  if (file && node.resourceType === 'seed') {
    const header = readFile(file)?.split(/\r?\n/, 1)[0];
    if (header) {
      return header.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1').toLowerCase());
    }
  }
  return node.columns?.length ? node.columns.map((c) => c.toLowerCase()) : undefined;
}

function readFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
