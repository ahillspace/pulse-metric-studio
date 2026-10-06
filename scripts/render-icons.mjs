import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'src-tauri', 'icons');
fs.mkdirSync(outDir, { recursive: true });

// The original supplied artwork is shared with the web identity. Preserve its
// aspect ratio and pixels; every platform icon derives from this one asset.
const artwork = path.join(root, 'packages', 'web', 'src', 'assets', 'pulse-icon.png');
const options = { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } };

await sharp(artwork).resize(1024, 1024, options).png().toFile(path.join(outDir, 'app-icon.png'));
await sharp(artwork).resize(32, 32, options).png().toFile(path.join(outDir, 'tray-32.png'));
await sharp(artwork).resize(64, 64, options).png().toFile(path.join(outDir, 'tray-32@2x.png'));

console.log('rendered app-icon.png (1024), tray-32.png, tray-32@2x.png ->', outDir);
