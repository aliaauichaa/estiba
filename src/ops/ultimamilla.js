// Operativa 3: última milla. Cross-dock que recibe de los clientes (moda, deporte, comida a domicilio,
// e-commerce), clasifica por delegación de provincia y reparte con conductores hasta el cliente final.

import { MillaSim, runMillaDay } from '../sim/ultimamilla.js';
import { SHIFT_START, fmt } from '../sim/engine.js';
import { MillaScene } from '../scene/ultimamilla3d.js';
import { historyFrom } from '../analysis/history.js';
import { diagnoseMilla, answerMilla, sugerenciasMilla, contextoMilla, contextoDeRutaMilla } from '../analysis/asistenteMilla.js';
import { CLIENTES, CROSSDOCK } from '../data/ultimamilla.js';
import { tx, pct, num } from '../i18n.js';
import { esc } from '../ui/md.js';

const bar = (f, cls = '') => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, f * 100))}%"></span></div>`;
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

const KPIS = [
  { id: 'clasificados', label: () => tx('Bultos clasificados', 'Parcels sorted'), tip: () => tx('Bultos que han pasado por el sorter hoy, sobre los recibidos', 'Parcels through the sorter today, over parcels received'), f: (v, k) => `${num(v)}<small>/${num(k.recibidos)}</small>`, up: true, unit: '', baseKey: 'clasificadosAcum', minDiff: 25, desde: 6 * 60 + 15 },
  { id: 'pendientes', label: () => tx('En cola de sorter', 'Sorter queue'), tip: () => tx('Bultos descargados que esperan a la inducción', 'Unloaded parcels waiting at the induction point'), f: (v) => num(v), up: false, unit: '', minDiff: 50 },
  { id: 'corte', label: () => tx('Salen en su ola', 'On their wave'), tip: () => tx('Bultos que salen hacia la delegación en la ola que les toca según la cita de su camión', 'Parcels leaving for their depot on the wave planned from their truck booking'), f: (v) => pct(v), up: true, unit: 'pp', vacio: () => tx('aún no ha salido ninguna ola', 'no wave has left yet') },
  { id: 'dwell', label: () => tx('Tiempo en cross-dock', 'Cross-dock dwell'), tip: () => tx('Minutos de media desde que se descarga un bulto hasta que sale en su camión', 'Average minutes from a parcel being unloaded to leaving on its truck'), f: (v) => (v == null ? '—' : `${num(v)}<small>min</small>`), up: false, unit: 'min', vacio: () => tx('aún no ha salido ninguna ola', 'no wave has left yet') },
  { id: 'entregados', label: () => tx('Entregados', 'Delivered'), tip: () => tx('Bultos entregados al cliente final hoy', 'Parcels delivered to the end customer today'), f: (v) => num(v), up: true, unit: '', minDiff: 25 },
  { id: 'primerIntento', minN: (k) => k.entregados + k.fallos >= 50, label: () => tx('Entrega a la primera', 'First-time delivery'), tip: () => tx('Entregas sobre intentos: el resto, cliente ausente', 'Deliveries over attempts: the rest, customer not in'), f: (v) => pct(v), up: true, unit: 'pp', vacio: () => tx('aún no hay repartos', 'no deliveries yet') },
  { id: 'enRuta', label: () => tx('Conductores en ruta', 'Drivers on the road'), tip: () => tx('Furgonetas repartiendo ahora mismo, sobre la plantilla de hoy', 'Vans delivering right now, over today\'s drivers'), f: (v, k) => `${num(v)}<small>/${num(k.conductores)}</small>`, up: true, unit: '', minDiff: 3 },
];

const CHART = {
  legend: () => [
    { color: '#f5a524', label: tx('Bultos clasificados/hora (hoy)', 'Parcels sorted/hour (today)') },
    { color: '#5d6a7d', label: tx('Clasificados/hora (media 14 días)', 'Sorted/hour (14-day average)') },
    { color: '#2ec4b6', label: tx('Salen en su ola', 'On their wave') },
    { color: '#6c9cf0', label: tx('Conductores en ruta', 'Drivers on the road') },
  ],
  bars: 'clasificados',
  pct: 'corte',
  line: 'enRuta',
  lineMax: (sim) => sim.kpis().conductores,
  tip: (r, b) => [
    `${tx('Clasificados', 'Sorted')}: ${num(r.clasificados)} (${tx('media', 'avg')} ${b ? num(b.clasificados) : '—'})`,
    `${tx('En su ola', 'On their wave')}: ${pct(r.corte)} (${tx('media', 'avg')} ${pct(b?.corte)})`,
    `${tx('En cola', 'Queued')}: ${num(r.pendientes)}`,
    `${tx('Conductores en ruta', 'Drivers on the road')}: ${num(r.enRuta)}`,
  ],
  tipBase: (b) => `${tx('Media', 'Average')}: ${b ? num(b.clasificados) : '—'} ${tx('bultos', 'parcels')} · ${pct(b?.corte)}`,
};

