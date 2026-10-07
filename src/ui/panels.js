// Contenido del panel lateral (HTML). Todo texto variable pasa por esc(); los fijos van en los dos
// idiomas con tx('es', 'en').

import { fmt } from '../sim/engine.js';
import { routeStatus } from '../analysis/assistant.js';
import { tx, num, pct, placeName } from '../i18n.js';
import { esc } from './md.js';

const n1 = (v) => num(v, 1);

function forkState(f) {
  if (f.enTaller) return [tx('En taller', 'In workshop'), 'bad'];
  const t = f.task?.tipo;
  if (t === 'taller') return [tx('Yendo al taller', 'To workshop'), 'bad'];
  if (t === 'picking') return [tx('Preparando', 'Picking'), 'ok'];
  if (t === 'ubicacion') return [tx('Ubicando', 'Putting away'), 'info'];
  return [tx('Libre', 'Idle'), ''];
}

export function renderOverview(sim) {
  const rows = sim.forklifts.map((f) => {
    const [txt, cls] = forkState(f);
    const u = f.disponible > 0 ? f.ocupado / f.disponible : null;
    return `<tr class="click" data-sel="forklift:${f.id}"><td class="mono">${f.id}</td><td><span class="pill ${cls}">${txt}</span></td>
      <td class="num">${f.lineas}</td><td class="num">${f.pales}</td><td class="num">${pct(u, 0)}</td></tr>`;
  }).join('');
  const docks = sim.L.inDocks.map((d) => {
    const tr = d.truck;
    const lane = sim.lanes[d.id].length;
    const capPct = lane / sim.site.capCalle;
    const cls = capPct >= 1 ? 'bad' : capPct > 0.7 ? 'warn' : '';
    return `<tr ${tr ? `class="click" data-sel="truck:in-${tr.id}"` : ''}><td class="mono">${d.id}</td>
      <td>${tr ? `${esc(tr.matricula)}<br><span class="muted">${esc(tr.proveedor)}</span>` : `<span class="muted">${tx('Libre', 'Free')}</span>`}</td>
      <td class="num">${tr ? `${tr.descargados}/${tr.pales.length}` : '—'}</td>
      <td><div class="bar ${cls}"><span style="width:${Math.min(100, capPct * 100)}%"></span></div><span class="muted mono" style="font-size:11px">${lane}/${sim.site.capCalle}</span></td></tr>`;
  }).join('');
  const yard = sim.yard.length;
  const yardTxt = yard
    ? tx(`${yard} ${yard > 1 ? 'camiones' : 'camión'} esperando en el patio.`, `${yard} ${yard > 1 ? 'trucks' : 'truck'} waiting in the yard.`)
    : tx('Nadie esperando en el patio.', 'Nobody waiting in the yard.');
  return `
    <div class="sec"><h4>${tx('Carretillas', 'Forklifts')}</h4>
      <table class="t"><thead><tr><th>${tx('Equipo', 'Truck')}</th><th>${tx('Estado', 'Status')}</th><th class="num">${tx('Líneas', 'Lines')}</th><th class="num">${tx('Palés', 'Pallets')}</th><th class="num">${tx('Uso', 'Use')}</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="sec"><h4>${tx('Muelles de recepción', 'Receiving docks')}</h4>
      <table class="t"><thead><tr><th>${tx('Muelle', 'Dock')}</th><th>${tx('Camión', 'Truck')}</th><th class="num">${tx('Desc.', 'Unl.')}</th><th>${tx('Calle', 'Lane')}</th></tr></thead><tbody>${docks}</tbody></table>
      <p class="note">${yardTxt} ${tx('La calle es el espacio delante del muelle: si se llena, la descarga se para.', 'The lane is the space in front of the dock: if it fills up, unloading stops.')}</p>
    </div>
    <p class="note">${tx('Haz clic en una carretilla, un camión o un hueco de la nave para ver su detalle.', 'Click a forklift, a truck or a rack location to see its details.')}</p>`;
}

