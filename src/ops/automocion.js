// Operativa 2: cadena de suministro de automoción. Proveedores Tier 3 → Tier 2 → Tier 1 (módulos en
// secuencia) → línea de montaje del fabricante, todo en la misma escena.

import { AutoSim, runAutoDay, textoCuota } from '../sim/automocion.js';
import { SHIFT_START, fmt } from '../sim/engine.js';
import { AutoScene } from '../scene/automocion3d.js';
import { historyFrom } from '../analysis/history.js';
import { diagnoseAuto, answerAuto, sugerenciasAuto, contextoAuto, contextoDeRutaAuto } from '../analysis/asistenteAuto.js';
import { MODULOS, INSUMOS, ESTACIONES, TAKT } from '../data/automocion.js';
import { tx, pct, num } from '../i18n.js';
import { esc } from '../ui/md.js';

const pad = (n) => String(n).padStart(2, '0');
const insumo = (c) => tx(INSUMOS[c].es, INSUMOS[c].en);
const nomMod = (id) => { const m = MODULOS.find((x) => x.id === id); return tx(m.es, m.en); };
const bar = (f, cls = '') => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, f * 100))}%"></span></div>`;

const KPIS = [
  { id: 'plan', label: () => tx('Plan de producción', 'Production plan'), tip: () => tx('Coches montados sobre los planificados hasta ahora (takt de 2 min)', 'Cars built over cars planned so far (2-min takt)'), f: (v) => pct(v), up: true, unit: 'pp' },
  { id: 'montados', label: () => tx('Coches montados', 'Cars built'), tip: () => tx('Coches que han salido de la última estación', 'Cars that have left the last station'), f: (v, k) => `${num(v)}<small>/${num(k.planificados)}</small>`, up: true, unit: '', tol: 0.01 },
  { id: 'paros', label: () => tx('Paros de línea', 'Line stops'), tip: () => tx('Minutos con la línea parada por falta de algún módulo', 'Minutes with the line stopped for a missing module'), f: (v) => `${num(v)}<small>min</small>`, up: false, unit: 'min' },
  { id: 'cobertura', label: () => tx('Cobertura JIS', 'JIS coverage'), tip: () => tx('Minutos de producción que cubre el módulo más justo a pie de línea', 'Minutes of production covered by the tightest line-side module'), f: (v) => `${num(v)}<small>min</small>`, up: true, unit: 'min', minDiff: 5 },
  { id: 'otd1', label: () => tx('Lanzaderas a tiempo', 'Shuttles on time'), tip: () => tx('Lanzaderas de Tier 1 que llegan a línea con menos de 5 min de retraso', 'Tier 1 shuttles reaching the line less than 5 min late'), f: (v) => pct(v), up: true, unit: 'pp' },
  { id: 'fpy', minN: (k) => k.probados >= 30, label: () => 'FPY', tip: () => tx('Coches que pasan el banco de pruebas a la primera', 'Cars passing the end-of-line test first time'), f: (v) => pct(v), up: true, unit: 'pp' },
  { id: 'riesgo', label: () => tx('Insumos en riesgo', 'Inputs at risk'), tip: () => tx('Insumos de Tier 1 y Tier 2 con menos de 1 hora de cobertura', 'Tier 1 and Tier 2 inputs with under 1 hour of coverage'), f: (v) => num(v), up: false, unit: '' },
];

const CHART = {
  legend: () => [
    { color: '#f5a524', label: tx('Coches/hora (hoy)', 'Cars/hour (today)') },
    { color: '#5d6a7d', label: tx('Coches/hora (media 14 días)', 'Cars/hour (14-day average)') },
    { color: '#2ec4b6', label: tx('Cumplimiento del plan', 'Plan attainment') },
    { color: '#6c9cf0', label: tx('Cobertura JIS mínima (0–60 min)', 'Minimum JIS coverage (0–60 min)') },
  ],
  bars: 'coches',
  pct: 'plan',
  line: 'cobertura',
  lineMax: () => 60,
  tip: (r, b) => [
    `${tx('Coches', 'Cars')}: ${r.coches} (${tx('media', 'avg')} ${b ? num(b.coches) : '—'})`,
    `${tx('Plan', 'Plan')}: ${pct(r.plan)} (${tx('media', 'avg')} ${pct(b?.plan)})`,
    `${tx('Paro en la hora', 'Stopped this hour')}: ${num(r.paroHora)} min`,
    `${tx('Cobertura JIS', 'JIS coverage')}: ${num(r.cobertura)} min`,
  ],
  tipBase: (b) => `${tx('Media', 'Average')}: ${b ? num(b.coches) : '—'} ${tx('coches', 'cars')} · ${tx('plan', 'plan')} ${pct(b?.plan)}`,
};