const LEYENDAS = {
  operativa: () => tx(
    '<span><i style="background:#c9a36b"></i>Bulto en el sorter</span><span><i style="background:#f5a524"></i>Camión de ola</span><span><i style="background:#2ec4b6"></i>Delegación</span><span><i style="background:#46c46f"></i>Entregado</span><span><i style="background:#ff6b5e"></i>Ausente o sin repartir</span><span><i style="background:#3a4350"></i>Pendiente</span>',
    '<span><i style="background:#c9a36b"></i>Parcel on the sorter</span><span><i style="background:#f5a524"></i>Wave truck</span><span><i style="background:#2ec4b6"></i>Depot</span><span><i style="background:#46c46f"></i>Delivered</span><span><i style="background:#ff6b5e"></i>Not in or undelivered</span><span><i style="background:#3a4350"></i>Pending</span>',
  ),
  clientes: () => `${CLIENTES.map((c) => `<span><i style="background:${hex(c.color)}"></i>${esc(c.nombre)}${c.frio ? tx(' (frío)', ' (chilled)') : ''}</span>`).join('')}<span class="muted">${tx('Colores de bultos y camiones de entrada', 'Parcel and inbound truck colours')}</span>`,
};

// ---------------------------------------------------------------------------- paneles

function renderCross(sim) {
  const k = sim.kpis();
  const estado = sim.sorterParado
    ? `<div class="callout bad"><b>${tx('Sorter parado', 'Sorter down')}</b> ${tx('desde las', 'since')} ${fmt(sim.sorterParado.desde)} (${esc(tx(sim.sorterParado.es, sim.sorterParado.en))}); ${k.pendientes} ${tx('bultos en cola', 'parcels queued')}.</div>`
    : `<div class="callout"><b>${tx('Sorter en marcha', 'Sorter running')}</b> · ${num(k.clasificados)} ${tx('clasificados', 'sorted')} · ${k.pendientes} ${tx('en cola', 'queued')}.</div>`;
  const muelles = sim.muelles.map((m) => {
    const c = m.camion;
    return `<tr ${c ? `class="click" data-sel="camion:${c.id}"` : ''}><td class="mono">${m.id}</td><td>${c ? `<i class="sw" style="background:${hex(c.cliente.color)}"></i>${esc(c.nombre)}` : `<span class="muted">${tx('Libre', 'Free')}</span>`}</td>
      <td style="min-width:90px">${c ? `${bar(c.descargados / c.n)}<span class="muted mono" style="font-size:11px">${c.descargados}/${c.n}</span>` : ''}</td></tr>`;
  }).join('');
  const proximos = sim.camiones.filter((c) => c.estado === 'ruta' || c.estado === 'patio').slice(0, 6).map((c) => {
    const tarde = c.llegada - c.eta > 15;
    return `<tr class="click" data-track="camion|${c.id}"><td><i class="sw" style="background:${hex(c.cliente.color)}"></i>${esc(c.nombre)}</td><td class="num">${c.n}</td><td class="num">${c.estado === 'patio' ? tx('en patio', 'in yard') : fmt(c.llegada)}${tarde ? ' ⚠' : ''}</td></tr>`;
  }).join('');
  const proxima = sim.olas.find((o) => !o.salio);
  const rampas = sim.delegaciones.map((d) => {
    const n = sim.enRampa(d.id);
    return `<tr class="click" data-sel="hub:${d.id}"><td>${esc(d.nombre)}</td><td style="min-width:90px">${bar(n / 1800, n > 1500 ? 'warn' : '')}<span class="muted mono" style="font-size:11px">${n}</span></td></tr>`;
  }).join('');
  return `${estado}
    <div class="sec" style="margin-top:14px"><h4>${tx('Muelles de entrada', 'Inbound docks')}</h4><table class="t"><thead><tr><th>${tx('Muelle', 'Dock')}</th><th>${tx('Camión', 'Truck')}</th><th>${tx('Descarga', 'Unloading')}</th></tr></thead><tbody>${muelles}</tbody></table></div>
    ${proximos ? `<div class="sec"><h4>${tx('Próximos camiones de cliente', 'Next customer trucks')}</h4><table class="t"><thead><tr><th>${tx('Cliente', 'Customer')}</th><th class="num">${tx('Bultos', 'Parcels')}</th><th class="num">${tx('Llega', 'Arrives')}</th></tr></thead><tbody>${proximos}</tbody></table></div>` : ''}
    <div class="sec"><h4>${proxima ? tx(`Rampas · ola ${proxima.i + 1} a las ${fmt(proxima.salida)}`, `Ramps · wave ${proxima.i + 1} at ${fmt(proxima.salida)}`) : tx('Rampas · ya han salido todas las olas', 'Ramps · all waves have left')}</h4><table class="t"><tbody>${rampas}</tbody></table>
      <p class="note">${tx('Los bultos van a la rampa de su delegación y salen en la ola siguiente (09:00, 12:00 y 15:00). Lo que se clasifica después de la última ola sale mañana.', 'Parcels go to their depot ramp and leave on the next wave (09:00, 12:00 and 15:00). Anything sorted after the last wave goes tomorrow.')}</p></div>`;
}