export function renderSelection(sim, sel) {
  const back = `<button class="back" data-sel="none">← ${tx('Volver al resumen', 'Back to overview')}</button>`;
  if (sel.kind === 'forklift') {
    const f = sim.forklifts.find((x) => x.id === sel.id);
    if (!f) return null;
    const [txt, cls] = forkState(f);
    const u = f.disponible > 0 ? f.ocupado / f.disponible : null;
    let task = `<p class="muted">${tx('Sin tarea asignada.', 'No task assigned.')}</p>`;
    if (f.task?.tipo === 'picking') {
      const o = f.task.pedido;
      task = `<dl class="kv"><dt>${tx('Pedido', 'Order')}</dt><dd>${esc(o.id)}</dd><dt>${tx('Cliente', 'Customer')}</dt><dd>${esc(o.cliente)}</dd>
        <dt>${tx('Ruta', 'Route')}</dt><dd>${esc(placeName(o.route.destino))} · ${fmt(o.route.salida)}</dd>
        <dt>${tx('Líneas', 'Lines')}</dt><dd>${o.lines.length}${o.cortas ? ` (${o.cortas} ${tx('incompletas', 'short')})` : ''}</dd>
        <dt>${tx('Paradas', 'Stops')}</dt><dd>${f.task.paradas.map(esc).join(' → ') || '—'}</dd><dt>${tx('Termina', 'Ends')}</dt><dd>${fmt(f.endT)}</dd></dl>`;
    } else if (f.task?.tipo === 'ubicacion') {
      const p = f.task.pal;
      const sku = sim.skus[p.sku];
      task = `<dl class="kv"><dt>${tx('Palé', 'Pallet')}</dt><dd>${esc(sku.code)}</dd><dt>${tx('Producto', 'Product')}</dt><dd>${esc(sku.nombre)}</dd>
        <dt>${tx('Desde', 'From')}</dt><dd>${p.dock.id} (${esc(p.camion)})</dd><dt>${tx('Hasta', 'To')}</dt><dd>${esc(f.task.dest.id)}</dd>
        <dt>${tx('En calle desde', 'In lane since')}</dt><dd>${fmt(p.tDescarga)}</dd><dt>${tx('Termina', 'Ends')}</dt><dd>${fmt(f.endT)}</dd></dl>`;
    } else if (f.enTaller || f.task?.tipo === 'taller') {
      task = `<p>${esc(f.taller?.motivo || tx('Fuera de servicio', 'Out of service'))}. ${tx('Vuelve hacia las', 'Back around')} ${fmt(f.taller?.hasta ?? sim.t)}.</p>`;
    }
    return `${back}<div class="title-row"><span class="big">${f.id}</span><span class="pill ${cls}">${txt}</span></div>
      <div class="sec"><h4>${tx('Tarea actual', 'Current task')}</h4>${task}</div>
      <div class="sec"><h4>${tx('Hoy', 'Today')}</h4><dl class="kv"><dt>${tx('Pedidos', 'Orders')}</dt><dd>${f.pedidos}</dd><dt>${tx('Líneas', 'Lines')}</dt><dd>${f.lineas}</dd>
        <dt>${tx('Palés ubicados', 'Pallets put away')}</dt><dd>${f.pales}</dd><dt>${tx('Recorrido', 'Distance')}</dt><dd>${n1(f.metros / 1000)} km</dd>
        <dt>${tx('Utilización', 'Utilisation')}</dt><dd>${pct(u)}</dd></dl></div>
      <p class="note">${tx('La línea discontinua en la nave es la ruta que está siguiendo; los discos, sus paradas.', 'The dashed line in the warehouse is the route it is following; the discs are its stops.')}</p>`;
  }
  if (sel.kind === 'truck' && sel.id.startsWith('in-')) {
    const tr = sim.trucks.find((x) => `in-${x.id}` === sel.id);
    if (!tr) return null;
    const estado = {
      patio: [tx('En patio', 'In yard'), 'warn'],
      muelle: [tx('En muelle', 'At dock'), 'info'],
      fuera: [tx('Descargado', 'Unloaded'), 'ok'],
    }[tr.estado] || [tr.estado, ''];
    const espera = tr.espera != null ? tr.espera : sim.t - tr.tPatio;
    return `${back}<div class="title-row"><span class="big">${esc(tr.matricula)}</span><span class="pill ${estado[1]}">${estado[0]}</span></div>
      <div class="sec"><h4>${tx('Entrada', 'Inbound')}</h4><dl class="kv"><dt>${tx('Transportista', 'Carrier')}</dt><dd>${esc(tr.transportista)}</dd><dt>${tx('Proveedor', 'Supplier')}</dt><dd>${esc(tr.proveedor)}</dd>
      <dt>${tx('Cita', 'Booking')}</dt><dd>${fmt(tr.eta)}</dd><dt>${tx('Llegada', 'Arrival')}</dt><dd>${fmt(tr.llegada)}${tr.llegada - tr.eta > 10 ? ` (+${Math.round(tr.llegada - tr.eta)} min)` : ''}</dd>
      <dt>${tx('Muelle', 'Dock')}</dt><dd>${tr.dock ? tr.dock.id : '—'}</dd><dt>${tx('Espera en patio', 'Yard wait')}</dt><dd>${Math.round(espera)} min</dd>
      <dt>${tx('Palés', 'Pallets')}</dt><dd>${tr.descargados}/${tr.pales.length}</dd><dt>${tx('Parado por calle llena', 'Stopped by full lane')}</dt><dd>${Math.round(tr.bloqueo)} min</dd></dl></div>`;
  }
  if (sel.kind === 'truck' && sel.id.startsWith('out-')) {
    const ro = sim.routes.find((x) => `out-${x.id}` === sel.id);
    if (!ro) return null;
    const st = routeStatus(sim).find((r) => r.ro === ro);
    return `${back}<div class="title-row"><span class="big">${tx(`Ruta ${esc(placeName(ro.destino))}`, `${esc(placeName(ro.destino))} route`)}</span>${routePill(st)}</div>
      <div class="sec"><dl class="kv"><dt>${tx('Salida', 'Departure')}</dt><dd>${fmt(ro.salida)}</dd><dt>${tx('Muelle', 'Dock')}</dt><dd>${ro.dock.id}</dd><dt>${tx('Pedidos', 'Orders')}</dt><dd>${st.total}</dd>
      <dt>${tx('Listos', 'Ready')}</dt><dd>${st.listos}</dd><dt>${tx('En preparación', 'Being picked')}</dt><dd>${st.enCurso}</dd><dt>${tx('Pendientes', 'Pending')}</dt><dd>${st.pendientes}</dd></dl></div>`;
  }
  if (sel.kind === 'location') {
    const loc = sim.L.locations[sel.id];
    if (!loc || loc.sku < 0) return `${back}<p class="muted">${tx('Hueco libre.', 'Free location.')}</p>`;
    const sku = sim.skus[loc.sku];
    const otros = [...sku.locs].filter((i) => i !== loc.idx).map((i) => sim.L.locations[i]).filter((l) => l.units > 0);
    return `${back}<div class="title-row"><span class="big">${esc(loc.id)}</span><span class="pill ${loc.role === 'pick' ? 'ok' : ''}">${loc.role === 'pick' ? tx('Picking', 'Pick face') : tx('Reserva', 'Reserve')}</span></div>
      <div class="sec"><h4>${tx('Contenido', 'Contents')}</h4><dl class="kv"><dt>${tx('Referencia', 'SKU')}</dt><dd>${esc(sku.code)}</dd><dt>${tx('Producto', 'Product')}</dt><dd>${esc(sku.nombre)}</dd><dt>${tx('Clase', 'Class')}</dt><dd>${sku.cls}</dd>
      <dt>${tx('Cajas', 'Cases')}</dt><dd>${loc.units} / ${sku.upp}</dd><dt>${tx('Nivel', 'Level')}</dt><dd>${loc.level + 1}</dd><dt>${tx('Visitas hoy', 'Visits today')}</dt><dd>${loc.picks}</dd></dl></div>
      <div class="sec"><h4>${tx('La referencia', 'The SKU')}</h4><dl class="kv"><dt>${tx('Demanda', 'Demand')}</dt><dd>${num(sku.demanda)} ${tx('cajas/día', 'cases/day')}</dd><dt>${tx('Líneas hoy', 'Lines today')}</dt><dd>${sku.lineas}</dd><dt>${tx('Incompletas', 'Short')}</dt><dd>${sku.cortas}</dd>
      <dt>${tx('Otros huecos', 'Other locations')}</dt><dd>${otros.length ? otros.slice(0, 6).map((l) => esc(l.id)).join(', ') : '—'}</dd></dl></div>`;
  }
  return null;
}

