// Histórico de los 14 días anteriores de una operativa (mismo motor, otras semillas).
// Sirve de línea base: cada indicador de hoy se compara con la media a la misma hora.

import { runDay } from '../sim/engine.js';

const FIELDS = ['otif', 'aTiempo', 'fill', 'dts', 'ocupacion', 'productividad', 'utilizacion', 'metrosLinea', 'lineas', 'pales', 'equipos', 'patio', 'calle', 'bloqueo'];
const FINAL = ['otif', 'aTiempo', 'fill', 'dts', 'ocupacion', 'productividad', 'utilizacion', 'metrosLinea', 'esperaMedia'];

// Almacén (se mantiene la firma de siempre).
export function computeHistory(site, days = 14) {
  return historyFrom((d) => runDay(site, d), { days, fields: FIELDS, final: FINAL });
}

// Cualquier operativa: dia(d) devuelve el simulador del día d ya terminado (con hourly, kpis() e incidencias).
export async function historyFrom(dia, { days = 14, fields, final = [] }) {
  const out = [];
  for (let d = 1; d <= days; d++) {
    const sim = dia(d);
    out.push({ day: d, kpis: sim.kpis(), hourly: sim.hourly, serie: sim.serie || [], incidencias: sim.incidencias?.length ?? 0 });
    // Cede el hilo para no congelar la escena mientras se calcula.
    await new Promise((r) => setTimeout(r, 0));
  }
  const byHour = new Map();
  for (const d of out) {
    for (const h of d.hourly) {
      if (!byHour.has(h.hora)) byHour.set(h.hora, []);
      byHour.get(h.hora).push(h);
    }
  }
  const hourly = new Map();
  for (const [hora, rows] of byHour) {
    const avg = {};
    for (const f of fields) {
      const vals = rows.map((r) => r[f]).filter((v) => v != null && Number.isFinite(v));
      avg[f] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    hourly.set(hora, avg);
  }
  // Media minuto a minuto de los indicadores que el simulador guarda en su serie (automoción y última milla).
  const porT = new Map();
  for (const d of out) {
    for (const p of d.serie) {
      if (!porT.has(p.t)) porT.set(p.t, []);
      porT.get(p.t).push(p);
    }
  }
  const serie = new Map();
  for (const [t, rows] of porT) {
    const avg = {};
    for (const k of Object.keys(rows[0])) {
      if (k === 't') continue;
      const vals = rows.map((r) => r[k]).filter((v) => v != null && Number.isFinite(v));
      avg[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    serie.set(t, avg);
  }
  const fin = {};
  for (const f of final) {
    const vals = out.map((d) => d.kpis[f]).filter((v) => v != null);
    fin[f] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return { days: out, hourly, serie, final: fin };
}

// Media de un indicador al MISMO minuto del día, sobre la serie minuto a minuto. Con la foto de la hora
// cerrada se compararía, por ejemplo, el acumulado de las hh:55 con el de las hh:00, o los conductores
// en ruta de las 21:50 con los de las 21:00.
export function valorMedioEn(history, t, key) {
  if (!history?.serie?.size) return null;
  const t0 = Math.floor(t);
  const a = history.serie.get(t0)?.[key];
  const c = history.serie.get(t0 + 1)?.[key];
  if (a == null) return c ?? null;
  return c == null ? a : a + (c - a) * (t - t0);
}

// Línea base para comparar ahora: la media de la última hora cerrada, y al mismo minuto en los indicadores
// que el simulador guarda en su serie (en esos, la foto horaria se queda atrás dentro de la hora).
export function mediaEn(history, t) {
  const b = baselineAt(history, t);
  if (!history?.serie?.size) return b;
  const out = { ...(b || {}) };
  const muestra = history.serie.get(Math.floor(t)) || history.serie.get(Math.floor(t) + 1);
  if (!muestra) return b;
  for (const k of Object.keys(muestra)) out[k] = valorMedioEn(history, t, k);
  return out;
}

// Media del histórico en la última hora cerrada (o la más cercana disponible).
export function baselineAt(history, t) {
  if (!history) return null;
  const h = Math.floor(t / 60) - 1;
  for (let k = h; k >= 6; k--) if (history.hourly.has(k)) return { hora: k, ...history.hourly.get(k) };
  return null;
}