function renderDelegaciones(sim) {
  const filas = sim.delegaciones.map((d) => {
    const e = sim.delegacion(d);
    const previsto = Math.max(1, Math.round(sim.total * d.cuota));
    const carga = sim.enCarga(d);
    const sin = Math.max(0, sim.sinRepartir(d) - carga);
    const falta = d.bajas - d.refuerzo;
    return `<tr class="click" data-sel="hub:${d.id}"><td><b>${esc(d.nombre)}</b><br><span class="muted mono" style="font-size:11px">${d.km} km · ${d.transito} min</span></td>
      <td class="num">${e.enRuta}/${e.conductores}${falta > 0 ? ' <span class="pill bad">−' + falta + '</span>' : ''}</td>
      <td style="min-width:90px">${bar(e.entregados / previsto, falta > 0 ? 'warn' : '')}<span class="muted mono" style="font-size:11px">${num(e.entregados)}${sin ? ` · ${num(sin)} ${tx('esperan', 'waiting')}` : ''}${carga ? ` · ${num(carga)} ${tx('cargándose', 'loading')}` : ''}</span></td></tr>`;
  }).join('');
  return `<div class="sec"><h4>${tx('Delegaciones', 'Depots')}</h4><table class="t"><thead><tr><th>${tx('Delegación', 'Depot')}</th><th class="num">${tx('En ruta', 'On road')}</th><th>${tx('Entregados', 'Delivered')}</th></tr></thead><tbody>${filas}</tbody></table>
    <p class="note">${tx('Cada delegación reparte con su plantilla, repartida entre las tres olas. Lo que no cabe en las furgonetas o no da tiempo a repartir antes de las 21:30 se queda para mañana.', 'Each depot delivers with its own drivers, split across the three waves. Whatever does not fit in the vans or cannot be delivered before 21:30 waits until tomorrow.')}</p></div>`;
}

function renderPlanB(local, ui) {
  const c = local.compare();
  const on = ui.variant === 'refuerzo';
  const fila = (label, a, b, f) => `<tr><td>${label}</td><td class="num">${f(a)}</td><td class="num">${f(b)}</td></tr>`;
  return `<div class="callout amber">${tx(
    '<b>Plan B: inducción manual y conductores de refuerzo.</b> Hoy el sorter se atasca una hora antes de la primera ola y Toledo tiene tres conductores de baja. ¿Qué se gana abriendo una inducción manual durante el atasco (45 % del ritmo) y trayendo tres conductores de refuerzo?',
    '<b>Plan B: manual induction and standby drivers.</b> Today the sorter jams for an hour before the first wave and Toledo has three drivers off sick. What do we gain by opening a manual induction during the jam (45% of the rate) and bringing in three standby drivers?',
  )}</div>
    <div class="btn-row"><button class="btn" data-act="refuerzo-toggle">${on ? tx('Volver al día sin plan B', 'Back to the day without plan B') : tx('Simular hoy con el plan B', 'Simulate today with plan B')}</button></div>
    ${on ? `<p class="note">${tx('Estás viendo el día re-simulado con el plan B desde las 06:00.', 'You are watching the day re-simulated with plan B from 06:00.')}</p>` : ''}
    <div class="sec" style="margin-top:14px"><h4>${tx('Día completo simulado', 'Full simulated day')}</h4><table class="t"><thead><tr><th></th><th class="num">${tx('Sin plan B', 'Without')}</th><th class="num">${tx('Con plan B', 'With plan B')}</th></tr></thead><tbody>
      ${fila(tx('Entregados', 'Delivered'), c.hoy.entregados, c.refuerzo.entregados, num)}
      ${fila(tx('Sin repartir al cierre', 'Undelivered at close'), c.hoy.sinRepartir, c.refuerzo.sinRepartir, num)}
      ${fila(tx('Salen en su ola', 'On their wave'), c.hoy.corte, c.refuerzo.corte, (v) => pct(v))}
      ${fila(tx('Tiempo en cross-dock', 'Cross-dock dwell'), c.hoy.dwell, c.refuerzo.dwell, (v) => `${num(v)} min`)}</tbody></table>
      <p class="note">${tx('Mismo día, mismos camiones, retrasos y ausencias; solo cambian la inducción durante el atasco y los conductores de la delegación con bajas.', 'Same day, same trucks, delays and failed attempts; only the induction during the jam and the drivers at the depot with absences change.')}</p></div>`;
}

