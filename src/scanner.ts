import * as fs from 'fs';
import * as path from 'path';
import { DbtNode, LineageGraph } from './graph';
import { findCalls } from './parse';
import { DbtProjectConfig, readProjectConfig } from './project';

const SNAPSHOT_RE = /\{%-?\s*snapshot\s+([A-Za-z_][\w]*)\s*-?%\}/g;
const SKIP_DIRS = new Set(['node_modules', 'target', 'logs', '.git', '.venv', 'venv']);

/**
 * Build a graph without dbt: read every model/snapshot file of the project
 * (and its installed packages) and extract ref()/source() calls.
 * Lineage is approximate — refs built dynamically in Jinja cannot be seen.
 */
export function scanProject(rootDir: string): LineageGraph {
  const rootCfg = readProjectConfig(rootDir);
  const graph = new LineageGraph(rootCfg.name);

  const projects: DbtProjectConfig[] = [rootCfg];
  const pkgDir = path.join(rootDir, rootCfg.packagesInstallPath);
  for (const entry of safeReadDir(pkgDir)) {
    const dir = path.join(pkgDir, entry.name);
    if (entry.isDirectory() && fs.existsSync(path.join(dir, 'dbt_project.yml'))) {
      try {
        projects.push(readProjectConfig(dir));
      } catch {
        // Unparseable package config: skip the package.
      }
    }
  }

  // Pass 1: collect nodes and the raw calls of each file.
  const pending: { node: DbtNode; text: string }[] = [];
  for (const cfg of projects) {
    const add = (resourceType: string, name: string, file: string, text?: string) => {
      const node: DbtNode = { id: `${resourceType}.${cfg.name}.${name}`, name, resourceType, packageName: cfg.name, filePath: file };
      graph.addNode(node);
      if (text !== undefined) {
        pending.push({ node, text });
      }
    };
    for (const file of walk(cfg.root, cfg.modelPaths, ['.sql', '.py'])) {
      add('model', path.basename(file).replace(/\.(sql|py)$/, ''), file, readFile(file));
    }
    for (const file of walk(cfg.root, cfg.seedPaths, ['.csv'])) {
      add('seed', path.basename(file, '.csv'), file);
    }
    for (const file of walk(cfg.root, cfg.snapshotPaths, ['.sql'])) {
      const text = readFile(file);
      // A snapshot file holds `{% snapshot name %}` blocks; newer YAML snapshots use the file name.
      const names = [...text.matchAll(SNAPSHOT_RE)].map((m) => m[1]);
      for (const name of names.length ? names : [path.basename(file, '.sql')]) {
        add('snapshot', name, file, text);
      }
    }
    for (const file of walk(cfg.root, cfg.analysisPaths, ['.sql'])) {
      add('analysis', path.basename(file, '.sql'), file, readFile(file));
    }
  }

  // Pass 2: resolve calls into edges, creating placeholder nodes for anything unknown.
  for (const { node, text } of pending) {
    for (const call of findCalls(text)) {
      let parent: DbtNode | undefined;
      if (call.kind === 'ref') {
        parent = graph.resolveRef(call.name, call.packageName, node.packageName);
        if (!parent) {
          parent = { id: `missing.${call.packageName ?? ''}.${call.name}`, name: call.name, resourceType: 'model', packageName: call.packageName ?? node.packageName, missing: true };
          graph.addNode(parent);
        }
      } else {
        parent = graph.resolveSource(call.sourceName, call.table);
        if (!parent) {
          // Sources live in YAML; we don't parse it, so every source is a synthesized node.
          parent = { id: `source.${node.packageName}.${call.sourceName}.${call.table}`, name: call.table, sourceName: call.sourceName, resourceType: 'source', packageName: node.packageName };
          graph.addNode(parent);
        }
      }
      graph.addEdge(parent.id, node.id);
    }
  }
  return graph;
}

function* walk(root: string, dirs: string[], exts: string[]): Generator<string> {
  for (const d of dirs) {
    yield* walkDir(path.resolve(root, d), exts);
  }
}

function* walkDir(dir: string, exts: string[]): Generator<string> {
  for (const entry of safeReadDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walkDir(full, exts);
      }
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      yield full;
    }
  }
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
