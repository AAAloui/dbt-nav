import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { columnContext, columnLineageAt } from './columns';
import { DbtNode, LineageGraph } from './graph';
import { loadManifest } from './manifest';
import { callAt } from './parse';
import { DbtProjectConfig, readProjectConfig } from './project';
import { renderColumnLineage, renderLineage } from './render';
import { scanProject } from './scanner';

const SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'sql' },
  { scheme: 'file', language: 'jinja-sql' },
  { scheme: 'file', language: 'jinja' },
  { scheme: 'file', language: 'python' },
];
const PROJECT_EXCLUDE = '{**/dbt_packages/**,**/dbt_modules/**,**/node_modules/**,**/target/**,**/.venv/**}';

let log: vscode.OutputChannel;

/** One dbt project in the workspace, with a lazily (re)built lineage graph. */
class DbtProject {
  private graph?: LineageGraph;

  constructor(readonly cfg: DbtProjectConfig) {}

  get root(): string {
    return this.cfg.root;
  }

  invalidate(): void {
    this.graph = undefined;
  }

  getGraph(): LineageGraph | undefined {
    if (!this.graph) {
      this.graph = this.build();
    }
    return this.graph;
  }

  manifestPath(): string {
    return path.resolve(this.root, settings().get<string>('manifestPath', 'target/manifest.json'));
  }

  private build(): LineageGraph | undefined {
    const source = settings().get<string>('lineageSource', 'auto');
    const manifest = this.manifestPath();
    const started = Date.now();
    try {
      if (source === 'manifest' || (source === 'auto' && fs.existsSync(manifest))) {
        if (!fs.existsSync(manifest)) {
          log.appendLine(`[${this.cfg.name}] ${manifest} not found; run \`dbt parse\` or set dbtNav.lineageSource to "scan".`);
          return undefined;
        }
        const g = loadManifest(manifest, this.root, this.cfg.name, this.cfg.packagesInstallPath);
        log.appendLine(`[${this.cfg.name}] loaded ${g.nodes.size} nodes from manifest in ${Date.now() - started}ms`);
        return g;
      }
      const g = scanProject(this.root);
      log.appendLine(`[${this.cfg.name}] scanned ${g.nodes.size} nodes in ${Date.now() - started}ms`);
      return g;
    } catch (err) {
      log.appendLine(`[${this.cfg.name}] failed to build lineage: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }
}

class ProjectRegistry implements vscode.Disposable {
  private projects: DbtProject[] = [];
  private discovering?: Promise<void>;

  discover(): Promise<void> {
    this.discovering = (async () => {
      const files = await vscode.workspace.findFiles('**/dbt_project.yml', PROJECT_EXCLUDE);
      const found: DbtProject[] = [];
      for (const f of files) {
        try {
          found.push(new DbtProject(readProjectConfig(path.dirname(f.fsPath))));
        } catch (err) {
          log.appendLine(`Could not read ${f.fsPath}: ${err instanceof Error ? err.message : err}`);
        }
      }
      // Deepest roots first so nested projects win over their parents.
      this.projects = found.sort((a, b) => b.root.length - a.root.length);
      log.appendLine(`Found ${found.length} dbt project(s): ${found.map((p) => p.cfg.name).join(', ') || 'none'}`);
    })();
    return this.discovering;
  }

  async forFile(file: string): Promise<DbtProject | undefined> {
    await this.discovering;
    return this.projects.find((p) => file === p.root || file.startsWith(p.root + path.sep));
  }

  /** Invalidate graphs affected by a change to `file`. */
  async onFileChanged(file: string): Promise<void> {
    await this.discovering;
    for (const p of this.projects) {
      if (!file.startsWith(p.root + path.sep)) {
        continue;
      }
      if (file === p.manifestPath() || !file.endsWith('.json')) {
        p.invalidate();
      }
    }
  }

  invalidateAll(): void {
    this.projects.forEach((p) => p.invalidate());
  }

  dispose(): void {
    this.projects = [];
  }
}

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('dbtNav');
}

class LineageHoverProvider implements vscode.HoverProvider {
  constructor(private readonly registry: ProjectRegistry) {}

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const call = callAt(text, offset);
    if (!call && doc.languageId === 'python') {
      return undefined;
    }
    const project = await this.registry.forFile(doc.uri.fsPath);
    const graph = project?.getGraph();
    if (!graph) {
      return undefined;
    }
    const current = graph.nodeForFile(doc.uri.fsPath);
    const linkFor = (n: DbtNode) => (n.filePath ? vscode.Uri.file(n.filePath).toString() : undefined);

    if (!call) {
      const col = columnLineageAt(text, offset, columnContext(graph, current?.packageName));
      if (!col) {
        return undefined;
      }
      const range = new vscode.Range(doc.positionAt(col.start), doc.positionAt(col.end));
      return new vscode.Hover(new vscode.MarkdownString(renderColumnLineage(col, { linkFor }), true), range);
    }

    const target =
      call.kind === 'ref'
        ? graph.resolveRef(call.name, call.packageName, current?.packageName)
        : graph.resolveSource(call.sourceName, call.table);
    const node = target ?? {
      id: '',
      name: call.kind === 'ref' ? call.name : call.table,
      sourceName: call.kind === 'source' ? call.sourceName : undefined,
      resourceType: call.kind === 'ref' ? 'model' : 'source',
      packageName: (call.kind === 'ref' && call.packageName) || graph.rootPackage,
      missing: true,
    };

    const cfg = settings();
    const md = new vscode.MarkdownString(
      renderLineage(graph, node, {
        maxDepth: cfg.get<number>('upstream.maxDepth', 0),
        maxNodes: cfg.get<number>('upstream.maxNodes', 150),
        includeTests: cfg.get<boolean>('downstream.includeTests', false),
        linkFor,
      }),
      true,
    );
    const range = new vscode.Range(doc.positionAt(call.start), doc.positionAt(call.end));
    return new vscode.Hover(md, range);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('dbt-nav');
  const registry = new ProjectRegistry();
  void registry.discover();

  const onChange = (uri: vscode.Uri) => void registry.onFileChanged(uri.fsPath);
  const sources = vscode.workspace.createFileSystemWatcher('**/*.{sql,py,csv,yml,yaml}');
  const manifests = vscode.workspace.createFileSystemWatcher('**/manifest.json');
  const projects = vscode.workspace.createFileSystemWatcher('**/dbt_project.yml');
  for (const w of [sources, manifests]) {
    w.onDidChange(onChange);
    w.onDidCreate(onChange);
    w.onDidDelete(onChange);
  }
  const rediscover = () => void registry.discover();
  projects.onDidCreate(rediscover);
  projects.onDidChange(rediscover);
  projects.onDidDelete(rediscover);

  context.subscriptions.push(
    log,
    registry,
    sources,
    manifests,
    projects,
    vscode.languages.registerHoverProvider(SELECTOR, new LineageHoverProvider(registry)),
    vscode.commands.registerCommand('dbtNav.refresh', async () => {
      await registry.discover();
      vscode.window.setStatusBarMessage('dbt-nav: lineage refreshed', 3000);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbtNav')) {
        registry.invalidateAll();
      }
    }),
  );
}

export function deactivate(): void {}
