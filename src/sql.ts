import { DbtCall, findCalls } from './parse';

/**
 * A small, forgiving SQL parser: just enough structure (CTEs, subqueries, select
 * lists, from/join items, unions) to trace columns inside a dbt model.
 * It never throws; unknown syntax is skipped.
 */

export interface Token {
  kind: 'word' | 'quoted' | 'string' | 'number' | 'punct';
  text: string;
  /** Lower-cased name (quotes removed) for words and quoted identifiers; the raw text otherwise. */
  value: string;
  start: number;
  end: number;
}

export interface ColumnRef {
  /** Lower-cased column name. */
  name: string;
  /** Column name as written (without quotes). */
  display: string;
  /** Lower-cased table/alias qualifier (`o` in `o.amount`). */
  qualifier?: string;
  /** The token holding the column name. */
  token: Token;
}

export interface SelectItem {
  /** Source text of the expression (alias excluded). */
  expr: string;
  /** Lower-cased output name: the alias, or the column name of a bare column reference. */
  outName?: string;
  /** Output name as written. */
  display?: string;
  aliasToken?: Token;
  /** `*` or `alias.*`. */
  star?: { qualifier?: string };
  /** Column references in the expression (nested subqueries excluded). */
  refs: ColumnRef[];
  /** The expression is a single column reference (`col`, `t.col`). */
  direct: boolean;
  /** The expression contains Jinja that could not be seen through. */
  opaque: boolean;
}

export interface FromItem {
  /** Lower-cased name used to qualify columns: the alias, else the table name. */
  alias: string;
  /** Lower-cased dotted table name, for plain tables and CTE references. */
  tableName?: string;
  /** Table name as written. */
  display: string;
  /** Set when the item is `{{ ref(...) }}` / `{{ source(...) }}`. */
  call?: DbtCall;
  /** Set for `( subquery )`. */
  query?: Query;
  /** A table function (`flatten(...)`, `unnest(...)`): columns can't be traced. */
  func?: boolean;
}

export interface Select {
  start: number;
  end: number;
  /** The query this select belongs to (for CTE lookup). */
  query: Query;
  items: SelectItem[];
  from: FromItem[];
  /** Column references in join conditions, where, group by, having, qualify, order by. */
  refs: ColumnRef[];
}

export interface Query {
  parent?: Query;
  ctes: Map<string, Query>;
  /** One select per `union` branch. */
  branches: Select[];
}

export interface ParsedSql {
  root?: Query;
  /** Every select in the file, including CTEs and subqueries. */
  selects: Select[];
  tokens: Token[];
}

const JINJA_RE = /\{#[\s\S]*?#\}|\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g;
const PLACEHOLDER_RE = /^__([rj])(\d*)$/;

/**
 * Replace Jinja with SQL the parser understands, keeping every offset stable:
 * `{{ ref(...) }}` / `{{ source(...) }}` become `__r<n>` identifiers, other
 * expressions become `__j`, statements and comments become blanks.
 */
export function prepareSql(src: string): { text: string; calls: DbtCall[] } {
  const calls: DbtCall[] = [];
  const text = src.replace(JINJA_RE, (block: string) => {
    if (!block.startsWith('{{')) {
      return block.replace(/[^\n]/g, ' ');
    }
    const found = findCalls(block);
    const rest = found.length === 1 ? block.slice(0, found[0].start) + block.slice(found[0].end) : '';
    if (found.length === 1 && /^\{\{-?-?\}\}$/.test(rest.replace(/\s+/g, ''))) {
      calls.push(found[0]);
      return pad(`__r${calls.length - 1}`, block.length);
    }
    return pad('__j', block.length);
  });
  return { text, calls };
}

function pad(s: string, length: number): string {
  return s + ' '.repeat(Math.max(0, length - s.length));
}

export function tokenize(s: string): Token[] {
  const re =
    /(\s+)|(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\]|\\[\s\S]|'')*'?)|("(?:[^"]|"")*"?|`[^`]*`?)|([A-Za-z_À-￿][\w$À-￿]*)|(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|(::|\|\||<=|>=|<>|!=|=>|->>|->|\S)/y;
  const out: Token[] = [];
  let m: RegExpExecArray | null;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    if (m[1] !== undefined || m[2] !== undefined) {
      continue;
    }
    const text = m[0];
    const start = m.index;
    const end = start + text.length;
    if (m[3] !== undefined) {
      out.push({ kind: 'string', text, value: text, start, end });
    } else if (m[4] !== undefined) {
      const closed = text.length > 1 && text.endsWith(text[0]);
      const inner = text.slice(1, closed ? -1 : undefined).replace(/""/g, '"');
      out.push({ kind: 'quoted', text, value: inner.toLowerCase(), start, end });
    } else if (m[5] !== undefined) {
      out.push({ kind: 'word', text, value: text.toLowerCase(), start, end });
    } else if (m[6] !== undefined) {
      out.push({ kind: 'number', text, value: text, start, end });
    } else {
      out.push({ kind: 'punct', text, value: text, start, end });
    }
  }
  return out;
}

