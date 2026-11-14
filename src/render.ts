import { DbtNode, LineageGraph, UpstreamEntry, UpstreamOptions, displayName } from './graph';

export interface RenderOptions extends UpstreamOptions {
  includeTests?: boolean;
  /** Returns a link target for a node (e.g. a file URI), or undefined for plain text. */
  linkFor?: (node: DbtNode) => string | undefined;
}

const ICONS: Record<string, string> = {
  model: '$(table)',
  seed: '$(symbol-file)',
  snapshot: '$(history)',
  source: '$(database)',
  exposure: '$(dashboard)',
  metric: '$(graph)',
  semantic_model: '$(symbol-structure)',
  saved_query: '$(bookmark)',
  analysis: '$(notebook)',
  test: '$(beaker)',
  unit_test: '$(beaker)',
};

/** Markdown (with codicons) for a hover: all ancestors as a tree, direct children as a flat list. */
export function renderLineage(graph: LineageGraph, node: DbtNode, opts: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push(`${icon(node)} **${escape(displayName(node))}** \`${node.resourceType}\` · \`${escape(node.packageName)}\``);
  if (node.missing) {
    lines.push('', `_Not found in the dbt project._`);
    return lines.join('\n');
  }

  const up = graph.upstreamTree(node.id, opts);
  lines.push('', `**$(arrow-up) Upstream** — ${plural(up.totalAncestors, 'ancestor')}`, '');
  if (up.roots.length === 0) {
    lines.push('_No upstream dependencies._');
  } else {
    renderTree(up.roots, 0, lines, opts);
    if (up.truncated) {
      lines.push('', `_…truncated (increase \`dbtNav.upstream.maxNodes\` to see more)._`);
    }
  }

  const down = graph.downstream(node.id, opts.includeTests);
  lines.push('', '---', '', `**$(arrow-down) Downstream** — ${plural(down.length, 'direct child', 'direct children')}`, '');
  if (down.length === 0) {
    lines.push('_No downstream dependents._');
  } else {
    for (const child of down) {
      lines.push(`- ${item(child, opts)}`);
    }
  }
  return lines.join('\n');
}

function renderTree(entries: UpstreamEntry[], depth: number, lines: string[], opts: RenderOptions): void {
  const indent = '  '.repeat(depth);
  for (const e of entries) {
    let suffix = '';
    if (e.repeated) {
      suffix = ' _(see above)_';
    } else if (e.depthLimited) {
      suffix = ' _…_';
    }
    lines.push(`${indent}- ${item(e.node, opts)}${suffix}`);
    renderTree(e.parents, depth + 1, lines, opts);
  }
}

function item(node: DbtNode, opts: RenderOptions): string {
  const name = escape(displayName(node));
  const link = opts.linkFor?.(node);
  const label = link ? `[${name}](${link})` : name;
  const missing = node.missing ? ' _(not found)_' : '';
  const type = node.resourceType === 'model' ? '' : ` \`${node.resourceType}\``;
  return `${icon(node)} ${label}${type}${missing}`;
}

function icon(node: DbtNode): string {
  return ICONS[node.resourceType] ?? '$(circle-outline)';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Escape characters that markdown would interpret in node names. */
export function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]()<>#+!|$]/g, (c) => `\\${c}`);
}
