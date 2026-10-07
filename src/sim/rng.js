// Generador pseudoaleatorio con semilla (mulberry32): la misma semilla da siempre el mismo día,
// así el asistente, las gráficas y la escena 3D cuentan la misma historia.

export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function makeRng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  r.range = (lo, hi) => lo + r() * (hi - lo);
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.normal = (m = 0, s = 1) => {
    const u = 1 - r();
    const v = r();
    return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  r.poisson = (lambda) => {
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do { k++; p *= r(); } while (p > l);
    return k - 1;
  };
  r.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  // Muestreo por pesos con la tabla acumulada precalculada (búsqueda binaria).
  r.weighted = (cum) => {
    const x = r() * cum[cum.length - 1];
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  return r;
}

export function cumulative(weights) {
  const out = new Array(weights.length);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) { acc += weights[i]; out[i] = acc; }
  return out;
}
