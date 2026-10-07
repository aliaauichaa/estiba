// Idioma de la interfaz (español / inglés). Los textos van en línea, uno junto a otro, con tx('es', 'en'):
// así cada frase y su traducción se revisan a la vez y no hay claves que se desincronicen.
// Orden de preferencia: ?lang= en la URL, lo que eligió el usuario, el idioma del navegador.

const KEY = 'estiba-lang';
const listeners = new Set();

function initial() {
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'es' || q === 'en') return q;
  } catch { /* sin window (pruebas en Node) */ }
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'es' || saved === 'en') return saved;
  } catch { /* almacenamiento bloqueado */ }
  try {
    return (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en';
  } catch {
    return 'es';
  }
}

export let lang = typeof window === 'undefined' ? 'es' : initial();

export function setLang(l) {
  if (l !== 'es' && l !== 'en') return;
  lang = l;
  try { window.localStorage.setItem(KEY, l); } catch { /* da igual */ }
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  for (const fn of listeners) fn(l);
}

export function onLang(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const tx = (es, en) => (lang === 'en' ? en : es);
export const locale = () => (lang === 'en' ? 'en-GB' : 'es-ES');

// Números con el formato de cada idioma: «94,2 %» / «94.2%».
const cache = new Map();
function nf(digits) {
  const key = `${lang}-${digits}`;
  if (!cache.has(key)) cache.set(key, new Intl.NumberFormat(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }));
  return cache.get(key);
}
export const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : nf(d).format(v));
export const pct = (v, d = 1) => (v == null ? '—' : lang === 'en' ? `${nf(d).format(v * 100)}%` : `${nf(d).format(v * 100)} %`);
export const ppUnit = () => tx(' p. p.', ' pp');

// Destinos de ruta: el nombre de la ciudad no se traduce; los añadidos sí («Zaragoza tarde» → «Zaragoza PM»).
const SUFIJOS = { ciudad: 'city', tarde: 'PM', centro: 'centre' };
export function placeName(destino) {
  if (lang !== 'en') return destino;
  return destino.split(' ').map((w) => SUFIJOS[w] || w).join(' ');
}