export function parseSql(src: string): ParsedSql {
  const { text, calls } = prepareSql(src);
  const tokens = tokenize(text);
  const parser = new Parser(tokens, src, calls);
  return { root: parser.parse(), selects: parser.selects, tokens };
}

/** Name of a token as written, without quotes. */
export function unquote(t: Token): string {
  return t.kind === 'quoted' ? t.text.slice(1, t.text.length > 1 && t.text.endsWith(t.text[0]) ? -1 : undefined) : t.text;
}

const SET_OPS = new Set(['union', 'except', 'intersect', 'minus']);
const CLAUSES = new Set(['where', 'group', 'having', 'qualify', 'order', 'limit', 'window', 'offset', 'fetch', ...SET_OPS]);
const JOINS = new Set(['join', 'left', 'right', 'full', 'inner', 'outer', 'cross', 'natural', 'lateral', 'semi', 'anti', 'asof', 'positional']);

/** Words that are never column references. */
const KEYWORDS = new Set([
  ...CLAUSES,
  ...JOINS,
  'select', 'from', 'with', 'recursive', 'as', 'on', 'using', 'by', 'and', 'or', 'not', 'null', 'true', 'false',
  'case', 'when', 'then', 'else', 'end', 'all', 'distinct', 'any', 'some', 'in', 'is', 'like', 'ilike', 'rlike',
  'regexp', 'similar', 'escape', 'between', 'exists', 'interval', 'over', 'partition', 'rows', 'range', 'groups',
  'preceding', 'following', 'current', 'row', 'unbounded', 'asc', 'desc', 'nulls', 'first', 'last', 'filter',
  'within', 'respect', 'ignore', 'collate', 'at', 'before', 'changes', 'top', 'values', 'array', 'exclude',
  'replace', 'rename', 'pivot', 'unpivot', 'for', 'tablesample', 'sample', 'match_recognize', 'current_date',
  'current_time', 'current_timestamp', 'localtime', 'localtimestamp', 'current_user', 'session_user', 'sysdate',
]);

/** `datediff(day, a, b)`, `extract(year from d)`: the date part is not a column. */
const DATE_FUNCS = new Set([
  'dateadd', 'datediff', 'date_add', 'date_diff', 'date_sub', 'date_trunc', 'datetrunc', 'date_part', 'datepart',
  'extract', 'timestampadd', 'timestampdiff', 'timestamp_add', 'timestamp_diff', 'timestamp_trunc', 'last_day',
  'datetime_add', 'datetime_diff', 'datetime_trunc', 'time_add', 'time_diff', 'time_trunc',
]);
const DATE_PARTS = new Set([
  'year', 'years', 'quarter', 'quarters', 'month', 'months', 'week', 'weeks', 'isoweek', 'day', 'days', 'dayofweek',
  'dayofyear', 'dow', 'doy', 'hour', 'hours', 'minute', 'minutes', 'second', 'seconds', 'millisecond',
  'milliseconds', 'microsecond', 'microseconds', 'nanosecond', 'epoch', 'yy', 'yyyy', 'mm', 'dd', 'hh', 'mi', 'ss',
]);