const LEYENDAS = {
  flujo: () => tx(
    '<span><i style="background:#0e7490"></i>Tier 3</span><span><i style="background:#0891b2"></i>Tier 2</span><span><i style="background:#22d3ee"></i>Tier 1</span><span><i style="background:#f5a524"></i>Lanzadera JIT</span><span><i style="background:#46c46f;border-radius:50%"></i>Produce</span><span><i style="background:#ff6b5e;border-radius:50%"></i>Parada</span>',
    '<span><i style="background:#0e7490"></i>Tier 3</span><span><i style="background:#0891b2"></i>Tier 2</span><span><i style="background:#22d3ee"></i>Tier 1</span><span><i style="background:#f5a524"></i>JIT shuttle</span><span><i style="background:#46c46f;border-radius:50%"></i>Producing</span><span><i style="background:#ff6b5e;border-radius:50%"></i>Stopped</span>',
  ),
  cobertura: () => tx(
    '<span>Cobertura del insumo más justo:</span><span><i style="background:#46c46f"></i>más de 2,5 h</span><span><i style="background:#f5a524"></i>1–2,5 h</span><span><i style="background:#ff6b5e"></i>menos de 1 h o cuota recortada</span>',
    '<span>Coverage of the tightest input:</span><span><i style="background:#46c46f"></i>over 2.5 h</span><span><i style="background:#f5a524"></i>1–2.5 h</span><span><i style="background:#ff6b5e"></i>under 1 h or allocation cut</span>',
  ),
};

// ---------------------------------------------------------------------------- estado y paneles

function estadoPlanta(p) {
  if (p.averia) return [tx('Avería', 'Breakdown'), 'bad'];
  if (p.falta) return [`${tx('Sin', 'No')} ${insumo(p.falta)}`, 'bad'];
  if (p.cuota != null) return [`${tx('Cuota', 'Allocation')} ${textoCuota(p)}`, 'warn'];
  return [tx('Produciendo', 'Producing'), 'ok'];
}

function peorInsumo(sim, p) {
  let peor = null;
  for (const c of p.usa || []) {
    const cob = sim.coberturaInsumo(p, c);
    if (!peor || cob < peor.cob) peor = { c, cob };
  }
  return peor;
}

function dondeCoche(sim, car) {
  const s = sim.head - 1 - car.n;
  if (car.tExpedido != null) return [tx('Expedido', 'Shipped'), 'ok', `${car.destino} · ${fmt(car.tExpedido)}`];
  if (sim.campa.includes(car)) return [tx('En campa', 'In car park'), 'ok', fmt(car.tCampa)];
  if (car.ok === false && car.retrabajo != null) return [tx('Retrabajo', 'Rework'), 'warn', `${tx('hasta', 'until')} ${fmt(car.retrabajo)}`];
  if (sim.eol.includes(car)) return [tx('Banco de pruebas', 'Test bench'), 'info', fmt(car.tPrueba)];
  if (s >= 0 && s < ESTACIONES) return [`S${pad(s + 1)}`, 'info', pct((s + 1) / ESTACIONES, 0)];
  return [tx('En secuencia', 'In sequence'), '', `${tx('entra hacia las', 'enters around')} ${fmt(sim.t + (car.n - sim.head + 1) * TAKT)}`];
}

// Estado del módulo de un coche: montado, a pie de línea, en camino, fabricado en el Tier 1 o pendiente.
function moduloDe(sim, car, m) {
  const s = sim.seq[m.id];
  if (car.n < s.montado) return { estado: 'montado', txt: tx('montado', 'fitted'), cls: 'ok' };
  if (car.n < s.llegado) return { estado: 'linea', txt: tx('a pie de línea', 'at the line'), cls: 'ok' };
  if (car.n < s.enviado) {
    const k = sim.camiones.find((c) => c.estado === 'ruta' && c.modulo === m.id && car.n >= c.desdeSeq && car.n < c.desdeSeq + c.n);
    return { estado: 'ruta', txt: `${tx('en camino', 'on its way')}${k ? ` · ${fmt(k.llegada)}` : ''}`, cls: 'info', cam: k };
  }
  if (car.n < s.hecho) return { estado: 'hecho', txt: tx('fabricado en Tier 1', 'built at Tier 1'), cls: 'info' };
  return { estado: 'pend', txt: tx('sin fabricar', 'not built yet'), cls: sim.planta.get(m.t1).falta ? 'bad' : '' };
}