function renderSel(sim, sel) {
  const back = `<button class="back" data-sel="none">← ${tx('Volver al resumen', 'Back to overview')}</button>`;
  if (sel.kind === 'hub') {
    const d = sim.deleg.get(sel.id);
    if (!d) return null;
    const e = sim.delegacion(d);
    const rutas = sim.rutas.filter((r) => r.hub === d).map((r) => {
      const s = sim.estadoRuta(r);
      return `<tr class="click" data-sel="ruta:${r.id}"><td class="mono">${r.id}</td><td class="num">${tx('ola', 'wave')} ${r.ola + 1}</td><td style="min-width:80px">${bar(s.hechas / r.n)}<span class="muted mono" style="font-size:11px">${s.hechas}/${r.n}</span></td></tr>`;
    }).join('');
    return `${back}<div class="title-row"><span class="big">${esc(d.nombre)}</span><span class="pill ${d.bajas > d.refuerzo ? 'bad' : 'ok'}">${e.enRuta}/${e.conductores} ${tx('en ruta', 'on road')}</span></div>
      <div class="sec"><dl class="kv"><dt>${tx('Distancia', 'Distance')}</dt><dd>${d.km} km · ${d.transito} min</dd><dt>${tx('Conductores', 'Drivers')}</dt><dd>${e.conductores}/${d.conductores}${d.bajas ? ` (${d.bajas} ${tx('de baja', 'off sick')}${d.refuerzo ? `, ${d.refuerzo} ${tx('de refuerzo', 'standby')}` : ''})` : ''}</dd>
        <dt>${tx('Recibidos', 'Received')}</dt><dd>${num(d.recibidos)}</dd><dt>${tx('Entregados', 'Delivered')}</dt><dd>${num(e.entregados)}</dd><dt>${tx('Ausentes', 'Not in')}</dt><dd>${num(e.fallos)}</dd>
        <dt>${tx('Esperan en delegación', 'Waiting at depot')}</dt><dd>${num(Math.max(0, sim.sinRepartir(d) - sim.enCarga(d)))}</dd><dt>${tx('Cargándose en furgonetas', 'Being loaded')}</dt><dd>${num(sim.enCarga(d))}</dd><dt>${tx('De camino', 'On the way')}</dt><dd>${num(e.camino)}</dd><dt>${tx('En su rampa', 'At its ramp')}</dt><dd>${num(e.rampa)}</dd></dl></div>
      ${rutas ? `<div class="sec"><h4>${tx('Rutas de hoy', "Today's routes")}</h4><table class="t"><tbody>${rutas}</tbody></table></div>` : ''}`;
  }
  if (sel.kind === 'camion') {
    const c = sim.camiones.find((x) => x.id === sel.id);
    if (!c) return null;
    const est = { ruta: [tx('En camino', 'On its way'), 'info'], patio: [tx('En patio', 'In yard'), 'warn'], muelle: [tx('Descargando', 'Unloading'), 'info'], fuera: [tx('Descargado', 'Unloaded'), 'ok'] }[c.estado];
    return `${back}<div class="title-row"><span class="big">${esc(c.nombre)}</span><span class="pill ${est[1]}">${est[0]}</span></div>
      <div class="sec"><dl class="kv"><dt>${tx('Cliente', 'Customer')}</dt><dd>${esc(c.cliente.nombre)}${c.cliente.frio ? tx(' · frío', ' · chilled') : ''}</dd><dt>${tx('Bultos', 'Parcels')}</dt><dd>${c.n}</dd><dt>${tx('Cita', 'Booking')}</dt><dd>${fmt(c.eta)}</dd>
        <dt>${tx('Llegada', 'Arrival')}</dt><dd>${fmt(c.llegada)}${c.llegada - c.eta > 10 ? ` (+${Math.round(c.llegada - c.eta)} min)` : ''}</dd><dt>${tx('Muelle', 'Dock')}</dt><dd>${c.muelle ? c.muelle.id : '—'}</dd><dt>${tx('Descargados', 'Unloaded')}</dt><dd>${c.descargados}/${c.n}</dd></dl></div>
      ${c.incidencia ? `<p class="note">${esc(tx(c.incidencia.es, c.incidencia.en))}.</p>` : ''}`;
  }
  if (sel.kind === 'linea') {
    const l = sim.lineas.find((x) => x.id === sel.id);
    if (!l) return null;
    const f = Math.max(0, Math.min(1, (sim.t - l.salida) / Math.max(1, l.llegada - l.salida)));
    return `${back}<div class="title-row"><span class="big">${esc(l.hub.nombre)}</span><span class="pill ${l.estado === 'ruta' ? 'info' : 'ok'}">${tx('Ola', 'Wave')} ${l.ola + 1}</span></div>
      <div class="sec"><dl class="kv"><dt>${tx('Bultos', 'Parcels')}</dt><dd>${l.n}</dd><dt>${tx('De una ola anterior', 'Carried over')}</dt><dd>${l.tarde}</dd><dt>${tx('Salida', 'Departed')}</dt><dd>${fmt(l.salida)}</dd><dt>${tx('Llegada', 'Arrival')}</dt><dd>${fmt(l.llegada)}</dd></dl>${l.estado === 'ruta' ? bar(f) : ''}</div>`;
  }
  if (sel.kind === 'ruta') {
    const r = sim.rutas.find((x) => x.id === sel.id);
    if (!r) return null;
    const s = sim.estadoRuta(r);
    const frio = r.lotes.filter((l) => l.cliente.frio).reduce((a, l) => a + l.n, 0);
    return `${back}<div class="title-row"><span class="big">${r.id}</span><span class="pill ${s.enRuta ? 'info' : 'ok'}">${s.enRuta ? tx('Repartiendo', 'Delivering') : tx('Terminada', 'Finished')}</span></div>
      <div class="sec"><dl class="kv"><dt>${tx('Delegación', 'Depot')}</dt><dd>${esc(r.hub.nombre)}</dd><dt>${tx('Ola', 'Wave')}</dt><dd>${r.ola + 1}</dd><dt>${tx('Salida', 'Departed')}</dt><dd>${fmt(r.salida)}</dd><dt>${tx('Fin previsto', 'Planned end')}</dt><dd>${fmt(r.fin)}</dd>
        <dt>${tx('Bultos', 'Parcels')}</dt><dd>${r.n}${frio ? ` (${frio} ${tx('de frío, primero', 'chilled, first')})` : ''}</dd><dt>${tx('Entregados', 'Delivered')}</dt><dd>${s.entregados}</dd><dt>${tx('Ausentes', 'Not in')}</dt><dd>${s.fallos}</dd></dl>${bar(s.hechas / r.n)}</div>`;
  }
  return null;
}

