// Histórico de los 14 días anteriores de un almacén (mismo motor, otras semillas).
// Sirve de línea base: cada indicador de hoy se compara con la media a la misma hora.

import { runDay } from '../sim/engine.js';

const FIELDS = ['otif', 'aTiempo', 'fill', 'dts', 'ocupacion', 'productividad', 'utilizacion', 'metrosLinea', 'lineas', 'pales', 'equipos', 'patio', 'calle', 'bloqueo'];

export async function computeHistory(site, days = 14) {
  const out = [];
  for (let d = 1; d <= days; d++) {
    const sim = runDay(site, d);
    out.push({ day: d, kpis: sim.kpis(), hourly: sim.hourly, incidencias: sim.incidencias.length });
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
    for (const f of FIELDS) {
      const vals = rows.map((r) => r[f]).filter((v) => v != null && Number.isFinite(v));
      avg[f] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    hourly.set(hora, avg);
  }
  const final = {};
  for (const f of ['otif', 'aTiempo', 'fill', 'dts', 'ocupacion', 'productividad', 'utilizacion', 'metrosLinea', 'esperaMedia']) {
    const vals = out.map((d) => d.kpis[f]).filter((v) => v != null);
    final[f] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return { days: out, hourly, final };
}

// Media del histórico en la última hora cerrada (o la más cercana disponible).
export function baselineAt(history, t) {
  if (!history) return null;
  const h = Math.floor(t / 60) - 1;
  for (let k = h; k >= 6; k--) if (history.hourly.has(k)) return { hora: k, ...history.hourly.get(k) };
  return null;
}
