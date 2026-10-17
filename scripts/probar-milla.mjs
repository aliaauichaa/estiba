// Calibración de la operativa de última milla: node scripts/probar-milla.mjs [días] [variante]
import { runMillaDay } from '../src/sim/ultimamilla.js';
import { fmt } from '../src/sim/engine.js';
const days = Number(process.argv[2] || 5);
const variant = process.argv[3] || null;
const pct = (v) => (v == null ? '  —  ' : (v * 100).toFixed(1).padStart(5) + '%');
for (let d = 0; d < days; d++) {
  const t0 = performance.now();
  const sim = runMillaDay(d, { variant });
  const k = sim.kpis();
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`día ${d}: total ${k.total} recib ${k.recibidos} clasif ${k.clasificados} pend ${k.pendientes} corte ${pct(k.corte)} dwell ${k.dwell?.toFixed(0)} cargados ${k.cargados} entreg ${k.entregados} fallos ${k.fallos} 1erInt ${pct(k.primerIntento)} prod ${k.productividad?.toFixed(1)} sinRep ${k.sinRepartir} arrastr ${k.arrastrados} incid ${sim.incidencias.map((w) => w.tipo).join(',')} (${ms} ms)`);
  if (d === 0) {
    for (const h of sim.hourly) console.log(`   ${h.hora}h clasif ${h.clasificados} pend ${h.pendientes} enRuta ${h.enRuta} entreg ${h.entregados} corte ${pct(h.corte)}`);
    for (const dl of sim.delegaciones) { const e = sim.delegacion(dl); console.log(`   ${dl.id.padEnd(12)} recib ${dl.recibidos} entreg ${e.entregados} fallos ${e.fallos} sinRep ${sim.sinRepartir(dl)} rutas ${e.rutas} cond ${e.conductores}`); }
    for (const e of sim.events.filter((e) => e.nivel !== 'info').slice(0, 30)) console.log('    ', fmt(e.t), e.es);
  }
}
