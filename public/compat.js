// Small fallbacks so iPhones on iOS 15.0–15.3 (and other older browsers) run the app too. Imported first by app.js.
// structuredClone (iOS 15.4) is only used on plain JSON family state, so a JSON copy is exact.
if (typeof globalThis.structuredClone !== 'function') globalThis.structuredClone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const def = (proto, name, fn) => { if (!proto[name]) Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true }); };
for (const P of [Array.prototype, String.prototype]) def(P, 'at', function at(i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return i < 0 || i >= this.length ? undefined : this[i]; });
def(Array.prototype, 'findLastIndex', function findLastIndex(fn, self) { for (let i = this.length - 1; i >= 0; i--) if (fn.call(self, this[i], i, this)) return i; return -1; });
def(Array.prototype, 'findLast', function findLast(fn, self) { const i = this.findLastIndex(fn, self); return i < 0 ? undefined : this[i]; });
