export type DbtCall =
  | { kind: 'ref'; name: string; packageName?: string; start: number; end: number }
  | { kind: 'source'; sourceName: string; table: string; start: number; end: number };

// ref('model'), ref("pkg", "model"), ref('model', v=2), dbt.ref("model") in Python models
const REF_RE =
  /\bref\s*\(\s*(['"])([^'"]+)\1(?:\s*,\s*(['"])([^'"]+)\3)?\s*(?:,\s*(?:v|version)\s*=\s*[^)]*)?\)/g;
const SOURCE_RE = /\bsource\s*\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3\s*\)/g;
const JINJA_COMMENT_RE = /\{#[\s\S]*?#\}/g;

/** Find every ref()/source() call in a file. Calls inside `{# jinja comments #}` are ignored. */
export function findCalls(text: string): DbtCall[] {
  // Blank out comments while keeping offsets stable.
  const clean = text.replace(JINJA_COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '));
  const calls: DbtCall[] = [];
  for (const m of clean.matchAll(REF_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    calls.push(
      m[4] !== undefined
        ? { kind: 'ref', packageName: m[2], name: m[4], start, end }
        : { kind: 'ref', name: m[2], start, end },
    );
  }
  for (const m of clean.matchAll(SOURCE_RE)) {
    const start = m.index!;
    calls.push({ kind: 'source', sourceName: m[2], table: m[4], start, end: start + m[0].length });
  }
  return calls.sort((a, b) => a.start - b.start);
}

/** The call whose text contains `offset`, if any. */
export function callAt(text: string, offset: number): DbtCall | undefined {
  return findCalls(text).find((c) => offset >= c.start && offset <= c.end);
}
