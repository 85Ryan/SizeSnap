import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
const names = ['question', 'plus', 'browsers', 'arrow-left', 'crosshair-simple', 'check-circle', 'warning-circle', 'x', 'arrow-counter-clockwise', 'export', 'download-simple', 'check', 'arrow-up-right', 'trash', 'pencil-simple'];
await mkdir('extension/icons/ui', { recursive: true });
for (const name of names) await copyFile(`node_modules/@phosphor-icons/core/assets/regular/${name}.svg`, `extension/icons/ui/${name}.svg`);
const license = await readFile('node_modules/@phosphor-icons/core/LICENSE', 'utf8');
await writeFile('extension/icons/ui/LICENSE', license.replace(/\r\n/g, '\n'));
console.log(`Vendored ${names.length} Phosphor regular icons and license.`);
