// Comprobación de cifras: toda cifra que escriba el modelo tiene que estar en los datos que recibió
// (contexto, respuesta base o pregunta). Así no puede restar, sumar ni inventar plazos por su cuenta.

// Identificadores que llevan números pero no son cifras: C-04, E3, R1, BEB-1234, P-000108, T01…
const ID_RE = /\b[A-Za-z]{1,4}-?\d+[A-Za-z]?\b/g;
const TIME_RE = /\b(\d{1,2}):(\d{2})\b/g;
const NUM_RE = /\d+(?:[.,]\d+)*/g;

function parse(tok) {
  // 1.163 / 1,163 con grupos de exactamente 3 cifras = separador de miles; si no, decimal.
  if (/^\d{1,3}([.,]\d{3})+$/.test(tok)) return Number(tok.replace(/[.,]/g, ''));
  return Number(tok.replace(',', '.'));
}

export function extraer(texto) {
  const horas = [];
  const t = String(texto)
    .replace(TIME_RE, (m, h, mm) => { horas.push(`${Number(h)}:${mm}`); return ' '; })
    .replace(ID_RE, ' ');
  const nums = (t.match(NUM_RE) || []).map(parse).filter(Number.isFinite);
  return { nums, horas };
}

export function permitidas(...fuentes) {
  const nums = new Set([0, 1, 100]);
  const horas = new Set();
  const add = (v) => {
    nums.add(v);
    nums.add(Math.round(v));
    nums.add(Math.round(v * 10) / 10);
    // Los ratios (0,797) se escriben como porcentaje (79,7 %).
    if (Math.abs(v) <= 1.5 && !Number.isInteger(v)) {
      const p = v * 100;
      nums.add(Math.round(p));
      nums.add(Math.round(p * 10) / 10);
    }
  };
  for (const f of fuentes) {
    const texto = typeof f === 'string' ? f : JSON.stringify(f ?? '');
    const e = extraer(texto);
    e.nums.forEach(add);
    e.horas.forEach((h) => horas.add(h));
  }
  return { nums, horas };
}

// Devuelve las cifras de `respuesta` que no aparecen en lo permitido (vacío = todo correcto).
export function cifrasInventadas(respuesta, permit) {
  const { nums, horas } = extraer(respuesta);
  const malas = [];
  for (const h of horas) if (!permit.horas.has(h)) malas.push(h);
  for (const n of nums) {
    let ok = false;
    for (const a of permit.nums) {
      if (Math.abs(a - n) <= 0.051) { ok = true; break; }
    }
    if (!ok) malas.push(String(n));
  }
  return [...new Set(malas)];
}
