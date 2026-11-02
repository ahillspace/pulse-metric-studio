import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function discoverTests(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) files.push(...discoverTests(target));
    else if (entry.isFile() && /\.test\.(?:[cm]?js|tsx?)$/.test(entry.name)) files.push(target);
  }
  return files.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? 'src');
  const files = discoverTests(directory);
  if (files.length === 0) {
    console.error(`No unit tests found in ${directory}`);
    process.exitCode = 1;
  } else {
    console.log(`Running ${files.length} discovered test files in ${directory}`);
    const isolatedData = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-metric-studio-unit-tests-'));
    try {
      process.exitCode = 0;
      for (const [index, file] of files.entries()) {
        const environment = { ...process.env, PULSE_METRIC_STUDIO_DATA_DIR: path.join(isolatedData, String(index)) };
        delete environment.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', file], {
          stdio: 'inherit',
          env: environment,
        });
        if (result.error) console.error(result.error.message);
        if (result.status !== 0) process.exitCode = 1;
      }
    } finally {
      fs.rmSync(isolatedData, { recursive: true, force: true });
    }
  }
}