// ---------------------------------------------------------------------------- seguimiento

function estadoBulto(sim, s) {
  const t = sim.t;
  if (s.ruta && t >= s.tEntrega) return s.ausente ? 'ausente' : 'entregado';
  if (s.ruta && t >= s.ruta.salida) return 'reparto';
  if (s.linea && s.linea.estado !== 'ruta') return 'delegacion';
  if (s.linea) return 'camion';
  if (s.tSort != null) return 'rampa';
  if (s.tDescarga != null) return 'cola';
  return 'origen';
}

function bultosSeguibles(sim) {
  const orden = { reparto: 0, camion: 1, delegacion: 2, rampa: 3, cola: 4, origen: 5, entregado: 6, ausente: 6 };
  return sim.seguidos.slice().sort((a, b) => orden[estadoBulto(sim, a)] - orden[estadoBulto(sim, b)] || a.g - b.g);
}

function vistaBulto(sim, s) {
  const e = estadoBulto(sim, s);
  const hub = sim.deleg.get(s.hub);
  const t = sim.t;
  const st = (hecho, ahora) => (hecho ? 'done' : ahora ? 'now' : 'next');
  // Ya no sale hoy: se quedó en el cross-dock tras la última ola, o en la delegación sin más furgonetas.
  const sinOla = !s.linea && sim.olas.every((o) => o.salio);
  const sinFurgo = !s.ruta && s.linea?.estado === 'repartida'
    && (t >= sim.fin || (sim.olas.every((o) => o.salio) && !sim.lineas.some((l) => l.hub.id === s.hub && l.estado !== 'repartida')));
  const sinRepartir = sinOla || sinFurgo || (!s.ruta && t >= sim.fin);
  const enCross = s.tDescarga == null && s.camion.estado !== 'ruta';
  const pasos = [
    { label: tx('Recibido', 'Received'), det: s.tDescarga != null ? `${s.cliente.nombre} · ${fmt(s.tDescarga)}` : enCross ? `${s.cliente.nombre} · ${tx('llegó', 'arrived')} ${fmt(s.camion.tPatio)}` : `${s.cliente.nombre} · ${tx('llega', 'arrives')} ${fmt(s.camion.llegada)}`, estado: st(s.tDescarga != null, enCross) },
    { label: tx('Clasificado', 'Sorted'), det: s.tSort != null ? `${tx('rampa', 'ramp')} ${hub.nombre} · ${fmt(s.tSort)}` : e === 'cola' ? tx('en cola del sorter', 'in sorter queue') : '—', estado: st(s.tSort != null, e === 'cola') },
    { label: tx('Camión de ola', 'Wave truck'), det: s.linea ? `${tx('ola', 'wave')} ${s.linea.ola + 1} · ${fmt(s.linea.salida)}` : sinOla ? tx('sale mañana', 'goes tomorrow') : s.tSort != null ? `${tx('espera la ola', 'waiting for wave')} ${(sim.olas.find((o) => !o.salio)?.i ?? 2) + 1}` : '—', estado: sinOla ? 'bad' : st(s.linea && s.linea.estado !== 'ruta', e === 'camion' || e === 'rampa') },
    { label: tx('Delegación', 'Depot'), det: s.linea?.tDeleg != null ? `${hub.nombre} · ${fmt(s.linea.tDeleg)}` : s.linea ? `ETA ${fmt(s.linea.llegada)}` : hub.nombre, estado: st(!!s.ruta || e === 'entregado' || e === 'ausente', e === 'delegacion') },
    { label: tx('En reparto', 'Out for delivery'), det: s.ruta ? `${s.ruta.id} · ${tx('parada', 'stop')} ${s.parada + 1}/${s.ruta.n}` : '—', estado: sinRepartir ? 'bad' : st(e === 'entregado' || e === 'ausente', e === 'reparto') },
    {
      label: e === 'ausente' ? tx('Ausente', 'Not in') : tx('Entregado', 'Delivered'),
      det: e === 'entregado' ? fmt(s.tEntrega) : e === 'ausente' ? tx('2.º intento mañana', '2nd attempt tomorrow') : s.ruta ? `~${fmt(s.tEntrega)}` : sinRepartir ? tx('sale mañana', 'goes tomorrow') : '—',
      estado: e === 'entregado' ? 'done' : e === 'ausente' || sinRepartir ? 'bad' : 'next',
    },
  ];
  let lado;
  if (e === 'reparto') lado = { etiqueta: tx('EN REPARTO', 'OUT FOR DELIVERY'), titulo: s.ruta.id, sub: `${tx('entrega hacia las', 'delivery around')} ${fmt(s.tEntrega)}`, pct: Math.min(1, sim.hechas(s.ruta) / Math.max(1, s.parada + 1)), sel: { kind: 'ruta', id: s.ruta.id } };
  else if (e === 'camion') lado = { etiqueta: tx('EN CAMIÓN', 'ON THE TRUCK'), titulo: hub.nombre, sub: `ETA ${fmt(s.linea.llegada)}`, pct: Math.min(1, (t - s.linea.salida) / Math.max(1, s.linea.llegada - s.linea.salida)), sel: { kind: 'linea', id: s.linea.id } };
  else if (e === 'delegacion') lado = { etiqueta: tx('EN DELEGACIÓN', 'AT DEPOT'), titulo: hub.nombre, sub: sinRepartir ? tx('sale mañana', 'goes tomorrow') : tx('esperando furgoneta', 'waiting for a van'), sel: { kind: 'hub', id: hub.id } };
  else if (e === 'rampa' || e === 'cola') lado = { etiqueta: 'CROSS-DOCK', titulo: e === 'cola' ? tx('En cola', 'Queued') : tx('En rampa', 'At ramp'), sub: sinOla ? `${hub.nombre} · ${tx('sale mañana', 'goes tomorrow')}` : hub.nombre };
  else if (enCross) lado = { etiqueta: 'CROSS-DOCK', titulo: s.camion.estado === 'muelle' ? tx('Descargando', 'Unloading') : tx('En patio', 'In yard'), sub: s.cliente.nombre, sel: { kind: 'camion', id: s.camion.id } };
  else if (e === 'origen') lado = { etiqueta: tx('EN ORIGEN', 'AT ORIGIN'), titulo: s.cliente.nombre, sub: `${tx('camión', 'truck')} ${fmt(s.camion.llegada)}`, sel: null };
  else lado = { etiqueta: e === 'entregado' ? tx('ENTREGADO', 'DELIVERED') : tx('AUSENTE', 'NOT IN'), titulo: fmt(s.tEntrega), sub: hub.nombre, sel: { kind: 'hub', id: hub.id } };
  return { titulo: s.id, sub: `${s.cliente.nombre}${s.cliente.frio ? tx(' · frío', ' · chilled') : ''} · ${tx('delegación', 'depot')} ${hub.nombre}`, pasos, lado };
}

