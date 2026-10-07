import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITES } from '../src/data/sites.js';
import { Simulation, runDay } from '../src/sim/engine.js';
import { analyzeSlotting } from '../src/analysis/optimize.js';
import { computeHistory } from '../src/analysis/history.js';
import { answerLocal, routeStatus } from '../src/analysis/assistant.js';

const site = (id) => SITES.find((s) => s.id === id);

test('misma semilla, mismo día', () => {
  const a = runDay(site('mad'), 3).kpis();
  const b = runDay(site('mad'), 3).kpis();
  assert.deepEqual(a, b);
});

test('avanzar a trozos da lo mismo que de una vez', () => {
  const a = new Simulation(site('zgz'));
  a.advance(960);
  const b = new Simulation(site('zgz'));
  for (let i = 0; i < 970; i += 0.37) b.advance(0.37);
  assert.deepEqual(a.kpis(), b.kpis());
});

test('indicadores en rango y palés coherentes', () => {
  for (const s of SITES) {
    const sim = runDay(s, 0);
    const k = sim.kpis();
    for (const f of ['otif', 'fill', 'ocupacion', 'utilizacion']) assert.ok(k[f] >= 0 && k[f] <= 1, `${s.id} ${f}=${k[f]}`);
    assert.ok(k.palesUbicados <= k.palesRecibidos);
    assert.equal(k.palesRecibidos - k.palesUbicados, sim.lanePallets() + sim.forklifts.filter((f) => f.task?.tipo === 'ubicacion').length);
    for (const loc of sim.L.locations) assert.ok(loc.units >= 0);
    assert.equal(sim.orders.filter((o) => o.estado === 'pendiente').length, 0, 'no quedan pedidos sin preparar al cerrar');
  }
});

test('el taller de Zaragoza se nota en el OTIF', () => {
  const hoy = runDay(site('zgz'), 0).kpis().otif;
  const otros = [1, 2, 3].map((d) => runDay(site('zgz'), d).kpis().otif);
  assert.ok(hoy < Math.min(...otros) - 0.08, `hoy ${hoy} vs ${otros}`);
});

test('el slotting ABC reduce recorrido y tiempo', () => {
  for (const s of SITES) {
    const opt = analyzeSlotting(new Simulation(s));
    const [actual, , abc] = opt.escenarios;
    assert.ok(abc.metrosPedido < actual.metrosPedido * (s.calidadSlotting < 0.5 ? 0.8 : 0.95), s.id);
    assert.ok(abc.minutosPedido < actual.minutosPedido, s.id);
  }
});

test('el asistente encuentra la causa en Zaragoza', async () => {
  const s = site('zgz');
  const history = await computeHistory(s, 5);
  const sim = new Simulation(s);
  sim.advance(14.5 * 60 - sim.t);
  const ctx = { sim, history, opt: analyzeSlotting(sim), network: () => [] };
  const r = answerLocal('¿Por qué baja el OTIF hoy?', ctx);
  assert.match(r, /taller/);
  assert.match(r, /C-04/);
  assert.ok(routeStatus(sim).some((x) => x.estado === 'riesgo'));
  assert.match(answerLocal('¿Cómo va la ruta de Pamplona?', ctx), /Ruta Pamplona/);
});