function isName(t: Token | undefined): t is Token {
  return !!t && (t.kind === 'word' || t.kind === 'quoted');
}

class Parser {
  private i = 0;
  readonly selects: Select[] = [];

  constructor(
    private readonly t: Token[],
    /** Original source (for expression text). */
    private readonly src: string,
    private readonly calls: DbtCall[],
  ) {}

  parse(): Query | undefined {
    let depth = 0;
    for (; this.i < this.t.length; this.i++) {
      if (this.punct('(')) {
        depth++;
      } else if (this.punct(')')) {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0 && (this.word('with') || this.word('select'))) {
        return this.query(undefined);
      }
    }
    return undefined;
  }

  private word(w: string, k = 0): boolean {
    const x = this.t[this.i + k];
    return x?.kind === 'word' && x.value === w;
  }

  private punct(p: string, k = 0): boolean {
    const x = this.t[this.i + k];
    return x?.kind === 'punct' && x.text === p;
  }

  private wordIn(set: Set<string>): boolean {
    const x = this.t[this.i];
    return x?.kind === 'word' && set.has(x.value);
  }

  private query(parent: Query | undefined): Query {
    const q: Query = { parent, ctes: new Map(), branches: [] };
    if (this.word('with')) {
      this.i++;
      if (this.word('recursive')) {
        this.i++;
      }
      while (isName(this.t[this.i])) {
        const name = this.t[this.i++].value;
        if (this.punct('(')) {
          this.group(q); // column list
        }
        for (const w of ['as', 'not', 'materialized']) {
          if (this.word(w)) {
            this.i++;
          }
        }
        if (!this.punct('(')) {
          break;
        }
        const body = this.group(q);
        if (body) {
          q.ctes.set(name, body);
        }
        if (!this.punct(',')) {
          break;
        }
        this.i++;
      }
    }
    for (;;) {
      if (this.punct('(') && (this.word('select', 1) || this.word('with', 1) || this.punct('(', 1))) {
        const sub = this.group(q);
        q.branches.push(...(sub?.branches ?? []));
      } else if (this.word('select')) {
        q.branches.push(this.select(q));
      } else {
        return q;
      }
      if (!this.wordIn(SET_OPS)) {
        return q;
      }
      this.i++;
      while (this.word('all') || this.word('distinct') || this.word('by') || this.word('name')) {
        this.i++;
      }
    }
  }

  /** Consume a parenthesized group; returns the subquery when the group is one. */
  private group(q: Query): Query | undefined {
    this.i++; // (
    const sub = this.word('select') || this.word('with') ? this.query(q) : undefined;
    while (this.i < this.t.length && !this.punct(')')) {
      if (this.punct('(')) {
        this.group(q);
      } else {
        this.i++;
      }
    }
    this.i++; // )
    return sub;
  }

  private select(q: Query): Select {
    const first = this.t[this.i++];
    const sel: Select = { start: first.start, end: first.end, query: q, items: [], from: [], refs: [] };
    this.selects.push(sel);
    if (this.word('distinct')) {
      this.i++;
      if (this.word('on') && this.punct('(', 1)) {
        this.i++;
        this.group(q);
      }
    } else if (this.word('all')) {
      this.i++;
    }
    if (this.word('top')) {
      this.i += 2;
    }

    let start = this.i;
    while (this.i < this.t.length) {
      const x = this.t[this.i];
      const prev = this.t[this.i - 1];
      if (x.kind === 'punct') {
        if (x.text === ')' || x.text === ';') {
          break;
        }
        if (x.text === ',') {
          this.item(sel, start, this.i);
          start = ++this.i;
          continue;
        }
        if (x.text === '(') {
          this.group(q);
          continue;
        }
      } else if (
        x.kind === 'word' &&
        ((x.value === 'from' && prev?.value !== 'distinct') || CLAUSES.has(x.value)) &&
        !(x.value === 'group' && prev?.value === 'within') &&
        !(x.value === 'except' && prev?.text === '*')
      ) {
        break;
      }
      this.i++;
    }
    this.item(sel, start, this.i);

    if (this.word('from')) {
      this.from(sel);
    }
    const rest = this.i;
    while (this.i < this.t.length && !this.punct(')') && !this.punct(';') && !this.wordIn(SET_OPS)) {
      if (this.punct('(')) {
        this.group(q);
      } else {
        this.i++;
      }
    }
    sel.refs.push(...this.refs(rest, this.i));
    sel.end = this.t[this.i - 1]?.end ?? sel.end;
    return sel;
  }