function vistaCamion(sim, key) {
  const c = sim.camiones.find((x) => x.id === key);
  if (c) {
    const st = (h, n) => (h ? 'done' : n ? 'now' : 'next');
    const tarde = c.llegada - c.eta;
    return {
      titulo: c.nombre,
      sub: `${c.n} ${tx('bultos', 'parcels')} · ${tx('cita', 'booking')} ${fmt(c.eta)}`,
      pasos: [
        { label: tx('En camino', 'On its way'), det: `ETA ${fmt(c.llegada)}${tarde > 10 ? ` (+${Math.round(tarde)})` : ''}`, estado: c.estado === 'ruta' ? (tarde > 15 ? 'bad' : 'now') : 'done' },
        { label: tx('Patio', 'Yard'), det: c.tPatio != null ? fmt(c.tPatio) : '—', estado: st(c.tMuelle != null, c.estado === 'patio') },
        { label: tx('Muelle', 'Dock'), det: c.muelle ? `${c.muelle.id} · ${fmt(c.tMuelle)}` : '—', estado: st(c.tMuelle != null, false) },
        { label: tx('Descarga', 'Unloading'), det: `${c.descargados}/${c.n}`, estado: st(c.estado === 'fuera', c.estado === 'muelle') },
      ],
      lado: { etiqueta: c.cliente.nombre.toUpperCase(), titulo: c.estado === 'muelle' ? c.muelle.id : fmt(c.llegada), sub: c.cliente.frio ? tx('frío', 'chilled') : `${c.n} ${tx('bultos', 'parcels')}`, pct: c.estado === 'muelle' ? c.descargados / c.n : null, sel: c.estado !== 'ruta' ? { kind: 'camion', id: c.id } : null },
    };
  }
  const l = sim.lineas.find((x) => x.id === key);
  if (!l) return null;
  const f = Math.max(0, Math.min(1, (sim.t - l.salida) / Math.max(1, l.llegada - l.salida)));
  const rutas = sim.rutas.filter((r) => r.hub === l.hub && r.ola === l.ola);
  return {
    titulo: `${tx('Ola', 'Wave')} ${l.ola + 1} · ${l.hub.nombre}`,
    sub: `${l.n} ${tx('bultos', 'parcels')}${l.tarde ? ` · ${l.tarde} ${tx('de una ola anterior', 'carried over')}` : ''}`,
    pasos: [
      { label: tx('Carga', 'Loaded'), det: `Cross-dock · ${fmt(l.salida)}`, estado: 'done' },
      { label: tx('En ruta', 'On the road'), det: pct(f, 0), estado: l.estado === 'ruta' ? 'now' : 'done' },
      { label: tx('Delegación', 'Depot'), det: `${l.hub.nombre} · ${fmt(l.tDeleg ?? l.llegada)}`, estado: l.estado === 'ruta' ? 'next' : 'done' },
      { label: tx('Furgonetas', 'Vans'), det: rutas.length ? `${rutas.length} ${tx('rutas', 'routes')}` : '—', estado: rutas.length ? 'done' : l.estado === 'delegacion' ? 'now' : 'next' },
    ],
    lado: { etiqueta: l.estado === 'ruta' ? tx('EN RUTA', 'ON THE ROAD') : tx('ENTREGADO', 'DELIVERED'), titulo: `ETA ${fmt(l.llegada)}`, sub: l.hub.nombre, pct: l.estado === 'ruta' ? f : null, sel: l.estado === 'ruta' ? { kind: 'linea', id: l.id } : { kind: 'hub', id: l.hub.id } },
  };
}

