import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface DbtProjectConfig {
  root: string;
  name: string;
  modelPaths: string[];
  seedPaths: string[];
  snapshotPaths: string[];
  analysisPaths: string[];
  packagesInstallPath: string;
}

/** Read the subset of `dbt_project.yml` that dbt-nav needs. */
export function readProjectConfig(root: string): DbtProjectConfig {
  const raw = (parseYaml(fs.readFileSync(path.join(root, 'dbt_project.yml'), 'utf8')) ?? {}) as Record<
    string,
    unknown
  >;
  const list = (key: string, fallback: string[]): string[] => {
    const v = raw[key];
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : fallback;
  };
  return {
    root,
    name: typeof raw.name === 'string' ? raw.name : path.basename(root),
    modelPaths: list('model-paths', list('source-paths', ['models'])),
    seedPaths: list('seed-paths', list('data-paths', ['seeds'])),
    snapshotPaths: list('snapshot-paths', ['snapshots']),
    analysisPaths: list('analysis-paths', ['analyses']),
    packagesInstallPath:
      typeof raw['packages-install-path'] === 'string' ? (raw['packages-install-path'] as string) : 'dbt_packages',
  };
}
