import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('the real app shell renders page identity and the resizable assistant component', async (t) => {
  const directory = fs.mkdtempSync(path.join(root, 'packages', 'web', 'node_modules', '.pulse-shell-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'shell.mjs');
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import PulseApp from './packages/web/src/features/pulse/PulseApp';
        export function render() {
          const previousWindow = globalThis.window;
          const previousDocument = globalThis.document;
          globalThis.window = { matchMedia: () => ({ matches: false }) };
          globalThis.document = { getElementById: () => null };
          try { return renderToStaticMarkup(<PulseApp />); }
          finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
        }
      `,
      loader: 'tsx',
      resolveDir: root,
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.png': 'dataurl' },
    define: { 'import.meta.env': '{}' },
  });
  const { render } = await import(pathToFileURL(output).href);
  const markup = render();
  assert.match(markup, /<h1><svg[^]*?<\/svg>Connections<\/h1>/);
  assert.match(markup, /aria-label="Resize assistant"/);
  assert.match(markup, /class="pulse-assistant-panel"[^>]*hidden=""/);
  assert.match(markup, /aria-label="Metric Manager"/);
  assert.match(markup, /class="linkish llm-settings-button"[^]*?<svg/);
});
