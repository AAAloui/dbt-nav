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

## Column lineage

Hover over a column in a model's SQL to see where it comes from among the model's **direct** upstreams:

- **Direct**: passed through (possibly renamed) from an upstream column.
- **Transformation**: computed from one or more upstream columns, with the expression shown.

```
◇ full_name  column

⚙ Transformation of 2 upstream columns:
- ⛁ jaffle.raw_customers  source · first_name
- ⛁ jaffle.raw_customers  source · last_name

    first_name || ' ' || last_name
```

Columns are followed through CTEs, subqueries, joins, unions and `select *` until they reach a `ref()` or `source()`. Hover works on select-list columns and aliases, and on columns used in `on`, `where`, `group by`, `order by`, etc.

When a column is unqualified in a join (or comes through a `select *` over a join), dbt-nav works out which upstream has it from the upstream model's SQL, a seed's CSV header, or columns documented in YAML (manifest mode). If it still can't tell, the hover lists every candidate. Columns produced by Jinja macros can't be traced.

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
- `src/sql.ts`: a small, forgiving SQL parser (CTEs, select lists, from/join items)
- `src/columns.ts`: column lineage: traces a column to the model's direct upstreams
- `src/render.ts`: hover markdown
- `src/extension.ts`: VS Code wiring (project discovery, file watching, hover provider)

## Publishing

Releases are published by `.github/workflows/release.yml` when a `vX.Y.Z` tag matching `package.json` is pushed:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `git tag v0.1.1 && git push --tags`

The workflow publishes to both stores and attaches the `.vsix` to a GitHub release:

| Store | Used by | Authentication |
| --- | --- | --- |
| [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=aaaloui.dbt-nav) | VS Code | [Trusted publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing) (OIDC), no secret. The `aaaloui` publisher's policy trusts `AAAloui/dbt-nav`, workflow `release.yml`, no environment. |
| [Open VSX](https://open-vsx.org/extension/aaaloui/dbt-nav) | VSCodium, Cursor, Windsurf, ... | `OVSX_PAT` repository secret |

Renaming `release.yml` or running it in a GitHub environment breaks Marketplace publishing until the trusted publishing policy at https://marketplace.visualstudio.com/manage is updated to match.

## License

MIT
