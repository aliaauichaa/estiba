// Análisis de slotting y de secuencia de picking sobre los pedidos de hoy.
// Compara tres escenarios con el mismo punto de partida (la playa de expedición):
//   1. Como está: ubicaciones actuales y recorrido en el orden del albarán.
//   2. Ruta optimizada: mismas ubicaciones, visita por vecino más próximo.
//   3. Slotting ABC + ruta: las referencias que más líneas mueven, en los huecos más baratos.

import { DIM, locationCost, routeAsListed, routeNearest } from '../sim/layout.js';

const SHIFT_HOURS = 8;

function lineMinutes(loc, qty) {
  return 0.6 + 0.14 * qty + 0.15 * loc.level;
}

function evaluate(sim, faceOf, routeFn) {
  const L = sim.L;
  let metros = 0;
  let minutos = 0;
  let lineas = 0;
  let nivel = 0;
  for (const o of sim.orders) {
    const stops = [];
    const seen = new Set();
    for (const l of o.lines) {
      const loc = L.locations[faceOf(l.sku)];
      minutos += lineMinutes(loc, l.qty);
      nivel += loc.level;
      lineas++;
      if (!seen.has(loc.idx)) { seen.add(loc.idx); stops.push(loc.pick); }
    }
    const r = routeFn(L, L.depotOut, stops, L.depotOut);
    metros += r.dist;
    minutos += r.dist / DIM.SPEED;
  }
  const n = sim.orders.length || 1;
  return {
    metrosPedido: metros / n,
    metrosLinea: metros / (lineas || 1),
    minutosPedido: minutos / n,
    horasDia: minutos / 60,
    nivelMedio: nivel / (lineas || 1),
  };
}

export function analyzeSlotting(sim) {
  const L = sim.L;
  const locs = L.locations;
  const current = (s) => sim.skus[s].face;

  // Propuesta: huecos ordenados por coste (distancia a expedición + altura), referencias por líneas previstas.
  const ranked = locs.map((l) => ({ l, cost: locationCost(L, l) })).sort((a, b) => a.cost - b.cost);
  const bySku = sim.skus.slice().sort((a, b) => b.share - a.share);
  const proposal = new Map();
  bySku.forEach((sku, i) => proposal.set(sku.idx, ranked[i].l.idx));
  const proposed = (s) => proposal.get(s);

  const escenarios = [
    { id: 'actual', nombre: 'Como está hoy', ...evaluate(sim, current, routeAsListed) },
    { id: 'ruta', nombre: 'Con ruta optimizada', ...evaluate(sim, current, routeNearest) },
    { id: 'abc', nombre: 'Slotting ABC + ruta', ...evaluate(sim, proposed, routeNearest) },
  ];
  const base = escenarios[0];
  for (const e of escenarios) {
    e.ahorro = 1 - e.minutosPedido / base.minutosPedido;
    e.ahorroMetros = 1 - e.metrosPedido / base.metrosPedido;
  }
  const best = escenarios[2];
  const horasAhorro = base.horasDia - best.horasDia;

  // Zona dorada: el 20 % de huecos más baratos. ¿Cuántas A están fuera?
  const goldenCut = ranked[Math.floor(ranked.length * 0.2)].cost;
  const costOf = new Map(ranked.map((r) => [r.l.idx, r.cost]));
  const aSkus = sim.skus.filter((s) => s.cls === 'A');
  const aFuera = aSkus.filter((s) => costOf.get(s.face) > goldenCut).length;

  const movimientos = [];
  for (const sku of sim.skus) {
    const from = sku.face;
    const to = proposal.get(sku.idx);
    if (from === to) continue;
    const gain = (costOf.get(from) - costOf.get(to)) * sku.share;
    movimientos.push({ sku, from: locs[from], to: locs[to], gain });
  }
  movimientos.sort((a, b) => b.gain - a.gain);

  return {
    escenarios,
    horasAhorro,
    equipos: horasAhorro / SHIFT_HOURS,
    aTotal: aSkus.length,
    aFuera,
    cambios: movimientos.length,
    top: movimientos.slice(0, 8),
    pedidos: sim.orders.length,
  };
}
