import * as fs from 'fs';
import * as path from 'path';
import { LineageGraph } from './graph';

interface ManifestNode {
  name: string;
  resource_type: string;
  package_name: string;
  original_file_path?: string;
  source_name?: string;
}

interface Manifest {
  metadata?: { project_name?: string };
  nodes?: Record<string, ManifestNode>;
  sources?: Record<string, ManifestNode>;
  exposures?: Record<string, ManifestNode>;
  metrics?: Record<string, ManifestNode>;
  semantic_models?: Record<string, ManifestNode>;
  saved_queries?: Record<string, ManifestNode>;
  unit_tests?: Record<string, ManifestNode>;
  parent_map?: Record<string, string[]>;
}

/**
 * Build a graph from a dbt `manifest.json`.
 * @param packagesDir where dbt installs packages (`dbt_packages` by default), used to locate package files.
 */
export function graphFromManifest(
  manifest: Manifest,
  projectRoot: string,
  projectName: string,
  packagesDir = 'dbt_packages',
): LineageGraph {
  const root = manifest.metadata?.project_name ?? projectName;
  const graph = new LineageGraph(root);

  const resolveFile = (pkg: string, rel?: string): string | undefined => {
    if (!rel) {
      return undefined;
    }
    const candidates =
      pkg === root
        ? [path.join(projectRoot, rel)]
        : [path.join(projectRoot, packagesDir, pkg, rel), path.join(projectRoot, rel)];
    return candidates.find((p) => fs.existsSync(p));
  };

  const groups = [
    manifest.nodes,
    manifest.sources,
    manifest.exposures,
    manifest.metrics,
    manifest.semantic_models,
    manifest.saved_queries,
    manifest.unit_tests,
  ];
  for (const group of groups) {
    for (const [id, n] of Object.entries(group ?? {})) {
      graph.addNode({
        id,
        name: n.name,
        resourceType: n.resource_type,
        packageName: n.package_name,
        sourceName: n.source_name,
        filePath: resolveFile(n.package_name, n.original_file_path),
      });
    }
  }

  for (const [child, parents] of Object.entries(manifest.parent_map ?? {})) {
    for (const parent of parents) {
      graph.addEdge(parent, child);
    }
  }
  return graph;
}

export function loadManifest(
  manifestPath: string,
  projectRoot: string,
  projectName: string,
  packagesDir?: string,
): LineageGraph {
  const json = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  return graphFromManifest(json, projectRoot, projectName, packagesDir);
}