function renderLinea(sim) {
  const k = sim.kpis();
  const estado = sim.parada
    ? `<div class="callout bad"><b>${tx('Línea parada', 'Line stopped')}</b> ${tx('desde las', 'since')} ${fmt(sim.parada.desde)}: ${tx('falta', 'missing')} ${sim.parada.faltan.map((id) => esc(nomMod(id)).toLowerCase()).join(', ')}.</div>`
    : `<div class="callout"><b>${tx('Línea en marcha', 'Line running')}</b> · ${num(60 / TAKT)} ${tx('coches/hora', 'cars/hour')} · ${k.montados}/${k.planificados} ${tx('coches hoy', 'cars today')}.</div>`;
  const mods = MODULOS.map((m) => {
    const cob = sim.coberturaModulo(m.id);
    const prox = sim.camiones.filter((c) => c.estado === 'ruta' && c.modulo === m.id).sort((a, b) => a.llegada - b.llegada)[0];
    const cls = cob < 16 ? 'bad' : cob < 40 ? 'warn' : '';
    return `<tr class="click" data-sel="planta:${m.t1}"><td><b>${esc(tx(m.es, m.en))}</b><br><span class="muted mono" style="font-size:11px">S${pad(m.estacion + 1)}</span></td>
      <td style="min-width:90px">${bar(cob / 60, cls)}<span class="muted mono" style="font-size:11px">${cob} min</span></td>
      <td class="num">${prox ? `${fmt(prox.llegada)}${prox.llegada - prox.prevista > 10 ? ' ⚠' : ''}` : '—'}</td></tr>`;
  }).join('');
  const coches = [];
  for (let s = ESTACIONES - 1; s >= 0; s--) {
    const car = sim.cocheEn(s);
    if (!car || car.tSalida != null) continue;
    const m = MODULOS.find((x) => x.estacion === s);
    coches.push(`<tr class="click" data-sel="coche:${car.id}"><td class="mono">S${pad(s + 1)}${m ? ` <span class="muted">${esc(tx(m.es, m.en))}</span>` : ''}</td><td class="mono">${car.id}</td><td><i class="sw" style="background:#${car.color.hex.toString(16).padStart(6, '0')}"></i>${esc(tx(car.modelo.es, car.modelo.en))}</td></tr>`);
  }
  const pruebas = sim.eol.filter((c) => c.ok !== false).length;
  const retrabajo = sim.eol.filter((c) => c.ok === false).length;
  return `${estado}
    <div class="sec" style="margin-top:14px"><h4>${tx('Módulos a pie de línea', 'Line-side modules')}</h4>
      <table class="t"><thead><tr><th>${tx('Módulo', 'Module')}</th><th>${tx('Cobertura', 'Coverage')}</th><th class="num">${tx('Próx. lanzadera', 'Next shuttle')}</th></tr></thead><tbody>${mods}</tbody></table>
      <p class="note">${tx('Los Tier 1 fabrican cada módulo en el orden exacto de los coches (secuencia JIS) y lo mandan en lanzaderas de 12. Si en una estación falta el módulo del coche que llega, se para toda la línea.', 'Tier 1s build each module in the exact order of the cars (JIS sequence) and ship it in shuttles of 12. If a station is missing the module for the incoming car, the whole line stops.')}</p></div>
    <div class="sec"><h4>${tx('Coches en la línea', 'Cars on the line')}</h4>
      <table class="t"><thead><tr><th>${tx('Estación', 'Station')}</th><th>${tx('Orden', 'Order')}</th><th>${tx('Modelo', 'Model')}</th></tr></thead><tbody>${coches.join('')}</tbody></table></div>
    <div class="sec"><h4>${tx('Fin de línea', 'End of line')}</h4><dl class="kv"><dt>${tx('En el banco de pruebas', 'At the test bench')}</dt><dd>${pruebas}</dd><dt>${tx('En retrabajo', 'In rework')}</dt><dd>${retrabajo}</dd><dt>${tx('En campa', 'In the car park')}</dt><dd>${sim.campa.length}</dd><dt>${tx('Expedidos hoy', 'Shipped today')}</dt><dd>${sim.c.expedidos}</dd></dl></div>`;
}

function renderRed(sim) {
  const filas = (tier) => sim.plantas.filter((p) => p.tier === tier).map((p) => {
    const [txt, cls] = estadoPlanta(p);
    const peor = peorInsumo(sim, p);
    const cob = peor ? `${bar(Math.min(1, peor.cob / 240), peor.cob < 60 ? 'bad' : peor.cob < 150 ? 'warn' : '')}<span class="muted mono" style="font-size:11px">${esc(insumo(peor.c))} · ${num(peor.cob)} min</span>`
      : `<span class="muted mono" style="font-size:11px">${tx('stock', 'stock')} ${p.fg}</span>`;
    return `<tr class="click" data-sel="planta:${p.id}"><td><b>${esc(p.nombre)}</b></td><td><span class="pill ${cls}">${esc(txt)}</span></td><td style="min-width:110px">${cob}</td><td class="num">${p.hechoHoy}</td></tr>`;
  }).join('');
  const tabla = (tier, titulo) => `<div class="sec"><h4>${titulo}</h4><table class="t"><thead><tr><th>${tx('Planta', 'Plant')}</th><th>${tx('Estado', 'Status')}</th><th>${tx('Insumo más justo', 'Tightest input')}</th><th class="num">${tx('Hoy', 'Today')}</th></tr></thead><tbody>${filas(tier)}</tbody></table></div>`;
  const enRuta = sim.camiones.filter((c) => c.estado === 'ruta').length;
  return `${tabla(1, tx('Tier 1 · módulos', 'Tier 1 · modules'))}${tabla(2, tx('Tier 2 · componentes', 'Tier 2 · components'))}${tabla(3, tx('Tier 3 · materias primas', 'Tier 3 · raw materials'))}
    <p class="note">${tx(`${enRuta} camiones en ruta. Cada cliente pide a su proveedor cuando su stock más lo que viene de camino baja del punto de pedido (aprovisionamiento por tirón). «Hoy» son juegos fabricados.`, `${enRuta} trucks on the road. Each customer orders from its supplier when stock plus what is on the way drops below the reorder point (pull replenishment). "Today" is sets produced.`)}</p>`;
}

