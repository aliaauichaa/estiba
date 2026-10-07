// Contenido del panel lateral (HTML). Todo texto variable pasa por esc().

import { fmt } from '../sim/engine.js';
import { pct, num, routeStatus } from '../analysis/assistant.js';
import { esc } from './md.js';

const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function forkState(f) {
  if (f.enTaller) return ['En taller', 'bad'];
  const t = f.task?.tipo;
  if (t === 'taller') return ['Yendo al taller', 'bad'];
  if (t === 'picking') return ['Preparando', 'ok'];
  if (t === 'ubicacion') return ['Ubicando', 'info'];
  return ['Libre', ''];
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
      <td>${tr ? `${esc(tr.matricula)}<br><span class="muted">${esc(tr.proveedor)}</span>` : '<span class="muted">Libre</span>'}</td>
      <td class="num">${tr ? `${tr.descargados}/${tr.pales.length}` : '—'}</td>
      <td><div class="bar ${cls}"><span style="width:${Math.min(100, capPct * 100)}%"></span></div><span class="muted mono" style="font-size:11px">${lane}/${sim.site.capCalle}</span></td></tr>`;
  }).join('');
  const yard = sim.yard.length;
  return `
    <div class="sec"><h4>Carretillas</h4>
      <table class="t"><thead><tr><th>Equipo</th><th>Estado</th><th class="num">Líneas</th><th class="num">Palés</th><th class="num">Uso</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="sec"><h4>Muelles de recepción</h4>
      <table class="t"><thead><tr><th>Muelle</th><th>Camión</th><th class="num">Desc.</th><th>Calle</th></tr></thead><tbody>${docks}</tbody></table>
      <p class="note">${yard ? `${yard} camión${yard > 1 ? 'es' : ''} esperando en el patio.` : 'Nadie esperando en el patio.'} La calle es el espacio delante del muelle: si se llena, la descarga se para.</p>
    </div>
    <p class="note">Haz clic en una carretilla, un camión o un hueco de la nave para ver su detalle.</p>`;
}

export function renderSelection(sim, sel) {
  const back = '<button class="back" data-sel="none">← Volver al resumen</button>';
  if (sel.kind === 'forklift') {
    const f = sim.forklifts.find((x) => x.id === sel.id);
    if (!f) return null;
    const [txt, cls] = forkState(f);
    const u = f.disponible > 0 ? f.ocupado / f.disponible : null;
    let task = '<p class="muted">Sin tarea asignada.</p>';
    if (f.task?.tipo === 'picking') {
      const o = f.task.pedido;
      task = `<dl class="kv"><dt>Pedido</dt><dd>${esc(o.id)}</dd><dt>Cliente</dt><dd>${esc(o.cliente)}</dd><dt>Ruta</dt><dd>${esc(o.route.destino)} · ${fmt(o.route.salida)}</dd>
        <dt>Líneas</dt><dd>${o.lines.length}${o.cortas ? ` (${o.cortas} incompletas)` : ''}</dd><dt>Paradas</dt><dd>${f.task.paradas.map(esc).join(' → ') || '—'}</dd><dt>Termina</dt><dd>${fmt(f.endT)}</dd></dl>`;
    } else if (f.task?.tipo === 'ubicacion') {
      const p = f.task.pal;
      const sku = sim.skus[p.sku];
      task = `<dl class="kv"><dt>Palé</dt><dd>${esc(sku.code)}</dd><dt>Producto</dt><dd>${esc(sku.nombre)}</dd><dt>Desde</dt><dd>${p.dock.id} (${esc(p.camion)})</dd>
        <dt>Hasta</dt><dd>${esc(f.task.dest.id)}</dd><dt>En calle desde</dt><dd>${fmt(p.tDescarga)}</dd><dt>Termina</dt><dd>${fmt(f.endT)}</dd></dl>`;
    } else if (f.enTaller || f.task?.tipo === 'taller') {
      task = `<p>${esc(f.taller?.motivo || 'Fuera de servicio')}. Vuelve hacia las ${fmt(f.taller?.hasta ?? sim.t)}.</p>`;
    }
    return `${back}<div class="title-row"><span class="big">${f.id}</span><span class="pill ${cls}">${txt}</span></div>
      <div class="sec"><h4>Tarea actual</h4>${task}</div>
      <div class="sec"><h4>Hoy</h4><dl class="kv"><dt>Pedidos</dt><dd>${f.pedidos}</dd><dt>Líneas</dt><dd>${f.lineas}</dd><dt>Palés ubicados</dt><dd>${f.pales}</dd>
        <dt>Recorrido</dt><dd>${nf1.format(f.metros / 1000)} km</dd><dt>Utilización</dt><dd>${pct(u)}</dd></dl></div>
      <p class="note">La línea discontinua en la nave es la ruta que está siguiendo; los discos, sus paradas.</p>`;
  }
  if (sel.kind === 'truck' && sel.id.startsWith('in-')) {
    const tr = sim.trucks.find((x) => `in-${x.id}` === sel.id);
    if (!tr) return null;
    const estado = { patio: ['En patio', 'warn'], muelle: ['En muelle', 'info'], fuera: ['Descargado', 'ok'] }[tr.estado] || [tr.estado, ''];
    return `${back}<div class="title-row"><span class="big">${esc(tr.matricula)}</span><span class="pill ${estado[1]}">${estado[0]}</span></div>
      <div class="sec"><h4>Entrada</h4><dl class="kv"><dt>Transportista</dt><dd>${esc(tr.transportista)}</dd><dt>Proveedor</dt><dd>${esc(tr.proveedor)}</dd>
      <dt>Cita</dt><dd>${fmt(tr.eta)}</dd><dt>Llegada</dt><dd>${fmt(tr.llegada)}${tr.llegada - tr.eta > 10 ? ` (+${Math.round(tr.llegada - tr.eta)} min)` : ''}</dd>
      <dt>Muelle</dt><dd>${tr.dock ? tr.dock.id : '—'}</dd><dt>Espera en patio</dt><dd>${tr.espera != null ? `${Math.round(tr.espera)} min` : `${Math.round(sim.t - tr.tPatio)} min`}</dd>
      <dt>Palés</dt><dd>${tr.descargados}/${tr.pales.length}</dd><dt>Parado por calle llena</dt><dd>${Math.round(tr.bloqueo)} min</dd></dl></div>`;
  }
  if (sel.kind === 'truck' && sel.id.startsWith('out-')) {
    const ro = sim.routes.find((x) => `out-${x.id}` === sel.id);
    if (!ro) return null;
    const st = routeStatus(sim).find((r) => r.ro === ro);
    return `${back}<div class="title-row"><span class="big">Ruta ${esc(ro.destino)}</span>${routePill(st)}</div>
      <div class="sec"><dl class="kv"><dt>Salida</dt><dd>${fmt(ro.salida)}</dd><dt>Muelle</dt><dd>${ro.dock.id}</dd><dt>Pedidos</dt><dd>${st.total}</dd>
      <dt>Listos</dt><dd>${st.listos}</dd><dt>En preparación</dt><dd>${st.enCurso}</dd><dt>Pendientes</dt><dd>${st.pendientes}</dd></dl></div>`;
  }
  if (sel.kind === 'location') {
    const loc = sim.L.locations[sel.id];
    if (!loc || loc.sku < 0) return `${back}<p class="muted">Hueco libre.</p>`;
    const sku = sim.skus[loc.sku];
    const otros = [...sku.locs].filter((i) => i !== loc.idx).map((i) => sim.L.locations[i]).filter((l) => l.units > 0);
    return `${back}<div class="title-row"><span class="big">${esc(loc.id)}</span><span class="pill ${loc.role === 'pick' ? 'ok' : ''}">${loc.role === 'pick' ? 'Picking' : 'Reserva'}</span></div>
      <div class="sec"><h4>Contenido</h4><dl class="kv"><dt>Referencia</dt><dd>${esc(sku.code)}</dd><dt>Producto</dt><dd>${esc(sku.nombre)}</dd><dt>Clase</dt><dd>${sku.cls}</dd>
      <dt>Cajas</dt><dd>${loc.units} / ${sku.upp}</dd><dt>Nivel</dt><dd>${loc.level + 1}</dd><dt>Visitas hoy</dt><dd>${loc.picks}</dd></dl></div>
      <div class="sec"><h4>La referencia</h4><dl class="kv"><dt>Demanda</dt><dd>${num(sku.demanda)} cajas/día</dd><dt>Líneas hoy</dt><dd>${sku.lineas}</dd><dt>Incompletas</dt><dd>${sku.cortas}</dd>
      <dt>Otros huecos</dt><dd>${otros.length ? otros.slice(0, 6).map((l) => esc(l.id)).join(', ') : '—'}</dd></dl></div>`;
  }
  return null;
}

function routePill(st) {
  const map = {
    'salio-ok': ['Salió completa', 'ok'],
    'salio-tarde': ['Salió incompleta', 'bad'],
    riesgo: ['En riesgo', 'bad'],
    justa: ['Justa', 'warn'],
    ok: ['A tiempo', 'ok'],
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
    return `<tr class="click" data-sel="truck:out-${ro.id}"><td><b>${esc(ro.destino)}</b><br><span class="muted mono" style="font-size:11px">${fmt(ro.salida)} · ${ro.dock.id}</span></td>
      <td style="min-width:90px"><div class="bar ${cls}"><span style="width:${p * 100}%"></span></div><span class="muted mono" style="font-size:11px">${done}/${st.total}</span></td>
      <td>${routePill(st)}</td></tr>`;
  }).join('');
  return `<div class="sec"><h4>Rutas de hoy</h4><table class="t"><thead><tr><th>Ruta</th><th>Listos</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">«En riesgo»: el trabajo pendiente de la ruta y de las que salen antes no cabe en los minutos de carretilla disponibles hasta su salida (descontando taller y un 20 % para recepción). Corte de pedidos: 40 min antes de la salida.</p></div>`;
}

