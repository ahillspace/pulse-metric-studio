import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'src-tauri', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const iconSvg = path.join(root, 'design', 'icon.svg');
const traySvg = path.join(root, 'design', 'tray.svg');

await sharp(iconSvg, { density: 300 }).resize(1024, 1024).png().toFile(path.join(outDir, 'app-icon.png'));
await sharp(traySvg, { density: 300 }).resize(32, 32).png().toFile(path.join(outDir, 'tray-32.png'));
await sharp(traySvg, { density: 300 }).resize(64, 64).png().toFile(path.join(outDir, 'tray-32@2x.png'));

console.log('rendered app-icon.png (1024), tray-32.png, tray-32@2x.png ->', outDir);