// ---------------------------------------------------------------------------- avisos

function toast(e) {
  const ver = e.ref?.kind ? e.ref : null;
  const vista = e.ref?.view === 'sorter' ? 'crossdock' : e.ref?.view === 'red' ? 'general' : null;
  if (e.tipo === 'bajas') return { titulo: tx('Conductores de baja', 'Drivers off sick'), ver, ia: tx('¿Qué delegaciones van justas?', 'Which depots are struggling?') };
  if (e.tipo === 'sorter') return e.nivel === 'ok' ? { titulo: tx('Sorter en marcha', 'Sorter running'), vista } : { titulo: tx('Sorter parado', 'Sorter down'), vista, ia: tx('¿Por qué hay bultos que pierden su ola?', 'Why are parcels missing their wave?') };
  if (e.tipo === 'llegada') return e.nivel === 'alerta' ? { titulo: tx('Camión de cliente con retraso', 'Customer truck running late'), ver, ia: tx('¿Por qué hay bultos que pierden su ola?', 'Why are parcels missing their wave?') } : { titulo: tx('Camión de cliente en patio', 'Customer truck in the yard'), ver };
  if (e.tipo === 'ola') return e.nivel === 'alerta' ? { titulo: tx('Arrastre a la siguiente ola', 'Carry-over to the next wave'), ver, ia: tx('¿Por qué hay bultos que pierden su ola?', 'Why are parcels missing their wave?'), clave: 'arrastre' } : { titulo: tx('Sale una ola', 'A wave leaves'), vista };
  if (e.tipo === 'cierre') return { titulo: tx('Bultos sin repartir', 'Parcels left undelivered'), ver, ia: tx('¿Qué delegaciones van justas?', 'Which depots are struggling?') };
  return null;
}

