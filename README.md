# dbt-nav

Navigate dbt lineage without leaving your SQL. Hover over any `ref()` or `source()` to see:

- **Upstream**: *every* ancestor of the model, as a nested tree, all the way to sources and seeds.
- **Downstream**: the model's **direct** children only (no grandchildren).

Every entry links to its file, so you can click through the DAG.

```
▦ fct_orders  model · jaffle

↑ Upstream — 8 ancestors
- ▦ calendar
- ▦ int_orders
  - ▦ stg_orders
    - ⛁ raw.orders  source
  - ▦ stg_payments
    - ▤ raw_payments  seed
- ▦ stg_customers
  - ⛁ raw.customers  source
- ▦ stg_orders  (see above)

↓ Downstream — 2 direct children
- ▦ customer_ml
- ▦ dim_customers
```

An ancestor reachable along several paths is expanded once; later sightings say *(see above)*.

## Where lineage comes from

| `dbtNav.lineageSource` | Behaviour |
| --- | --- |
| `auto` (default) | Use `target/manifest.json` if it exists, else scan the project files. |
| `manifest` | Only use the manifest. Most accurate; run `dbt parse` (or any dbt command) to refresh it. |
| `scan` | Read `ref()`/`source()` calls straight from your `.sql` and `.py` files. No dbt needed, updates on save, but refs built dynamically in Jinja are not visible. |

The graph is rebuilt automatically when the manifest or a project file changes. Multiple dbt projects in one workspace are supported, as are installed packages (`dbt_packages/`).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `dbtNav.lineageSource` | `auto` | See above. |
| `dbtNav.manifestPath` | `target/manifest.json` | Relative to each dbt project root. |
| `dbtNav.upstream.maxDepth` | `0` | Levels of ancestors to show. `0` = unlimited. |
| `dbtNav.upstream.maxNodes` | `150` | Cap on entries rendered in one hover, for very large DAGs. |
| `dbtNav.downstream.includeTests` | `false` | Include data/unit tests among downstream children. |

Command: **dbt-nav: Refresh Lineage**.

Hovers work in files with language `sql`, `jinja-sql` (dbt Power User), `jinja`, and `python` (Python models).

## Development

```sh
npm install
npm test          # compile + unit tests (node:test)
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host. `npm run package` builds a `.vsix`.

Layout:

- `src/parse.ts`: finds `ref()` / `source()` calls in text
- `src/graph.ts`: the DAG, ref resolution, upstream tree and downstream list
- `src/manifest.ts`: builds the graph from `manifest.json`
- `src/scanner.ts`: builds the graph by scanning project files
- `src/render.ts`: hover markdown
- `src/extension.ts`: VS Code wiring (project discovery, file watching, hover provider)

## License

MIT
