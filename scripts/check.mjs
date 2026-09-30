import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../extension/', import.meta.url)));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['storage', 'system.display']);
assert(!manifest.host_permissions && !manifest.content_scripts);
for (const path of [manifest.action.default_popup, manifest.background.service_worker, ...Object.values(manifest.icons)]) {
  assert(existsSync(path), `Missing ${path}`);
}
for (const file of readdirSync('src').filter(f => f.endsWith('.js'))) execFileSync(process.execPath, ['--check', `src/${file}`]);
for (const [size, path] of Object.entries(manifest.icons)) {
  const data = readFileSync(path);
  assert.equal(data.readUInt32BE(16), Number(size));
  assert.equal(data.readUInt32BE(20), Number(size));
}
const html = readFileSync('popup.html', 'utf8');
assert(!/<script[^>]*>\s*\S+(?!<\/script)/.test(html.replace(/<script[^>]*src=[^>]*><\/script>/g, '')));
assert(!/\son\w+=/i.test(html), 'Inline handlers violate MV3 CSP');
console.log('插件源码的 Manifest、权限、图标、脚本语法及 CSP 检查通过。');
