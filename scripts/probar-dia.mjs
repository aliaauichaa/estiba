// Ejecuta días completos en consola para calibrar los almacenes: node scripts/probar-dia.mjs [días]
import { SITES } from '../src/data/sites.js';
import { runDay, fmt } from '../src/sim/engine.js';
const days = Number(process.argv[2] || 4);
const pct = (v) => (v == null ? '  —  ' : (v * 100).toFixed(1).padStart(5) + '%');
for (const site of SITES) {
  for (let d = 0; d < days; d++) {
    const t0 = performance.now();
    const sim = runDay(site, d);
    const k = sim.kpis();
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`${site.id} día ${d}: OTIF ${pct(k.otif)} aTiempo ${pct(k.aTiempo)} fill ${pct(k.fill)} DTS ${k.dts?.toFixed(0)} min ocup ${pct(k.ocupacion)} util ${pct(k.utilizacion)} m/línea ${k.metrosLinea?.toFixed(1)} espera ${k.esperaMedia?.toFixed(0)} sinHueco ${k.sinHueco} bloqueo ${k.bloqueoCalle.toFixed(0)} pend ${k.pendientes} pedidos ${sim.orders.length} pales ${k.palesUbicados}/${k.palesRecibidos} (${ms} ms)`);
  }
}