  private item(sel: Select, a: number, b: number): void {
    if (a >= b) {
      return;
    }
    const last = this.t[b - 1];
    const prev = b - 2 >= a ? this.t[b - 2] : undefined;
    let exprEnd = b;
    let aliasToken: Token | undefined;
    if (prev && isName(last) && prev.kind === 'word' && prev.value === 'as') {
      aliasToken = last;
      exprEnd = b - 2;
    } else if (prev && isName(last) && !(last.kind === 'word' && KEYWORDS.has(last.value)) && endsExpression(prev)) {
      aliasToken = last;
      exprEnd = b - 1;
    }
    if (exprEnd <= a) {
      return;
    }

    let k = a;
    let qualifier: string | undefined;
    while (isName(this.t[k]) && this.t[k + 1]?.text === '.') {
      qualifier = this.t[k].value;
      k += 2;
    }
    const star = k < exprEnd && this.t[k].text === '*' ? { qualifier } : undefined;

    const refs = star ? [] : this.refs(a, exprEnd);
    const span = refs.length === 1 ? this.spans.get(refs[0]) : undefined;
    const direct = !!span && span[0] === a && span[1] === exprEnd - 1;
    let opaque = false;
    for (let j = a; j < exprEnd; j++) {
      if (this.t[j].kind === 'word' && this.t[j].value === '__j') {
        opaque = true;
      }
    }
    sel.items.push({
      expr: this.src.slice(this.t[a].start, this.t[exprEnd - 1].end),
      outName: aliasToken?.value ?? (direct ? refs[0].name : undefined),
      display: aliasToken ? unquote(aliasToken) : direct ? refs[0].display : undefined,
      aliasToken,
      star,
      refs,
      direct,
      opaque,
    });
  }

  private from(sel: Select): void {
    this.i++; // from
    while (this.i < this.t.length) {
      const x = this.t[this.i];
      if (x.kind === 'punct' && (x.text === ')' || x.text === ';')) {
        return;
      }
      if (x.kind === 'word' && CLAUSES.has(x.value)) {
        return;
      }
      if (x.text === ',' || (x.kind === 'word' && JOINS.has(x.value))) {
        this.i++;
      } else if (this.word('on')) {
        this.i++;
        const a = this.i;
        this.condition(sel.query);
        sel.refs.push(...this.refs(a, this.i));
      } else if (this.word('using')) {
        this.i++;
        if (this.punct('(')) {
          const a = this.i;
          this.group(sel.query);
          sel.refs.push(...this.refs(a + 1, this.i - 1));
        }
      } else {
        const fi = this.fromItem(sel.query);
        if (fi) {
          sel.from.push(fi);
        }
      }
    }
  }

  /** Skip a join condition. */
  private condition(q: Query): void {
    while (this.i < this.t.length) {
      const x = this.t[this.i];
      if (x.kind === 'punct' && (x.text === ')' || x.text === ';' || x.text === ',')) {
        return;
      }
      if (x.kind === 'word' && (CLAUSES.has(x.value) || (JOINS.has(x.value) && !this.punct('(', 1)))) {
        return;
      }
      if (this.punct('(')) {
        this.group(q);
      } else {
        this.i++;
      }
    }
  }