function renderPlanB(local, ui) {
  const c = local.compare();
  const on = ui.variant === 'dual';
  const fila = (label, a, b, f) => `<tr><td>${label}</td><td class="num">${f(a)}</td><td class="num">${f(b)}</td></tr>`;
  return `<div class="callout amber">${tx(
    '<b>Plan B: proveedor alternativo de chips.</b> Hoy el fabricante de semiconductores (Tier 3) ha recortado la cuota al 25 %. Si a las 10:00 se activa un segundo proveedor (a través de un distribuidor), ¿cuánto se salva del día?',
    '<b>Plan B: alternative chip supplier.</b> Today the semiconductor maker (Tier 3) cut the allocation to 25%. If a second supplier (through a distributor) is activated at 10:00, how much of the day is saved?',
  )}</div>
    <div class="btn-row"><button class="btn" data-act="dual-toggle">${on ? tx('Volver al día sin plan B', 'Back to the day without plan B') : tx('Simular hoy con el plan B', 'Simulate today with plan B')}</button></div>
    ${on ? `<p class="note">${tx('Estás viendo el día re-simulado con el plan B desde las 06:00.', 'You are watching the day re-simulated with plan B from 06:00.')}</p>` : ''}
    <div class="sec" style="margin-top:14px"><h4>${tx('Día completo simulado', 'Full simulated day')}</h4><table class="t"><thead><tr><th></th><th class="num">${tx('Sin plan B', 'Without')}</th><th class="num">${tx('Con plan B', 'With plan B')}</th></tr></thead><tbody>
      ${fila(tx('Coches montados', 'Cars built'), c.hoy.montados, c.dual.montados, num)}
      ${fila(tx('Plan de producción', 'Production plan'), c.hoy.plan, c.dual.plan, (v) => pct(v))}
      ${fila(tx('Minutos de paro', 'Minutes stopped'), c.hoy.paros, c.dual.paros, (v) => num(v))}
      ${fila(tx('Lanzaderas a tiempo', 'Shuttles on time'), c.hoy.otd1, c.dual.otd1, (v) => pct(v))}</tbody></table>
      <p class="note">${tx('Mismo día, mismos coches, transportes e incidencias; solo cambia el suministro de chips desde las 10:00. Los chips del segundo proveedor tardan lo mismo en llegar (unas 2 horas y media) y luego pasan por Electrónica y por los Tier 1.', 'Same day, same cars, transport and incidents; only the chip supply changes from 10:00. Chips from the second supplier take just as long to arrive (about two and a half hours) and then go through Electronics and the Tier 1s.')}</p></div>`;
}

