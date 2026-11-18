import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { LineageGraph, UpstreamEntry } from '../graph';
import { graphFromManifest } from '../manifest';
import { renderLineage } from '../render';
import { scanProject } from '../scanner';

const FIXTURE = path.resolve(__dirname, '../../test-fixtures/jaffle');

/** Compact string form of an upstream tree: `a(b,c(d))`. */
function shape(entries: UpstreamEntry[]): string {
  return entries
    .map((e) => e.node.name + (e.repeated ? '^' : '') + (e.parents.length ? `(${shape(e.parents)})` : ''))
    .join(',');
}

test('scanner: upstream contains every ancestor, expanded once', () => {
  const g = scanProject(FIXTURE);
  const fct = g.resolveRef('fct_orders')!;
  const up = g.upstreamTree(fct.id);
  // stg_orders is reached twice (directly and via int_orders): the second sighting is not re-expanded.
  assert.equal(shape(up.roots), 'calendar,int_orders(stg_orders(orders),stg_payments(raw_payments)),stg_customers(customers),stg_orders^');
  assert.equal(up.totalAncestors, 8);
  assert.equal(up.truncated, false);
});

test('scanner: downstream lists only direct children', () => {
  const g = scanProject(FIXTURE);
  const stg = g.resolveRef('stg_customers')!;
  assert.deepEqual(g.downstream(stg.id).map((n) => n.name), ['dim_customers', 'fct_orders']);
  const fct = g.resolveRef('fct_orders')!;
  assert.deepEqual(g.downstream(fct.id).map((n) => n.name), ['customer_ml', 'dim_customers']);
});

test('scanner: resolves package refs, seeds, and ignores commented refs', () => {
  const g = scanProject(FIXTURE);
  assert.equal(g.resolveRef('calendar')?.packageName, 'utils');
  assert.equal(g.resolveRef('raw_payments')?.resourceType, 'seed');
  assert.equal(g.resolveRef('commented_out'), undefined);
  assert.ok(g.nodeForFile(path.join(FIXTURE, 'models/marts/fct_orders.sql')));
});

test('upstream respects maxDepth and maxNodes', () => {
  const g = scanProject(FIXTURE);
  const fct = g.resolveRef('fct_orders')!;
  const shallow = g.upstreamTree(fct.id, { maxDepth: 1 });
  assert.equal(shape(shallow.roots), 'calendar,int_orders,stg_customers,stg_orders');
  assert.ok(shallow.roots.find((r) => r.node.name === 'int_orders')!.depthLimited);
  assert.equal(shallow.totalAncestors, 8);

  const capped = g.upstreamTree(fct.id, { maxNodes: 3 });
  assert.equal(capped.truncated, true);
});

test('cycles do not loop forever', () => {
  const g = new LineageGraph('p');
  for (const n of ['a', 'b']) {
    g.addNode({ id: n, name: n, resourceType: 'model', packageName: 'p' });
  }
  g.addEdge('a', 'b');
  g.addEdge('b', 'a');
  assert.equal(shape(g.upstreamTree('a').roots), 'b(a^)');
});

test('manifest: builds graph from parent_map and filters tests downstream', () => {
  const manifest = {
    metadata: { project_name: 'shop' },
    nodes: {
      'model.shop.stg': { name: 'stg', resource_type: 'model', package_name: 'shop', original_file_path: 'models/stg.sql' },
      'model.shop.fct': { name: 'fct', resource_type: 'model', package_name: 'shop' },
      'model.shop.dim.v1': { name: 'dim', resource_type: 'model', package_name: 'shop' },
      'model.shop.dim.v2': { name: 'dim', resource_type: 'model', package_name: 'shop' },
      'test.shop.not_null_stg_id': { name: 'not_null_stg_id', resource_type: 'test', package_name: 'shop' },
    },
    sources: {
      'source.shop.raw.orders': { name: 'orders', source_name: 'raw', resource_type: 'source', package_name: 'shop' },
    },
    exposures: {
      'exposure.shop.dash': { name: 'dash', resource_type: 'exposure', package_name: 'shop' },
    },
    parent_map: {
      'model.shop.stg': ['source.shop.raw.orders'],
      'model.shop.fct': ['model.shop.stg'],
      'test.shop.not_null_stg_id': ['model.shop.stg'],
      'exposure.shop.dash': ['model.shop.stg'],
      'source.shop.raw.orders': [],
    },
  };
  const g = graphFromManifest(manifest, '/nonexistent', 'shop');
  assert.equal(g.resolveRef('dim')?.id, 'model.shop.dim.v2');
  assert.equal(g.resolveSource('raw', 'orders')?.id, 'source.shop.raw.orders');
  assert.deepEqual(g.downstream('model.shop.stg').map((n) => n.name), ['fct', 'dash']);
  assert.deepEqual(g.downstream('model.shop.stg', true).map((n) => n.name), ['fct', 'dash', 'not_null_stg_id']);
  assert.equal(shape(g.upstreamTree('model.shop.fct').roots), 'stg(orders)');
});

test('render: nested upstream, flat downstream, links', () => {
  const g = scanProject(FIXTURE);
  const md = renderLineage(g, g.resolveRef('int_orders')!, { linkFor: (n) => (n.filePath ? `file://${n.name}` : undefined) });
  assert.match(md, /Upstream\*\* — 4 ancestors/);
  assert.match(md, /^- \$\(table\) \[stg\\_orders\]\(file:\/\/stg_orders\)$/m);
  assert.match(md, /^ {2}- \$\(database\) raw\.orders `source`$/m);
  assert.match(md, /Downstream\*\* — 1 direct child/);
  assert.match(md, /^- \$\(table\) \[fct\\_orders\]/m);
});

test('graph: resolveSource finds sources by source name and table', () => {
  const g = new LineageGraph('proj');
  const src = { id: 'source.proj.raw.orders', name: 'orders', resourceType: 'source', packageName: 'proj', sourceName: 'raw' };
  g.addNode(src);
  assert.equal(g.resolveSource('raw', 'orders'), src);
  assert.equal(g.resolveSource('raw', 'missing'), undefined);
  assert.equal(g.resolveSource('other', 'orders'), undefined);
});

test('graph: same table name under different sources resolves independently', () => {
  const g = new LineageGraph('proj');
  const a = { id: 'source.proj.a.orders', name: 'orders', resourceType: 'source', packageName: 'proj', sourceName: 'a' };
  const b = { id: 'source.proj.b.orders', name: 'orders', resourceType: 'source', packageName: 'proj', sourceName: 'b' };
  g.addNode(a);
  g.addNode(b);
  assert.equal(g.resolveSource('a', 'orders'), a);
  assert.equal(g.resolveSource('b', 'orders'), b);
});