function alertas(sim) {
  const out = new Map();
  const pend = sim.pendientes();
  if (pend > 700) {
    out.set('cola', {
      nivel: 'alerta',
      titulo: tx('Cola de sorter alta', 'Long sorter queue'),
      texto: tx(`${pend} bultos esperan a la inducción.`, `${pend} parcels are waiting at the induction point.`),
      vista: 'crossdock',
      ia: tx('¿Por qué hay bultos que pierden su ola?', 'Why are parcels missing their wave?'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------- operativa

export function crearUltimaMilla() {
  const local = {
    cmp: null,
    compare() {
      if (!this.cmp) this.cmp = { hoy: runMillaDay(0).kpis(), refuerzo: runMillaDay(0, { variant: 'refuerzo' }).kpis() };
      return this.cmp;
    },
  };
  return {
    id: 'milla',
    nombre: () => tx('Última milla', 'Last mile'),
    sub: () => 'Cross-dock',
    lugar: () => tx(CROSSDOCK.es, CROSSDOCK.en),
    content: new MillaScene(),
    kpis: KPIS,
    chart: CHART,
    tabs: [
      { id: 'cross', nombre: () => 'Cross-dock' },
      { id: 'deleg', nombre: () => tx('Delegaciones', 'Depots') },
      { id: 'planb', nombre: () => tx('Plan B', 'Plan B') },
    ],
    hint: () => tx('Arrastra para mover · rueda para acercar · clic en un camión, una delegación o una furgoneta', 'Drag to pan · scroll to zoom · click a truck, a depot or a van'),
    legend: (mode) => LEYENDAS[mode](),

    crearSim: (variant) => new MillaSim({ variant }),
    historia: () => historyFrom((d) => runMillaDay(d), {
      fields: ['clasificados', 'clasificadosAcum', 'corte', 'enRuta', 'pendientes', 'dwell', 'entregados', 'primerIntento', 'productividad', 'recibidos'],
      final: ['corte', 'dwell', 'primerIntento'],
    }),
    simA(t) { const s = new MillaSim(); s.advance(t - SHIFT_START); return s; },

    renderTab(tab, sim, ui) {
      if (tab === 'cross') return (ui.sel && renderSel(sim, ui.sel)) || renderCross(sim);
      if (tab === 'deleg') return renderDelegaciones(sim);
      return renderPlanB(local, ui);
    },
    onAct(act, ui) {
      if (act === 'refuerzo-toggle') {
        ui.setVariant(ui.variant === 'refuerzo' ? null : 'refuerzo');
        ui.setTab('planb');
      }
    },
    parseSel: (kind, id) => ({ kind, id }),
    badges: (sim) => ({ cross: sim.sorterParado ? 1 : 0, deleg: sim.delegaciones.filter((d) => d.bajas > d.refuerzo).length }),

    banner(sim) {
      if (sim.sorterParado) {
        return tx(
          `<b>Sorter parado</b> desde las ${fmt(sim.sorterParado.desde)}: ${sim.pendientes()} bultos en cola. <button type="button" class="link-btn" data-open-ai>Pregunta a la IA cómo afecta</button>`,
          `<b>Sorter down</b> since ${fmt(sim.sorterParado.desde)}: ${sim.pendientes()} parcels queued. <button type="button" class="link-btn" data-open-ai>Ask the AI how it affects us</button>`,
        );
      }
      const bajas = sim.delegaciones.find((d) => d.bajas > d.refuerzo);
      if (bajas && sim.t < sim.fin) {
        return tx(
          `<b>${bajas.es}: ${bajas.bajas} conductores de baja.</b> <button type="button" class="link-btn" data-open-ai>Pregunta a la IA si llega a repartir</button>`,
          `<b>${bajas.en}: ${bajas.bajas} drivers off sick.</b> <button type="button" class="link-btn" data-open-ai>Ask the AI if it will deliver everything</button>`,
        );
      }
      return '';
    },

    toast,
    alertas,

    tracker: {
      modos: [{ id: 'bulto', nombre: () => tx('Paquetes', 'Parcels') }, { id: 'camion', nombre: () => tx('Camiones', 'Trucks') }],
      titulo: (modo) => (modo === 'bulto' ? tx('Seguimiento del paquete', 'Parcel tracking') : tx('Seguimiento del camión', 'Truck tracking')),
      items(sim, modo) {
        if (modo === 'bulto') return bultosSeguibles(sim).map((s) => s.id);
        const entrada = sim.camiones.filter((c) => c.estado !== 'fuera' || sim.t - c.tFin < 30).map((c) => c.id);
        const lineas = sim.lineas.filter((l) => l.estado === 'ruta').map((l) => l.id);
        return [...lineas, ...entrada];
      },
      vista(sim, modo, key) {
        if (modo === 'bulto') { const s = sim.seguidos.find((x) => x.id === key); return s ? vistaBulto(sim, s) : null; }
        return vistaCamion(sim, key);
      },
      desdeSel(sim, sel) {
        if (sel.kind === 'camion' || sel.kind === 'linea') return { modo: 'camion', key: sel.id };
        if (sel.kind === 'ruta') {
          const s = sim.seguidos.find((x) => x.ruta?.id === sel.id);
          if (s) return { modo: 'bulto', key: s.id };
        }
        return null;
      },
    },

    asistente: {
      bienvenida: () => tx(
        'Hola. Tengo delante la **red de última milla** en tiempo real: el cross-dock, el sorter, las olas hacia las ocho delegaciones y los conductores repartiendo, con los 14 días anteriores para comparar. Pregúntame por el arrastre, por una delegación o qué hacer ahora. También puedo contarte quién ha creado Estiba.',
        'Hi. I am looking at the **last-mile network** in real time: the cross-dock, the sorter, the waves to the eight depots and the drivers delivering, with the previous 14 days to compare against. Ask me about carry-over, a depot or what to do now. I can also tell you who built Estiba.',
      ),
      teaser: () => tx('«¿Por qué hay bultos que pierden su ola?»', '"Why are parcels missing their wave?"'),
      placeholder: () => tx('Pregunta sobre el cross-dock o el reparto…', 'Ask about the cross-dock or deliveries…'),
      sugerencias: sugerenciasMilla,
      ctx: (sim, history) => ({ sim, history, compare: () => local.compare() }),
      answerLocal: answerMilla,
      contexto: contextoMilla,
      contextoDeRuta: contextoDeRutaMilla,
      estado(sim, history) {
        const d = diagnoseMilla(sim, history);
        const top = d.hallazgos[0];
        return { nivel: top ? (top.peso >= 3 ? 'bad' : 'warn') : 'ok', titulo: top ? top.titulo : tx('Sin incidencias', 'No issues') };
      },
    },
  };
}