function renderSel(sim, sel) {
  const back = `<button class="back" data-sel="none">← ${tx('Volver al resumen', 'Back to overview')}</button>`;
  if (sel.kind === 'planta') {
    const p = sim.planta.get(sel.id);
    if (!p) return null;
    const [txt, cls] = estadoPlanta(p);
    const ins = (p.usa || []).map((c) => {
      const cob = sim.coberturaInsumo(p, c);
      const sup = sim.proveedorDe.get(c);
      return `<tr class="click" data-sel="planta:${sup.id}"><td>${esc(insumo(c))}<br><span class="muted" style="font-size:11px">${esc(sup.nombre)} · Tier ${sup.tier}</span></td><td class="num">${p.inv[c]}</td><td style="min-width:80px">${bar(Math.min(1, cob / 240), cob < 60 ? 'bad' : cob < 150 ? 'warn' : '')}<span class="muted mono" style="font-size:11px">${num(cob)} min</span></td><td class="num">${sim.enCamino(p, c) || '—'}</td></tr>`;
    }).join('');
    const clientes = p.tier === 1 ? tx('Línea de montaje', 'Assembly line') : p.clientes.map((q) => q.nombre).join(', ');
    const sale = sim.camiones.filter((c) => c.estado === 'ruta' && c.origen === p).sort((a, b) => a.llegada - b.llegada);
    return `${back}<div class="title-row"><span class="big">${esc(p.nombre)}</span><span class="pill ${cls}">${esc(txt)}</span></div>
      <div class="sec"><dl class="kv"><dt>${tx('Nivel', 'Tier')}</dt><dd>Tier ${p.tier}</dd><dt>${tx('Fabrica', 'Makes')}</dt><dd>${esc(p.tier === 1 ? nomMod(p.modulo) : insumo(p.produce))}</dd>
        <dt>${tx('Capacidad', 'Capacity')}</dt><dd>${num(p.ritmo * 60)} ${tx('juegos/h', 'sets/h')}${p.cuota != null ? ` · ${tx('cuota', 'allocation')} ${textoCuota(p)}` : ''}</dd><dt>${tx('Fabricado hoy', 'Made today')}</dt><dd>${p.hechoHoy}</dd>
        ${p.tier !== 1 ? `<dt>${tx('Stock terminado', 'Finished stock')}</dt><dd>${p.fg}</dd>` : `<dt>${tx('Módulos adelantados', 'Modules ahead')}</dt><dd>${sim.seq[p.modulo].hecho - sim.seq[p.modulo].montado}</dd>`}
        <dt>${tx('Clientes', 'Customers')}</dt><dd>${esc(clientes)}</dd><dt>${tx('Camiones en ruta', 'Trucks on the road')}</dt><dd>${sale.length}</dd></dl></div>
      ${ins ? `<div class="sec"><h4>${tx('Insumos', 'Inputs')}</h4><table class="t"><thead><tr><th>${tx('Insumo', 'Input')}</th><th class="num">Stock</th><th>${tx('Cobertura', 'Coverage')}</th><th class="num">${tx('En camino', 'Inbound')}</th></tr></thead><tbody>${ins}</tbody></table></div>` : ''}
      ${p.averia ? `<p class="note">${tx(`Avería hasta las ${fmt(p.averia.hasta)}.`, `Breakdown until ${fmt(p.averia.hasta)}.`)}</p>` : ''}`;
  }
  if (sel.kind === 'camion') {
    const k = sim.camiones.find((c) => c.id === sel.id);
    if (!k) return null;
    const que = k.tipo === 't1' ? `${nomMod(k.modulo)} · ${tx('en secuencia', 'in sequence')}` : insumo(k.insumo);
    const destino = k.tipo === 't1' ? tx('Línea de montaje', 'Assembly line') : k.destino.nombre;
    const f = Math.max(0, Math.min(1, (sim.t - k.salida) / Math.max(1, k.llegada - k.salida)));
    const tarde = k.llegada - k.prevista;
    return `${back}<div class="title-row"><span class="big">${k.id}</span><span class="pill ${tarde > 10 ? 'bad' : k.estado === 'ruta' ? 'info' : 'ok'}">${k.estado === 'ruta' ? (tarde > 10 ? tx('Con retraso', 'Late') : tx('En ruta', 'On the road')) : tx('Entregado', 'Delivered')}</span></div>
      <div class="sec"><dl class="kv"><dt>${tx('Origen', 'From')}</dt><dd>${esc(k.origen.nombre)} · Tier ${k.origen.tier}</dd><dt>${tx('Destino', 'To')}</dt><dd>${esc(destino)}</dd>
        <dt>${tx('Carga', 'Load')}</dt><dd>${k.n} · ${esc(que)}</dd><dt>${tx('Salida', 'Departed')}</dt><dd>${fmt(k.salida)}</dd><dt>${tx('Llegada prevista', 'Planned arrival')}</dt><dd>${fmt(k.prevista)}</dd>
        <dt>ETA</dt><dd>${fmt(k.llegada)}${tarde > 1 ? ` (+${Math.round(tarde)} min)` : ''}</dd></dl>${bar(f, tarde > 10 ? 'bad' : '')}</div>
      ${k.incidencia ? `<p class="note">${esc(tx(k.incidencia.es, k.incidencia.en))}.</p>` : ''}`;
  }
  if (sel.kind === 'coche') {
    const car = sim.coches.find((c) => c.id === sel.id);
    if (!car) return null;
    const [txt, cls, det] = dondeCoche(sim, car);
    const mods = MODULOS.map((m) => { const e = moduloDe(sim, car, m); return `<tr><td>${esc(tx(m.es, m.en))}</td><td><span class="pill ${e.cls}">${esc(e.txt)}</span></td></tr>`; }).join('');
    return `${back}<div class="title-row"><span class="big">${car.id}</span><span class="pill ${cls}">${esc(txt)}</span></div>
      <div class="sec"><dl class="kv"><dt>${tx('Modelo', 'Model')}</dt><dd>${esc(car.nombre)}</dd><dt>${tx('Concesionario', 'Dealer')}</dt><dd>${esc(car.destino)}</dd><dt>${tx('Situación', 'Where')}</dt><dd>${esc(det)}</dd>
        ${car.tEntrada != null ? `<dt>${tx('Entró en línea', 'Entered the line')}</dt><dd>${fmt(car.tEntrada)}</dd>` : ''}${car.tSalida != null ? `<dt>${tx('Salió de línea', 'Left the line')}</dt><dd>${fmt(car.tSalida)}</dd>` : ''}</dl></div>
      <div class="sec"><h4>${tx('Sus módulos', 'Its modules')}</h4><table class="t"><tbody>${mods}</tbody></table></div>`;
  }
  return null;
}

