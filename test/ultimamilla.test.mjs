import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MillaSim, runMillaDay } from '../src/sim/ultimamilla.js';
import { historyFrom } from '../src/analysis/history.js';
import { answerMilla, diagnoseMilla, contextoMilla } from '../src/analysis/asistenteMilla.js';

const historia = (n) => historyFrom((d) => runMillaDay(d), { days: n, fields: ['clasificados', 'corte', 'enRuta', 'pendientes', 'dwell', 'entregados', 'primerIntento', 'productividad', 'recibidos'] });
const a = (h, opts) => { const s = new MillaSim(opts); s.advance(h * 60 - s.t); return s; };

test('última milla: determinista y sin perder bultos', () => {
  assert.deepEqual(runMillaDay(2).kpis(), runMillaDay(2).kpis());
  const x = new MillaSim();
  x.advance(960);
  const y = new MillaSim();
  for (let i = 0; i < 970; i += 0.37) y.advance(0.37);
  assert.deepEqual(x.kpis(), y.kpis());
  // Todo bulto está en un sitio: entregado, ausente, en reparto o esperando en la delegación.
  const s = runMillaDay(0);
  const k = s.kpis();
  assert.equal(k.recibidos, k.total);
  assert.equal(k.clasificados, k.recibidos);
  let enRutas = 0;
  for (const r of s.rutas) enRutas += r.n;
  const enDeleg = s.delegaciones.reduce((n, d) => n + d.stock.reduce((m, l) => m + l.n, 0), 0);
  assert.equal(enRutas + enDeleg, k.cargados);
});

test('última milla: hoy el atasco y el camión tarde mandan bultos a otra ola, y Toledo no llega', () => {
  const k = runMillaDay(0).kpis();
  const normal = [1, 2, 4].map((d) => runMillaDay(d).kpis());
  assert.ok(k.corte < 0.95, `corte ${k.corte}`);
  for (const n of normal) assert.ok(n.corte > 0.97, `normal ${n.corte}`);
  const s = runMillaDay(0);
  const toledo = s.deleg.get('toledo');
  assert.ok(s.sinRepartir(toledo) > 150, `Toledo sin repartir ${s.sinRepartir(toledo)}`);
  assert.ok(k.primerIntento > 0.93 && k.primerIntento < 0.97);
});

test('última milla: el plan B (inducción manual + refuerzo) reparte más', () => {
  const sin = runMillaDay(0).kpis();
  const con = runMillaDay(0, { variant: 'refuerzo' }).kpis();
  assert.ok(con.sinRepartir < sin.sinRepartir - 150, `${con.sinRepartir} vs ${sin.sinRepartir}`);
  assert.ok(con.corte >= sin.corte);
});

test('última milla: el seguimiento de un paquete avanza por todas las etapas', () => {
  const s = runMillaDay(0);
  const entregados = s.seguidos.filter((x) => x.ruta && !x.ausente && s.t >= x.tEntrega);
  assert.ok(entregados.length > 20);
  for (const p of entregados) assert.ok(p.tDescarga <= p.tSort && p.tSort <= p.linea.salida && p.linea.llegada <= p.ruta.salida && p.ruta.salida < p.tEntrega, p.id);
});

test('última milla: el asistente explica el arrastre y cuadra las cifras', async () => {
  const { setLang } = await import('../src/i18n.js');
  const { permitidas, cifrasInventadas } = await import('../lambda/asistente/cifras.mjs');
  const history = await historia(3);
  const sim = a(12.5);
  const ctx = { sim, history, compare: () => ({ hoy: runMillaDay(0).kpis(), refuerzo: runMillaDay(0, { variant: 'refuerzo' }).kpis() }) };
  const r = answerMilla('¿Por qué hay bultos que pierden su ola?', ctx);
  assert.match(r, /Zara/);
  assert.match(r, /sorter/);
  assert.match(answerMilla('¿Cómo va Toledo?', ctx), /Toledo/);
  assert.match(answerMilla('¿Qué cambia con el plan B?', ctx), /Con plan B/);
  assert.match(answerMilla('¿Quién ha creado Estiba?', ctx), /Ali Aauicha/);
  assert.ok(diagnoseMilla(sim, history).hallazgos.some((h) => h.id === 'reparto'));
  for (const l of ['es', 'en']) {
    setLang(l);
    try {
      for (const q of ['¿Cómo va el día?', 'Why are parcels missing their wave?', 'Which depots are struggling?', '¿Qué hago ahora mismo?', '¿Y el sorter?', 'How is Gousto doing?']) {
        const base = answerMilla(q, ctx);
        assert.deepEqual(cifrasInventadas(base, permitidas(contextoMilla(ctx), base, q)), [], `${l}: ${q}`);
        if (l === 'en') assert.doesNotMatch(base, /\b(bultos|delegación|conductores|ola)\b/i, q);
      }
    } finally {
      setLang('es');
    }
  }
});
