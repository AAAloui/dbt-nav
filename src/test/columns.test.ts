import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { ColumnContext, ColumnLineage, columnContext, columnLineageAt } from '../columns';
import { DbtNode } from '../graph';
import { renderColumnLineage } from '../render';
import { scanProject } from '../scanner';

const FIXTURE = path.resolve(__dirname, '../../test-fixtures/jaffle');

/** A context where every ref/source resolves, with optional known upstream columns. */
function ctx(columns: Record<string, string[]> = {}): ColumnContext {
  return {
    resolve: (call) => {
      const name = call.kind === 'ref' ? call.name : `${call.sourceName}.${call.table}`;
      return { id: name, name, resourceType: call.kind === 'ref' ? 'model' : 'source', packageName: 'p' } as DbtNode;
    },
    columnsOf: (node) => columns[node.id],
  };
}

/** Hover the `n`-th occurrence (0-based) of `word` in `sql`. */
function hover(sql: string, word: string, c = ctx(), n = 0): ColumnLineage | undefined {
  let at = -1;
  for (let i = 0; i <= n; i++) {
    at = sql.indexOf(word, at + 1);
  }
  assert.ok(at >= 0, `"${word}" not in sql`);
  return columnLineageAt(sql, at, c);
}

const origins = (l: ColumnLineage | undefined) => l?.origins.map((o) => `${o.node.name}.${o.column}`);

test('column taken as-is from a ref is direct', () => {
  const sql = `select p.amount, o.order_id from {{ ref('stg_payments') }} p join {{ ref('stg_orders') }} o using (order_id)`;
  const l = hover(sql, 'amount');
  assert.equal(l?.kind, 'direct');
  assert.deepEqual(origins(l), ['stg_payments.amount']);
  assert.equal(l?.ambiguous, false);
});

test('renamed column is still direct', () => {
  const l = hover(`select customer_id as id from {{ source('raw', 'customers') }}`, 'id');
  assert.equal(l?.kind, 'direct');
  assert.equal(l?.column, 'id');
  assert.deepEqual(origins(l), ['raw.customers.customer_id']);
});

test('computed column is a transformation of its inputs', () => {
  const sql = `select sum(p.amount) - max(o.discount) as net from {{ ref('pay') }} p join {{ ref('ord') }} o on p.order_id = o.id group by 1`;
  const l = hover(sql, 'net');
  assert.equal(l?.kind, 'transformation');
  assert.deepEqual(origins(l), ['pay.amount', 'ord.discount']);
  assert.equal(l?.expression, 'sum(p.amount) - max(o.discount)');
});

test('literal is a transformation with no upstream column', () => {
  const l = hover(`select 'web' as channel, id from {{ ref('a') }}`, 'channel');
  assert.equal(l?.kind, 'transformation');
  assert.deepEqual(l?.origins, []);
  assert.match(renderColumnLineage(l!), /uses no upstream column/);
});

test('traces through CTEs to the upstream ref', () => {
  const sql = `
    with orders as (select * from {{ ref('stg_orders') }}),
    renamed as (select order_id as id, amount * 2 as doubled from orders)
    select id, doubled, r.id as again from renamed r`;
  assert.deepEqual(origins(hover(sql, 'id', ctx(), 1)), ['stg_orders.order_id']);
  assert.equal(hover(sql, 'id', ctx(), 1)?.kind, 'direct');
  const doubled = hover(sql, 'doubled', ctx(), 1);
  assert.equal(doubled?.kind, 'transformation');
  assert.deepEqual(origins(doubled), ['stg_orders.amount']);
  assert.equal(doubled?.expression, 'amount * 2');
  assert.equal(hover(sql, 'again')?.kind, 'direct');
  // Hovering inside a CTE works too.
  assert.deepEqual(origins(hover(sql, 'amount')), ['stg_orders.amount']);
});

