// Sets VERSION in public/sw.js to a hash of every published file, so each deploy ships one consistent set
// and phones only switch when something changed. Run by `npm run deploy` (and `npm run check`).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../public/', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p); else if (f !== 'sw.js') files.push(p);
  }
})(root);
const h = createHash('sha256');
for (const f of files) { h.update(f.slice(root.length)); h.update(readFileSync(f)); }
const version = 'pretpark-' + h.digest('hex').slice(0, 12);
// the lazily cached files get their own version, so the browser keeps them across app updates until they change
const lh = createHash('sha256');
for (const f of files.filter((f) => /\/(vendor|img)\//.test(f.slice(root.length - 1)))) { lh.update(f.slice(root.length)); lh.update(readFileSync(f)); }
const lazy = 'pretpark-lazy-' + lh.digest('hex').slice(0, 10);
const swPath = join(root, 'sw.js');
const sw = readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`).replace(/const LAZY = '[^']*';/, `const LAZY = '${lazy}';`);
writeFileSync(swPath, sw);
console.log('sw.js VERSION =', version, 'LAZY =', lazy);