function routePill(st) {
  const map = {
    'salio-ok': [tx('Salió completa', 'Left in full'), 'ok'],
    'salio-tarde': [tx('Salió incompleta', 'Left short'), 'bad'],
    riesgo: [tx('En riesgo', 'At risk'), 'bad'],
    justa: [tx('Justa', 'Tight'), 'warn'],
    ok: [tx('A tiempo', 'On time'), 'ok'],
  };
  const [txt, cls] = map[st.estado];
  return `<span class="pill ${cls}">${txt}</span>`;
}

export function renderRoutes(sim) {
  const sts = routeStatus(sim);
  const rows = sts.map((st) => {
    const ro = st.ro;
    const done = ro.salio ? ro.expedidos : st.listos;
    const p = st.total ? done / st.total : 0;
    const cls = st.estado === 'riesgo' || st.estado === 'salio-tarde' ? 'bad' : st.estado === 'justa' ? 'warn' : '';
    return `<tr class="click" data-sel="truck:out-${ro.id}"><td><b>${esc(placeName(ro.destino))}</b><br><span class="muted mono" style="font-size:11px">${fmt(ro.salida)} · ${ro.dock.id}</span></td>
      <td style="min-width:90px"><div class="bar ${cls}"><span style="width:${p * 100}%"></span></div><span class="muted mono" style="font-size:11px">${done}/${st.total}</span></td>
      <td>${routePill(st)}</td></tr>`;
  }).join('');
  return `<div class="sec"><h4>${tx('Rutas de hoy', 'Today\'s routes')}</h4><table class="t"><thead><tr><th>${tx('Ruta', 'Route')}</th><th>${tx('Listos', 'Ready')}</th><th>${tx('Estado', 'Status')}</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">${tx(
    '«En riesgo»: el trabajo pendiente de la ruta y de las que salen antes no cabe en los minutos de carretilla disponibles hasta su salida (descontando taller y un 20 % para recepción). Corte de pedidos: 40 min antes de la salida.',
    '"At risk": the pending work for the route and the ones leaving before it does not fit in the forklift minutes available until departure (minus the workshop and 20% for receiving). Order cut-off: 40 min before departure.',
  )}</p></div>`;
}