  private fromItem(q: Query): FromItem | undefined {
    let fi: FromItem;
    if (this.punct('(')) {
      fi = { alias: '', display: '(subquery)', query: this.group(q) };
    } else if (isName(this.t[this.i])) {
      const parts = [this.t[this.i++]];
      while (this.punct('.') && isName(this.t[this.i + 1])) {
        parts.push(this.t[this.i + 1]);
        this.i += 2;
      }
      const lastPart = parts[parts.length - 1];
      const display = parts.map(unquote).join('.');
      if (this.punct('(')) {
        this.group(q);
        fi = { alias: lastPart.value, display, func: true };
      } else {
        const ph = parts.length === 1 ? PLACEHOLDER_RE.exec(parts[0].value) : null;
        const call = ph?.[1] === 'r' ? this.calls[Number(ph[2])] : undefined;
        fi = {
          alias: call ? (call.kind === 'ref' ? call.name : call.table).toLowerCase() : lastPart.value,
          tableName: call ? undefined : parts.map((p) => p.value).join('.'),
          display,
          call,
        };
      }
    } else {
      this.i++;
      return undefined;
    }
    if (this.word('as')) {
      this.i++;
    }
    const a = this.t[this.i];
    if (a && (a.kind === 'quoted' || (a.kind === 'word' && !KEYWORDS.has(a.value)))) {
      fi.alias = a.value;
      this.i++;
      if (this.punct('(')) {
        this.group(q); // column aliases
      }
    }
    return fi;
  }

  /** Token spans [first, last] of each collected reference. */
  private readonly spans = new WeakMap<ColumnRef, [number, number]>();

  /** Column references among tokens [a, b), skipping nested subqueries. */
  private refs(a: number, b: number): ColumnRef[] {
    const out: ColumnRef[] = [];
    for (let k = a; k < b; k++) {
      const x = this.t[k];
      if (x.kind === 'punct' && x.text === '(' && (this.t[k + 1]?.value === 'select' || this.t[k + 1]?.value === 'with')) {
        k = this.matching(k);
        continue;
      }
      if (!isName(x) || (x.kind === 'word' && (KEYWORDS.has(x.value) || PLACEHOLDER_RE.test(x.value)))) {
        continue;
      }
      const prev = this.t[k - 1];
      if (prev && (prev.text === '.' || prev.text === '::' || (prev.kind === 'word' && prev.value === 'as'))) {
        continue;
      }
      let e = k;
      while (this.t[e + 1]?.text === '.' && isName(this.t[e + 2])) {
        e += 2;
      }
      const next = this.t[e + 1];
      if (next && (next.text === '(' || next.text === '=>' || next.text === '->' || next.kind === 'string' || (next.text === '.' && this.t[e + 2]?.text === '*'))) {
        k = e;
        continue;
      }
      if (prev?.text === '(' && DATE_FUNCS.has(this.t[k - 2]?.value ?? '') && DATE_PARTS.has(x.value)) {
        continue;
      }
      const nameTok = this.t[e];
      const ref: ColumnRef = {
        name: nameTok.value,
        display: unquote(nameTok),
        qualifier: e > k ? this.t[e - 2].value : undefined,
        token: nameTok,
      };
      this.spans.set(ref, [k, e]);
      out.push(ref);
      k = e;
    }
    return out;
  }

  private matching(k: number): number {
    let depth = 0;
    for (let j = k; j < this.t.length; j++) {
      if (this.t[j].text === '(') {
        depth++;
      } else if (this.t[j].text === ')' && --depth === 0) {
        return j;
      }
    }
    return this.t.length;
  }
}

/** Can `t` be the last token of an expression (so that a following name is an implicit alias)? */
function endsExpression(t: Token): boolean {
  switch (t.kind) {
    case 'string':
    case 'number':
    case 'quoted':
      return true;
    case 'punct':
      return t.text === ')' || t.text === ']';
    case 'word':
      return !KEYWORDS.has(t.value) || ['end', 'null', 'true', 'false'].includes(t.value);
  }
}