test('unqualified column in a join uses known upstream columns', () => {
  const sql = `select amount from {{ ref('orders') }} join {{ ref('payments') }} using (order_id)`;
  const known = hover(sql, 'amount', ctx({ orders: ['order_id'], payments: ['order_id', 'amount'] }));
  assert.deepEqual(origins(known), ['payments.amount']);
  assert.equal(known?.ambiguous, false);

  const unknown = hover(sql, 'amount');
  assert.deepEqual(origins(unknown), ['orders.amount', 'payments.amount']);
  assert.equal(unknown?.ambiguous, true);
  assert.match(renderColumnLineage(unknown!), /Direct\*\* from one of/);
});

test('select * through a join of CTEs', () => {
  const sql = `
    with a as (select id, name from {{ ref('users') }}),
    b as (select id as user_id, total from {{ ref('orders') }}),
    joined as (select * from a join b on a.id = b.user_id)
    select total from joined`;
  assert.deepEqual(origins(hover(sql, 'total', ctx(), 1)), ['orders.total']);
  assert.equal(hover(sql, 'total', ctx(), 1)?.ambiguous, false);
});

test('union branches are combined by position', () => {
  const sql = `select id from {{ ref('a') }} union all select user_id from {{ ref('b') }}`;
  const l = columnLineageAt(`with u as (${sql}) select id from u`, `with u as (${sql}) select `.length, ctx());
  assert.equal(l?.kind, 'direct');
  assert.deepEqual(origins(l), ['a.id', 'b.user_id']);
  assert.match(renderColumnLineage(l!), /each of/);
});

test('columns in where / join / order by clauses resolve too', () => {
  const sql = `select a.id from {{ ref('x') }} a join {{ ref('y') }} b on a.id = b.x_id where b.status = 'ok'`;
  assert.deepEqual(origins(hover(sql, 'status')), ['y.status']);
  assert.deepEqual(origins(hover(sql, 'x_id')), ['y.x_id']);
  // An order-by alias points at the select item.
  const l = hover(`select amount * 2 as dbl from {{ ref('x') }} order by dbl`, 'dbl', ctx(), 1);
  assert.equal(l?.kind, 'transformation');
});

test('jinja around the query does not get in the way', () => {
  const sql = `{{ config(materialized='table') }}
    {% set x = 1 %}
    select
      id, -- the key
      {% if true %} status, {% endif %}
      {{ dbt_utils.generate_surrogate_key(['id']) }} as sk
    from {{ ref('x') }}`;
  assert.deepEqual(origins(hover(sql, 'status')), ['x.status']);
  const sk = hover(sql, 'sk');
  assert.equal(sk?.kind, 'transformation');
  assert.equal(sk?.unresolved, true);
});

test('non-columns give no hover', () => {
  const sql = `select o.id, count(*) from {{ ref('x') }} o where cast(o.id as int) > dateadd(day, 1, current_date)`;
  // `o.id` hovers the table alias `o`, not the column.
  for (const w of ['select', 'count', 'from', 'o.id', 'int', 'day', 'current_date']) {
    assert.equal(hover(sql, w), undefined, w);
  }
});

test('fixture: columns of upstream models and seeds come from their files', () => {
  const g = scanProject(FIXTURE);
  const file = path.join(FIXTURE, 'models/marts/int_orders.sql');
  const c = columnContext(g, g.nodeForFile(file)?.packageName);
  assert.deepEqual(c.columnsOf(g.resolveRef('stg_payments')!), ['id', 'name']);
  const sql = `select o.*, p.amount, p.name from {{ ref('stg_orders') }} o join {{ ref('stg_payments') }} p using (order_id)`;
  const l = hover(sql, 'name', c);
  assert.equal(l?.kind, 'direct');
  assert.equal(l?.origins[0].node.filePath, path.join(FIXTURE, 'models/staging/stg_payments.sql'));
  assert.match(renderColumnLineage(l!, { linkFor: (n) => n.name }), /Direct\*\* from \$\(table\) \[stg\\_payments\]\(stg_payments\) · `name`/);
});