export function riskCount(sim) {
  return routeStatus(sim).filter((r) => r.estado === 'riesgo').length;
}

const SCN = {
  actual: () => tx('Como está hoy', 'As it is today'),
  ruta: () => tx('Con ruta optimizada', 'With optimised routing'),
  abc: () => tx('Slotting ABC + ruta', 'ABC slotting + routing'),
};

export function renderOpt(opt, state) {
  if (!opt) return `<p class="muted">${tx('Calculando…', 'Calculating…')}</p>`;
  const max = opt.escenarios[0].minutosPedido;
  const scn = opt.escenarios.map((e, i) => `<div class="scn"><span class="name">${esc(SCN[e.id]())} <span class="muted mono" style="font-size:11px">${num(e.metrosPedido)} m</span></span><span class="val">${n1(e.minutosPedido)} min${i ? ` <span class="muted" style="font-weight:400">−${pct(e.ahorro, 0)}</span>` : ''}</span>
      <div class="bar ${i === 0 ? 'warn' : ''}"><span style="width:${(e.minutosPedido / max) * 100}%"></span></div></div>`).join('');
  const moves = opt.top.map((m) => `<tr><td class="mono">${esc(m.sku.code)}<br><span class="muted" style="font-size:11px">${tx('clase', 'class')} ${m.sku.cls}</span></td><td class="mono">${esc(m.from.id)}</td><td class="mono">${esc(m.to.id)}</td></tr>`).join('');
  const day = state.dayCompare;
  const cmp = day ? `<div class="sec"><h4>${tx('Día completo simulado', 'Full simulated day')}</h4><table class="t"><thead><tr><th></th><th class="num">${tx('Actual', 'Current')}</th><th class="num">ABC</th></tr></thead><tbody>
      <tr><td>OTIF</td><td class="num">${pct(day.actual.otif)}</td><td class="num">${pct(day.abc.otif)}</td></tr>
      <tr><td>${tx('Utilización equipos', 'Equipment utilisation')}</td><td class="num">${pct(day.actual.utilizacion)}</td><td class="num">${pct(day.abc.utilizacion)}</td></tr>
      <tr><td>${tx('Metros por línea', 'Metres per line')}</td><td class="num">${n1(day.actual.metrosLinea)}</td><td class="num">${n1(day.abc.metrosLinea)}</td></tr>
      <tr><td>${tx('Líneas/h·equipo', 'Lines/h per truck')}</td><td class="num">${num(day.actual.productividad)}</td><td class="num">${num(day.abc.productividad)}</td></tr></tbody></table>
      <p class="note">${tx('Mismo día, mismos pedidos, camiones e incidencias; solo cambia dónde está cada referencia.', 'Same day, same orders, trucks and incidents; only where each SKU sits changes.')}</p></div>` : '';
  return `
    <div class="sec"><h4>${tx(`Minutos por pedido · ${opt.pedidos} pedidos de hoy`, `Minutes per order · today's ${opt.pedidos} orders`)}</h4><div class="scenarios">${scn}</div></div>
    <div class="callout">${tx(
    `<b>${n1(opt.horasAhorro)} horas-equipo al día</b> de ahorro con slotting ABC y ruta optimizada: ${n1(opt.equipos)} carretillas de un turno de 8 h. Hoy ${opt.aFuera} de ${opt.aTotal} referencias A (las que suman el 80 % de las líneas) están fuera de la zona dorada.`,
    `<b>${n1(opt.horasAhorro)} equipment-hours a day</b> saved with ABC slotting and optimised routing: ${n1(opt.equipos)} forklifts on an 8-hour shift. Today ${opt.aFuera} of ${opt.aTotal} A SKUs (the ones making up 80% of lines) are outside the golden zone.`,
  )}</div>
    <div class="btn-row">
      <button class="btn" data-act="abc-toggle">${state.slotting === 'abc' ? tx('Volver al slotting actual', 'Back to current slotting') : tx('Simular hoy con slotting ABC', 'Simulate today with ABC slotting')}</button>
      <button class="btn secondary" data-act="mode-abc">${tx('Ver mapa ABC', 'Show ABC map')}</button>
    </div>
    ${state.slotting === 'abc' ? `<p class="note">${tx('Estás viendo el día re-simulado con el slotting propuesto desde las 06:00.', 'You are watching the day re-simulated with the proposed slotting from 06:00.')}</p>` : ''}
    ${cmp}
    <div class="sec" style="margin-top:16px"><h4>${tx(`Cambios de más impacto (${opt.cambios} en total)`, `Highest-impact moves (${opt.cambios} in total)`)}</h4>
      <table class="t"><thead><tr><th>${tx('Referencia', 'SKU')}</th><th>${tx('De', 'From')}</th><th>${tx('A', 'To')}</th></tr></thead><tbody>${moves}</tbody></table></div>
    <p class="note">${tx(
    'Método: cada hueco tiene un coste (recorrido desde expedición + tiempo de elevación por nivel). Las referencias se ordenan por líneas previstas y se asignan a los huecos más baratos. Los pedidos se recorren por vecino más próximo.',
    'Method: each location has a cost (travel from dispatch + lift time per level). SKUs are ranked by forecast lines and assigned to the cheapest locations. Orders are routed by nearest neighbour.',
  )}</p>`;
}