// ---------------------------------------------------------------------------- seguimiento

function cochesSeguibles(sim) {
  const out = [];
  if (sim.parada) {
    for (const id of sim.parada.faltan) {
      const m = MODULOS.find((x) => x.id === id);
      const car = sim.coches[sim.head - m.estacion];
      if (car) out.push(car);
    }
  }
  for (let s = ESTACIONES - 1; s >= 0; s--) { const c = sim.cocheEn(s); if (c && c.tSalida == null && !out.includes(c)) out.push(c); }
  for (let i = 0; i < 6; i++) { const c = sim.coches[sim.head + i]; if (c && !out.includes(c)) out.push(c); }
  // Toda la campa (nunca pasa de 8): cualquier coche que se pueda pulsar en la escena se puede seguir.
  out.push(...sim.eol, ...sim.campa.slice().reverse());
  return out;
}

function vistaCoche(sim, car) {
  const est = (h, n) => (h ? 'done' : n ? 'now' : 'next');
  const mods = MODULOS.map((m) => ({ m, e: moduloDe(sim, car, m) }));
  const enLinea = car.tEntrada != null && car.tSalida == null;
  const sinFab = mods.find((x) => x.e.estado === 'pend' && x.e.cls === 'bad');
  const enCamino = mods.find((x) => x.e.estado === 'ruta');
  const listos = mods.filter((x) => ['montado', 'linea'].includes(x.e.estado)).length;
  const s = sim.head - 1 - car.n;
  const bloqueado = sim.parada && sim.parada.faltan.some((id) => sim.coches[sim.head - MODULOS.find((x) => x.id === id).estacion] === car);
  const pasos = [
    { label: tx('Pedido', 'Order'), det: car.destino, estado: 'done' },
    {
      label: tx('Módulos Tier 1', 'Tier 1 modules'),
      det: sinFab ? `${tx(sinFab.m.es, sinFab.m.en)}: ${tx('sin fabricar', 'not built')}` : enCamino ? `${tx(enCamino.m.es, enCamino.m.en)} ${enCamino.e.txt}` : `${listos}/4 ${tx('en línea', 'at the line')}`,
      estado: bloqueado || sinFab ? 'bad' : listos === 4 ? 'done' : 'now',
    },
    { label: tx('Montaje', 'Assembly'), det: enLinea ? `S${pad(s + 1)} · ${pct((s + 1) / ESTACIONES, 0)}` : car.tSalida != null ? fmt(car.tSalida) : `~${fmt(sim.t + (car.n - sim.head + 1) * TAKT)}`, estado: bloqueado ? 'bad' : est(car.tSalida != null, enLinea) },
    { label: tx('Calidad', 'Quality'), det: car.ok === true ? 'OK' : car.ok === false ? (car.tCampa != null ? tx('OK tras retrabajo', 'OK after rework') : tx('retrabajo', 'rework')) : sim.eol.includes(car) ? tx('en pruebas', 'testing') : '—', estado: car.ok === false && car.tCampa == null ? 'bad' : est(car.tCampa != null, sim.eol.includes(car)) },
    { label: tx('Expedición', 'Dispatch'), det: car.tExpedido != null ? `${car.destino} · ${fmt(car.tExpedido)}` : car.tCampa != null ? tx('en campa', 'in car park') : '—', estado: est(car.tExpedido != null, car.tCampa != null) },
  ];
  let lado;
  if (enLinea) lado = { etiqueta: bloqueado ? tx('ESPERANDO MÓDULO', 'WAITING FOR MODULE') : tx('EN LÍNEA', 'ON THE LINE'), titulo: `S${pad(s + 1)}`, sub: car.nombre, pct: (s + 1) / ESTACIONES, sel: { kind: 'coche', id: car.id } };
  else if (car.tSalida == null) lado = { etiqueta: tx('EN SECUENCIA', 'IN SEQUENCE'), titulo: `+${car.n - sim.head + 1}`, sub: car.nombre, sel: enCamino?.e.cam ? { kind: 'camion', id: enCamino.e.cam.id } : null };
  else if (car.tExpedido != null) lado = { etiqueta: tx('EXPEDIDO', 'SHIPPED'), titulo: car.destino, sub: car.nombre };
  else lado = { etiqueta: sim.campa.includes(car) ? tx('EN CAMPA', 'IN CAR PARK') : tx('FIN DE LÍNEA', 'END OF LINE'), titulo: car.ok == null ? tx('En pruebas', 'Testing') : car.ok === false ? (car.tCampa != null ? tx('OK tras retrabajo', 'OK after rework') : tx('Retrabajo', 'Rework')) : 'OK', sub: car.nombre, sel: { kind: 'coche', id: car.id } };
  return { titulo: car.id, sub: `${car.nombre} · ${tx('concesionario', 'dealer')} ${car.destino}`, pasos, lado };
}

