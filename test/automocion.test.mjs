import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoSim, runAutoDay } from '../src/sim/automocion.js';
import { historyFrom } from '../src/analysis/history.js';
import { answerAuto, diagnoseAuto, contextoAuto, accionesAuto } from '../src/analysis/asistenteAuto.js';
import { MODULOS } from '../src/data/automocion.js';

const historia = (n) => historyFrom((d) => runAutoDay(d), { days: n, fields: ['coches', 'plan', 'paros', 'cobertura', 'otd1', 'fpy', 'riesgo', 'montados'] });
const a = (h) => { const s = new AutoSim(); s.advance(h * 60 - s.t); return s; };

test('automoción: misma semilla, mismo día, y avanzar a trozos da lo mismo', () => {
  assert.deepEqual(runAutoDay(2).kpis(), runAutoDay(2).kpis());
  const x = new AutoSim();
  x.advance(960);
  const y = new AutoSim();
  for (let i = 0; i < 970; i += 0.37) y.advance(0.37);
  assert.deepEqual(x.kpis(), y.kpis());
});

test('automoción: los días normales cumplen el plan y hoy los chips paran la línea', () => {
  for (const d of [1, 2, 3, 4]) {
    const k = runAutoDay(d).kpis();
    assert.ok(k.plan >= 0.97, `día ${d}: plan ${k.plan}`);
  }
  const hoy = runAutoDay(0);
  assert.ok(hoy.kpis().plan < 0.85, `hoy ${hoy.kpis().plan}`);
  assert.ok(hoy.c.paroPor.frontal + hoy.c.paroPor.cockpit > 60, 'los paros largos son de módulos con centralitas');
  assert.ok(hoy.c.paroPor.asientos > 0, 'el retraso de la lanzadera de asientos para la línea por la mañana');
  // Coherencia de la secuencia: nunca se monta un módulo que no ha llegado ni llega uno sin fabricar.
  for (const m of MODULOS) {
    const s = hoy.seq[m.id];
    assert.ok(s.montado <= s.llegado && s.llegado <= s.enviado && s.enviado <= s.hecho, m.id);
  }
  for (const p of hoy.plantas) for (const c of p.usa || []) assert.ok(p.inv[c] >= 0, `${p.id} ${c}`);
});

test('automoción: el plan B (segundo proveedor de chips) salva el día', () => {
  const sin = runAutoDay(0).kpis();
  const con = runAutoDay(0, { variant: 'dual' }).kpis();
  assert.ok(con.montados > sin.montados + 60, `${con.montados} vs ${sin.montados}`);
  assert.ok(con.paros < sin.paros / 3);
});

test('automoción: el asistente sigue la cadena hasta el Tier 3', async () => {
  const history = await historia(3);
  const sim = a(17);
  const ctx = { sim, history, compare: () => ({ hoy: runAutoDay(0).kpis(), dual: runAutoDay(0, { variant: 'dual' }).kpis() }) };
  const r = answerAuto('¿Por qué se para la línea?', ctx);
  assert.match(r, /Semiconductores/);
  assert.match(r, /Electrónica/);
  assert.match(answerAuto('¿Qué pasaría con el plan B?', ctx), /Con plan B/);
  assert.match(answerAuto('¿Cómo va Asientos?', ctx), /Asientos \(Tier 1\)/);
  assert.match(answerAuto('¿Quién ha creado Estiba?', ctx), /Ali Aauicha/);
  const d = diagnoseAuto(sim, history);
  assert.equal(d.hallazgos[0].id, 'paros');
  assert.ok(accionesAuto(d).some((x) => /plan B/.test(x.texto)));
});

test('automoción: en inglés y con las cifras que comprueba la Lambda', async () => {
  const { setLang } = await import('../src/i18n.js');
  const { permitidas, cifrasInventadas } = await import('../lambda/asistente/cifras.mjs');
  const history = await historia(3);
  const sim = a(15.5);
  const ctx = { sim, history, compare: () => ({ hoy: runAutoDay(0).kpis(), dual: runAutoDay(0, { variant: 'dual' }).kpis() }) };
  for (const l of ['es', 'en']) {
    setLang(l);
    try {
      for (const q of ['¿Cómo va la producción?', 'Why does the line stop?', 'Which suppliers are at risk?', '¿Qué hago ahora mismo?', 'How are the shuttles doing?', '¿Y la calidad?']) {
        const base = answerAuto(q, ctx);
        assert.deepEqual(cifrasInventadas(base, permitidas(contextoAuto(ctx), base, q)), [], `${l}: ${q}`);
        if (l === 'en') assert.doesNotMatch(base, /\b(línea|parada|cobertura|lanzadera)\b/i, q);
      }
    } finally {
      setLang('es');
    }
  }
});

test('automoción: con el plan B elegido no se recomienda activarlo otra vez (antes ni después de que entre)', () => {
  for (const h of [8, 14]) {
    const sim = new AutoSim({ variant: 'dual' });
    sim.advance(h * 60 - sim.t);
    const acciones = accionesAuto(diagnoseAuto(sim, null));
    for (const a of acciones) assert.doesNotMatch(a.texto, /Activar el proveedor alternativo/, `${h}h: ${a.texto}`);
  }
});
