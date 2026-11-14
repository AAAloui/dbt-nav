import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callAt, findCalls } from '../parse';

test('finds ref and source calls in all supported shapes', () => {
  const text = `
    select * from {{ ref('a') }}
    join {{ ref("pkg", "b") }}
    join {{ ref('c', v=2) }}
    join {{ ref( 'd' , version = 3 ) }}
    join {{ source('raw', 'orders') }}
  `;
  const calls = findCalls(text).map(({ start, end, ...rest }) => rest);
  assert.deepEqual(calls, [
    { kind: 'ref', name: 'a' },
    { kind: 'ref', packageName: 'pkg', name: 'b' },
    { kind: 'ref', name: 'c' },
    { kind: 'ref', name: 'd' },
    { kind: 'source', sourceName: 'raw', table: 'orders' },
  ]);
});

test('ignores calls inside jinja comments', () => {
  assert.deepEqual(findCalls(`{# {{ ref('hidden') }} #} {{ ref('shown') }}`).map((c) => c.kind === 'ref' && c.name), [
    'shown',
  ]);
});

test('matches python models', () => {
  assert.equal(findCalls(`df = dbt.ref("orders")`).length, 1);
});

test('does not match identifiers that merely end in ref', () => {
  assert.equal(findCalls(`select myref('x')`).length, 0);
});

test('callAt returns the call under the cursor', () => {
  const text = `from {{ ref('orders') }} join {{ ref('customers') }}`;
  const at = callAt(text, text.indexOf('customers'));
  assert.equal(at?.kind === 'ref' && at.name, 'customers');
  assert.equal(callAt(text, text.indexOf('join')), undefined);
});