function vistaCamion(sim, k) {
  const f = Math.max(0, Math.min(1, (sim.t - k.salida) / Math.max(1, k.llegada - k.salida)));
  const tarde = k.llegada - k.prevista;
  const destino = k.tipo === 't1' ? tx('Línea', 'Line') : k.destino.nombre;
  const que = k.tipo === 't1' ? nomMod(k.modulo) : insumo(k.insumo);
  const pasos = [
    { label: tx('Carga', 'Loaded'), det: `${k.origen.nombre} · ${fmt(k.salida)}`, estado: 'done' },
    { label: tx('En ruta', 'On the road'), det: pct(f, 0), estado: k.estado === 'ruta' ? (tarde > 10 ? 'bad' : 'now') : 'done' },
    { label: tx('Entrega', 'Delivery'), det: `${destino} · ${fmt(k.llegada)}${tarde > 1 ? ` (+${Math.round(tarde)})` : ''}`, estado: k.estado === 'ruta' ? 'next' : 'done' },
  ];
  return {
    titulo: k.id,
    sub: `${k.n} × ${que} · ${k.origen.nombre} → ${destino}`,
    pasos,
    lado: { etiqueta: tarde > 10 ? tx('CON RETRASO', 'LATE') : k.estado === 'ruta' ? tx('EN RUTA', 'ON THE ROAD') : tx('ENTREGADO', 'DELIVERED'), titulo: `ETA ${fmt(k.llegada)}`, sub: `Tier ${k.origen.tier} → ${k.tipo === 't1' ? 'OEM' : `Tier ${k.destino.tier}`}`, pct: f, sel: k.estado === 'ruta' ? { kind: 'camion', id: k.id } : null },
  };
}

// ---------------------------------------------------------------------------- avisos

function toast(e) {
  const ver = e.ref?.kind ? e.ref : null;
  const porque = tx('¿Por qué se para la línea?', 'Why does the line stop?');
  if (e.tipo === 'suministro') return e.nivel === 'ok' ? { titulo: tx('Plan B en marcha', 'Plan B under way'), ver } : { titulo: tx('Aviso de proveedor Tier 3', 'Tier 3 supplier warning'), ver, ia: tx('¿Qué proveedores están en riesgo?', 'Which suppliers are at risk?') };
  if (e.tipo === 'rotura') return e.nivel === 'ok' ? { titulo: tx('Proveedor recuperado', 'Supplier recovered'), ver } : { titulo: tx('Proveedor sin material', 'Supplier out of material'), ver, ia: tx('¿Qué proveedores están en riesgo?', 'Which suppliers are at risk?') };
  if (e.tipo === 'retraso') return { titulo: tx('Lanzadera con retraso', 'Shuttle running late'), ver, ia: porque };
  if (e.tipo === 'paro') return { titulo: tx('Línea parada', 'Line stopped'), ver, ia: porque };
  if (e.tipo === 'marcha') return { titulo: tx('La línea arranca', 'Line restarts'), vista: 'linea' };
  if (e.tipo === 'averia') return e.nivel === 'ok' ? { titulo: tx('Tier 2 recuperado', 'Tier 2 back up'), ver } : { titulo: tx('Avería en un Tier 2', 'Tier 2 breakdown'), ver, ia: tx('¿Qué hago ahora mismo?', 'What should I do right now?') };
  return null;
}

