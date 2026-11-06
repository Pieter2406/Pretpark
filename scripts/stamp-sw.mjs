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
const swPath = join(root, 'sw.js');
const sw = readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
writeFileSync(swPath, sw);
console.log('sw.js VERSION =', version);
