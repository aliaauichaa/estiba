// Calibración de la operativa de automoción: node scripts/probar-auto.mjs [días] [variante]
import { runAutoDay } from '../src/sim/automocion.js';
import { fmt } from '../src/sim/engine.js';
const days = Number(process.argv[2] || 5);
const variant = process.argv[3] || null;
const pct = (v) => (v == null ? '  —  ' : (v * 100).toFixed(1).padStart(5) + '%');
for (let d = 0; d < days; d++) {
  const t0 = performance.now();
  const sim = runAutoDay(d, { variant });
  const k = sim.kpis();
  const ms = (performance.now() - t0).toFixed(0);
  const paros = sim.events.filter((e) => e.tipo === 'paro').map((e) => fmt(e.t)).slice(0, 8).join(' ');
  console.log(`día ${d}: plan ${pct(k.plan)} coches ${k.montados}/${k.planificados} paros ${k.paros.toFixed(0)} min (${sim.c.paros}) [${paros}] cob ${k.cobertura} otd1 ${pct(k.otd1)} fpy ${pct(k.fpy)} riesgo ${k.riesgo} incid ${sim.incidencias.map((w) => w.tipo + '@' + fmt(w.desde)).join(',')} (${ms} ms)`);
  if (d === 0) {
    for (const h of sim.hourly) console.log(`   ${h.hora}h coches ${h.coches} paro ${h.paroHora.toFixed(0)} cob ${h.cobertura} riesgo ${h.riesgo}`);
    console.log('   paroPor', JSON.stringify(Object.fromEntries(Object.entries(sim.c.paroPor).map(([a, b]) => [a, Math.round(b)]))));
    for (const e of sim.events.filter((e) => e.nivel !== 'info').slice(0, 30)) console.log('   ', fmt(e.t), e.es);
  }
}