function alertas(sim) {
  const out = new Map();
  if (sim.parada) return out;
  for (const m of MODULOS) {
    const cob = sim.coberturaModulo(m.id);
    if (cob >= 16) continue;
    out.set(`cob-${m.id}`, {
      nivel: 'alerta',
      titulo: tx('Cobertura JIS baja', 'Low JIS coverage'),
      texto: tx(`Quedan ${cob} min de ${m.es.toLowerCase()} a pie de línea.`, `${cob} min of ${m.en.toLowerCase()} left at the line.`),
      ver: { kind: 'planta', id: m.t1 },
      ia: tx('¿Por qué se para la línea?', 'Why does the line stop?'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------- operativa

export function crearAutomocion() {
  const local = {
    cmp: null,
    compare() {
      if (!this.cmp) this.cmp = { hoy: runAutoDay(0).kpis(), dual: runAutoDay(0, { variant: 'dual' }).kpis() };
      return this.cmp;
    },
  };
  return {
    id: 'automocion',
    nombre: () => tx('Automoción', 'Automotive'),
    sub: () => 'Tier 1-3 → OEM',
    lugar: () => tx('Planta de montaje', 'Assembly plant'),
    content: new AutoScene(),
    kpis: KPIS,
    chart: CHART,
    tabs: [
      { id: 'linea', nombre: () => tx('Línea', 'Line') },
      { id: 'red', nombre: () => tx('Proveedores', 'Suppliers') },
      { id: 'planb', nombre: () => tx('Plan B', 'Plan B') },
    ],
    hint: () => tx('Arrastra para mover · rueda para acercar · clic en una planta, un camión o un coche', 'Drag to pan · scroll to zoom · click a plant, a truck or a car'),
    legend: (mode) => LEYENDAS[mode](),

    crearSim: (variant) => new AutoSim({ variant }),
    historia: () => historyFrom((d) => runAutoDay(d), {
      fields: ['coches', 'plan', 'paros', 'cobertura', 'otd1', 'fpy', 'riesgo', 'montados', 'paroHora'],
      final: ['plan', 'paros', 'otd1', 'fpy'],
    }),
    simA(t) { const s = new AutoSim(); s.advance(t - SHIFT_START); return s; },

    renderTab(tab, sim, ui) {
      if (tab === 'linea') return (ui.sel && renderSel(sim, ui.sel)) || renderLinea(sim);
      if (tab === 'red') return renderRed(sim);
      return renderPlanB(local, ui);
    },
    onAct(act, ui) {
      if (act === 'dual-toggle') {
        ui.setVariant(ui.variant === 'dual' ? null : 'dual');
        ui.setTab('planb');
      }
    },
    parseSel: (kind, id) => ({ kind, id }),
    badges: (sim) => ({ linea: sim.parada ? 1 : 0, red: sim.plantas.filter((p) => p.falta || p.averia).length }),

    banner(sim) {
      if (sim.parada) {
        return tx(
          `<b>Línea parada</b> desde las ${fmt(sim.parada.desde)}: falta ${sim.parada.faltan.map((id) => nomMod(id).toLowerCase()).join(', ')}. <button type="button" class="link-btn" data-open-ai>Pregunta a la IA por qué</button>`,
          `<b>Line stopped</b> since ${fmt(sim.parada.desde)}: missing ${sim.parada.faltan.map((id) => nomMod(id).toLowerCase()).join(', ')}. <button type="button" class="link-btn" data-open-ai>Ask the AI why</button>`,
        );
      }
      const cuota = sim.plantas.find((p) => p.tier === 3 && p.cuota != null);
      if (cuota) {
        return tx(
          `<b>${cuota.es} (Tier 3) con la cuota al ${textoCuota(cuota)}.</b> <button type="button" class="link-btn" data-open-ai>Pregunta a la IA cómo afecta</button>`,
          `<b>${cuota.en} (Tier 3): allocation at ${textoCuota(cuota)}.</b> <button type="button" class="link-btn" data-open-ai>Ask the AI how it affects us</button>`,
        );
      }
      return '';
    },

    toast,
    alertas,

    tracker: {
      modos: [{ id: 'coche', nombre: () => tx('Coches', 'Cars') }, { id: 'camion', nombre: () => tx('Camiones', 'Trucks') }],
      titulo: (modo) => (modo === 'coche' ? tx('Seguimiento del coche', 'Car tracking') : tx('Seguimiento del camión', 'Truck tracking')),
      items(sim, modo) {
        if (modo === 'coche') return cochesSeguibles(sim).map((c) => c.id);
        return sim.camiones.filter((k) => k.estado === 'ruta').sort((a, b) => (a.tipo === 't1') - (b.tipo === 't1') || a.llegada - b.llegada).reverse().map((k) => k.id);
      },
      vista(sim, modo, key) {
        if (modo === 'coche') { const c = sim.coches.find((x) => x.id === key); return c ? vistaCoche(sim, c) : null; }
        const k = sim.camiones.find((x) => x.id === key);
        return k ? vistaCamion(sim, k) : null;
      },
      desdeSel(sim, sel) {
        if (sel.kind === 'coche') return { modo: 'coche', key: sel.id };
        if (sel.kind === 'camion') return { modo: 'camion', key: sel.id };
        return null;
      },
    },

    asistente: {
      bienvenida: () => tx(
        'Hola. Tengo delante la **cadena de automoción** en tiempo real: los proveedores Tier 3, Tier 2 y Tier 1 y la línea de montaje, con los 14 días anteriores para comparar. Pregúntame por qué para la línea, qué proveedor está en riesgo o qué hacer ahora. También puedo contarte quién ha creado Estiba.',
        'Hi. I am looking at the **automotive supply chain** in real time: Tier 3, Tier 2 and Tier 1 suppliers and the assembly line, with the previous 14 days to compare against. Ask me why the line stops, which supplier is at risk or what to do now. I can also tell you who built Estiba.',
      ),
      teaser: () => tx('«¿Por qué se para la línea?»', '"Why does the line stop?"'),
      placeholder: () => tx('Pregunta sobre la línea o los proveedores…', 'Ask about the line or suppliers…'),
      sugerencias: sugerenciasAuto,
      ctx: (sim, history) => ({ sim, history, compare: () => local.compare() }),
      answerLocal: answerAuto,
      contexto: contextoAuto,
      contextoDeRuta: contextoDeRutaAuto,
      estado(sim, history) {
        const d = diagnoseAuto(sim, history);
        const top = d.hallazgos[0];
        return { nivel: top ? (top.peso >= 3 ? 'bad' : 'warn') : 'ok', titulo: top ? top.titulo : tx('Sin incidencias', 'No issues') };
      },
    },
  };
}
