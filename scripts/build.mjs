import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'extension');
const destination = join(root, 'dist');
const entries = ['manifest.json', 'popup.html', 'src', 'icons'];

await mkdir(destination, { recursive: true });
for (const entry of entries) {
  const from = join(source, entry);
  const to = join(destination, entry);
  // Only replace extension runtime files; preserve unrelated local files in dist.
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
}
console.log(`已更新 Chrome 插件目录：${destination}`);