export function riskCount(sim) {
  return routeStatus(sim).filter((r) => r.estado === 'riesgo').length;
}

export function renderOpt(opt, state) {
  if (!opt) return '<p class="muted">Calculando…</p>';
  const max = opt.escenarios[0].minutosPedido;
  const scn = opt.escenarios.map((e, i) => `<div class="scn"><span class="name">${esc(e.nombre)} <span class="muted mono" style="font-size:11px">${num(e.metrosPedido)} m</span></span><span class="val">${nf1.format(e.minutosPedido)} min${i ? ` <span class="muted" style="font-weight:400">−${pct(e.ahorro, 0)}</span>` : ''}</span>
      <div class="bar ${i === 0 ? 'warn' : ''}"><span style="width:${(e.minutosPedido / max) * 100}%"></span></div></div>`).join('');
  const moves = opt.top.map((m) => `<tr><td class="mono">${esc(m.sku.code)}<br><span class="muted" style="font-size:11px">clase ${m.sku.cls}</span></td><td class="mono">${esc(m.from.id)}</td><td class="mono">${esc(m.to.id)}</td></tr>`).join('');
  const day = state.dayCompare;
  const cmp = day ? `<div class="sec"><h4>Día completo simulado</h4><table class="t"><thead><tr><th></th><th class="num">Actual</th><th class="num">ABC</th></tr></thead><tbody>
      <tr><td>OTIF</td><td class="num">${pct(day.actual.otif)}</td><td class="num">${pct(day.abc.otif)}</td></tr>
      <tr><td>Utilización equipos</td><td class="num">${pct(day.actual.utilizacion)}</td><td class="num">${pct(day.abc.utilizacion)}</td></tr>
      <tr><td>Metros por línea</td><td class="num">${nf1.format(day.actual.metrosLinea)}</td><td class="num">${nf1.format(day.abc.metrosLinea)}</td></tr>
      <tr><td>Líneas/h·equipo</td><td class="num">${num(day.actual.productividad)}</td><td class="num">${num(day.abc.productividad)}</td></tr></tbody></table>
      <p class="note">Mismo día, mismos pedidos, camiones e incidencias; solo cambia dónde está cada referencia.</p></div>` : '';
  return `
    <div class="sec"><h4>Minutos por pedido · ${opt.pedidos} pedidos de hoy</h4><div class="scenarios">${scn}</div></div>
    <div class="callout"><b>${nf1.format(opt.horasAhorro)} horas-equipo al día</b> de ahorro con slotting ABC y ruta optimizada: ${nf1.format(opt.equipos)} carretillas de un turno de 8 h.
      Hoy ${opt.aFuera} de ${opt.aTotal} referencias A (las que suman el 80 % de las líneas) están fuera de la zona dorada.</div>
    <div class="btn-row">
      <button class="btn" data-act="abc-toggle">${state.slotting === 'abc' ? 'Volver al slotting actual' : 'Simular hoy con slotting ABC'}</button>
      <button class="btn secondary" data-act="mode-abc">Ver mapa ABC</button>
    </div>
    ${state.slotting === 'abc' ? '<p class="note">Estás viendo el día re-simulado con el slotting propuesto desde las 06:00.</p>' : ''}
    ${cmp}
    <div class="sec" style="margin-top:16px"><h4>Cambios de más impacto (${opt.cambios} en total)</h4>
      <table class="t"><thead><tr><th>Referencia</th><th>De</th><th>A</th></tr></thead><tbody>${moves}</tbody></table></div>
    <p class="note">Método: cada hueco tiene un coste (recorrido desde expedición + tiempo de elevación por nivel). Las referencias se ordenan por líneas previstas y se asignan a los huecos más baratos. Los pedidos se recorren por vecino más próximo.</p>`;
}
