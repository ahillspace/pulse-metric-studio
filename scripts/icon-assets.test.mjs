import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artwork = path.join(root, 'packages/web/src/assets/pulse-icon.png');

test('native app and tray assets preserve the canonical supplied artwork', async () => {
  for (const [file, size] of [['app-icon.png', 1024], ['tray-32.png', 32], ['tray-32@2x.png', 64]]) {
    const expected = await sharp(artwork).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer();
    const actual = await sharp(path.join(root, 'src-tauri/icons', file)).ensureAlpha().raw().toBuffer();
    assert.deepEqual(actual, expected, file);
  }
});

test('native window, installer, tray, and browser references use the generated identity', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  for (const name of config.bundle.icon) assert.ok(fs.existsSync(path.join(root, 'src-tauri', name)), name);
  const native = fs.readFileSync(path.join(root, 'src-tauri/src/main.rs'), 'utf8');
  assert.match(native, /\/icons\/128x128\.png/);
  assert.match(native, /\/icons\/tray-32\.png/);
  assert.match(fs.readFileSync(path.join(root, 'packages/web/index.html'), 'utf8'), /src\/assets\/pulse-icon\.png/);
  for (const [name, size] of [['32x32.png', 32], ['64x64.png', 64], ['128x128.png', 128], ['128x128@2x.png', 256]]) {
    const metadata = await sharp(path.join(root, 'src-tauri/icons', name)).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
  }
});
