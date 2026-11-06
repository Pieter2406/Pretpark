// Walking routes over the park's footpaths (OpenStreetMap, see park.json). Coordinates in park.json are metres:
// x to the east and y to the south of `origin`, so they can be drawn straight into an SVG.

export function makePark(data) {
  const [lat0, lon0] = data.origin;
  const { kx, ky } = data;
  const toXY = (p) => ({ x: (p.lon - lon0) * kx, y: (lat0 - p.lat) * ky });
  const toLL = (q) => ({ lat: lat0 - q.y / ky, lon: lon0 + q.x / kx });

  const n = data.pts.length / 2;
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = data.pts[2 * i]; Y[i] = data.pts[2 * i + 1]; }
  const adj = Array.from({ length: n }, () => []);
  const link = (a, b) => { const d = Math.hypot(X[a] - X[b], Y[a] - Y[b]); adj[a].push([b, d]); adj[b].push([a, d]); };
  for (let i = 0; i < data.edges.length; i += 2) link(data.edges[i], data.edges[i + 1]);

  // OSM has small gaps: join loose path pieces to the main network where they nearly touch (< 45 m).
  const comp = new Int32Array(n).fill(-1); let c = 0; const sizes = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0) continue;
    const st = [i]; comp[i] = c; let size = 0;
    while (st.length) { const u = st.pop(); size++; for (const [v] of adj[u]) if (comp[v] < 0) { comp[v] = c; st.push(v); } }
    sizes.push(size); c++;
  }
  const main = sizes.indexOf(Math.max(...sizes));
  for (let i = 0; i < n; i++) {
    if (comp[i] === main) continue;
    let best = -1, bd = 45;
    for (let j = 0; j < n; j++) if (comp[j] === main) { const d = Math.hypot(X[i] - X[j], Y[i] - Y[j]); if (d < bd) { bd = d; best = j; } }
    if (best >= 0) link(i, best);
  }

  function nearest(q) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = (X[i] - q.x) ** 2 + (Y[i] - q.y) ** 2; if (d < bd) { bd = d; best = i; } }
    return [best, Math.sqrt(bd)];
  }

  // One Dijkstra from where you stand gives the walking distance to everything.
  function fromHere(pos) {
    const q = toXY(pos);
    const [s, sd] = nearest(q);
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    dist[s] = sd;
    for (;;) { // n is ~800: a simple O(n²) scan is fast enough and has no heap to get wrong
      let u = -1, ud = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < ud) { ud = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = 1;
      for (const [v, w] of adj[u]) if (ud + w < dist[v]) { dist[v] = ud + w; prev[v] = u; }
    }
    const cache = new Map();
    const snap = (p) => { const k = p.lat + ',' + p.lon; if (!cache.has(k)) cache.set(k, nearest(toXY(p))); return cache.get(k); };
    return {
      here: q,
      metres(p) {
        const t = toXY(p), [e, ed] = snap(p);
        const direct = Math.hypot(t.x - q.x, t.y - q.y);
        const viaPath = dist[e] + ed;
        return direct < 40 ? direct : Math.min(viaPath, direct * 2.2);
      },
      path(p) { // list of {x,y} from here to p
        const t = toXY(p), [e] = snap(p);
        if (Math.hypot(t.x - q.x, t.y - q.y) < 40 || !isFinite(dist[e])) return [q, t];
        const pts = [t];
        for (let u = e; u >= 0; u = prev[u]) pts.push({ x: X[u], y: Y[u] });
        pts.push(q);
        return pts.reverse();
      },
    };
  }

  // The point ~25 m ahead along a path: the arrow points there, so it follows the bends.
  function lookahead(path, ahead = 25) {
    let left = ahead;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d >= left) return { x: a.x + (b.x - a.x) * left / d, y: a.y + (b.y - a.y) * left / d };
      left -= d;
    }
    return path[path.length - 1];
  }

  const toilets = (data.toilets || []).map(([x, y]) => toLL({ x, y }));
  return { data, toXY, toLL, fromHere, lookahead, toilets };
}

export const pathLength = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
// screen bearing of a→b in degrees, 0 = north (y grows southwards)
export const bearingXY = (a, b) => (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
