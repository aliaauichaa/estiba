// Operativa 1: almacén de distribución (Zaragoza). Junta en un sitio todo lo propio de esta operativa
// para que la página (main.js) sea la misma para las tres: simulador, escena, indicadores, pestañas,
// leyendas, avisos, seguimiento y asistente.

import { SITES } from '../data/sites.js';
import { Simulation, runDay, fmt } from '../sim/engine.js';
import { WarehouseScene } from '../scene/warehouse3d.js';
import { computeHistory } from '../analysis/history.js';
import { analyzeSlotting } from '../analysis/optimize.js';
import { answerLocal, diagnose, sugerencias, contextoDeRuta, routeStatus } from '../analysis/assistant.js';
import { contexto } from '../analysis/remote.js';
import { CHART_ALMACEN } from '../ui/chart.js';
import { renderOverview, renderSelection, renderRoutes, renderOpt, riskCount } from '../ui/panels.js';
import { tx, pct, num, placeName } from '../i18n.js';

const site = SITES[0];

const KPIS = [
  { id: 'otif', label: () => 'OTIF', tip: () => tx('Pedidos que salen a tiempo y completos', 'Orders shipped on time and in full'), f: (v) => pct(v), up: true, unit: 'pp' },
  { id: 'fill', label: () => 'Fill rate', tip: () => tx('Líneas servidas completas', 'Lines shipped in full'), f: (v) => pct(v), up: true, unit: 'pp' },
  { id: 'dts', label: () => 'Dock-to-stock', tip: () => tx('Minutos desde que el camión atraca hasta que el palé está ubicado', 'Minutes from the truck docking to the pallet being put away'), f: (v) => (v == null ? '—' : `${num(v)}<small>min</small>`), up: false, unit: 'min' },
  { id: 'utilizacion', label: () => tx('Uso de equipos', 'Equipment use'), tip: () => tx('Tiempo trabajando sobre tiempo disponible de las carretillas', 'Forklift working time over available time'), f: (v) => pct(v, 0), up: false, unit: 'pp' },
  { id: 'productividad', label: () => tx('Líneas/h·equipo', 'Lines/h per truck'), tip: () => tx('Líneas preparadas por hora y carretilla disponible', 'Lines picked per hour per available forklift'), f: (v) => num(v), up: true, unit: '' },
  { id: 'ocupacion', label: () => tx('Ocupación', 'Occupancy'), tip: () => tx('Huecos de estantería ocupados o asignados', 'Rack locations occupied or assigned'), f: (v) => pct(v, 0), up: false, unit: 'pp' },
  { id: 'calle', label: () => tx('Palés en calles', 'Pallets in lanes'), tip: () => tx('Palés descargados esperando a ser ubicados', 'Unloaded pallets waiting for put-away'), f: (v) => num(v), up: false, unit: '' },
];

const LEYENDAS = {
  operativa: () => tx(
    '<span><i style="background:#c9a36b"></i>Palé en estantería</span><span><i style="background:#ff6b5e"></i>Palé sin hueco</span><span><i style="background:#cfe7e3"></i>Pedido preparado</span><span><i style="background:#2ec4b6;border-radius:50%"></i>Carretilla preparando</span><span><i style="background:#6c9cf0;border-radius:50%"></i>Ubicando</span>',
    '<span><i style="background:#c9a36b"></i>Pallet in rack</span><span><i style="background:#ff6b5e"></i>Pallet with no location</span><span><i style="background:#cfe7e3"></i>Order ready</span><span><i style="background:#2ec4b6;border-radius:50%"></i>Forklift picking</span><span><i style="background:#6c9cf0;border-radius:50%"></i>Putting away</span>',
  ),
  ocupacion: () => tx(
    '<span><i style="background:#2ec4b6"></i>Hueco de picking con stock</span><span><i style="background:#f5a524"></i>Menos del 30 %</span><span><i style="background:#ff6b5e"></i>Picking vacío</span><span><i style="background:#3f7d79"></i>Reserva</span><span class="muted">La altura del palé indica las cajas que quedan</span>',
    '<span><i style="background:#2ec4b6"></i>Pick face with stock</span><span><i style="background:#f5a524"></i>Under 30%</span><span><i style="background:#ff6b5e"></i>Empty pick face</span><span><i style="background:#3f7d79"></i>Reserve</span><span class="muted">Pallet height shows the cases left</span>',
  ),
  abc: () => tx(
    '<span><i style="background:#2ec4b6"></i>A · 80 % de las líneas</span><span><i style="background:#f5a524"></i>B · 15 %</span><span><i style="background:#56627a"></i>C · 5 %</span><span><i style="background:#343c49"></i>Reserva</span>',
    '<span><i style="background:#2ec4b6"></i>A · 80% of lines</span><span><i style="background:#f5a524"></i>B · 15%</span><span><i style="background:#56627a"></i>C · 5%</span><span><i style="background:#343c49"></i>Reserve</span>',
  ),
  calor: () => tx(
    '<span>Visitas de picking hoy</span><span><span class="ramp" style="background:linear-gradient(90deg,#1f2a38,#3f6fc4,#f5a524,#ff6b5e)"></span></span>',
    '<span>Picking visits today</span><span><span class="ramp" style="background:linear-gradient(90deg,#1f2a38,#3f6fc4,#f5a524,#ff6b5e)"></span></span>',
  ),
};

// ---------------------------------------------------------------------------- seguimiento

const estadoPaso = (hecho, ahora) => (hecho ? 'done' : ahora ? 'now' : 'next');
const lineas = (n) => `${n} ${n === 1 ? tx('línea', 'line') : tx('líneas', 'lines')}`;

function pedidos(sim) {
  const enCurso = sim.orders.filter((o) => o.estado === 'en_curso');
  const listos = sim.orders.filter((o) => o.estado === 'preparado');
  const cola = sim.orders.filter((o) => o.estado === 'pendiente' && o.release <= sim.t).slice(0, 12);
  const lista = [...enCurso, ...listos.slice(-8), ...cola];
  if (lista.length) return lista;
  return sim.orders.filter((o) => o.estado === 'expedido' || o.retrasado).slice(-10).reverse();
}

function camiones(sim) {
  const orden = { muelle: 0, patio: 1, en_ruta: 2, fuera: 3 };
  return sim.trucks.slice().sort((a, b) => orden[a.estado] - orden[b.estado] || (a.estado === 'fuera' ? b.tFin - a.tFin : a.eta - b.eta));
}

function vistaPedido(sim, o) {
  const f = o.equipo ? sim.forklifts.find((x) => x.id === o.equipo) : null;
  const avance = o.estado === 'en_curso' && f?.track ? Math.min(1, (sim.t - f.track[0].t) / Math.max(0.01, f.endT - f.track[0].t)) : null;
  const salio = o.estado === 'expedido' && o.aTiempo;
  const pasos = [
    { label: tx('Liberado', 'Released'), det: fmt(o.release), estado: estadoPaso(o.release <= sim.t, false) },
    { label: tx('Preparación', 'Picking'), det: o.estado === 'en_curso' ? `${o.equipo} · ${pct(avance, 0)}` : o.tInicio != null ? `${o.equipo} · ${fmt(o.tInicio)}` : '—', estado: estadoPaso(o.listo != null, o.estado === 'en_curso') },
    { label: tx('En muelle', 'At dock'), det: o.listo != null ? `${o.route.dock.id} · ${fmt(o.listo)}` : o.route.dock.id, estado: estadoPaso(o.listo != null && !o.retrasado, false) },
    {
      label: tx('Salida', 'Departure'),
      det: o.retrasado ? tx('se quedó en tierra', 'left behind') : salio ? `${tx('salió', 'left')} ${fmt(o.route.salida)}` : `${tx('sale', 'leaves')} ${fmt(o.route.salida)}`,
      estado: o.retrasado ? 'bad' : estadoPaso(salio, false),
    },
  ];
  let lado;
  if (o.estado === 'en_curso') lado = { etiqueta: tx('PREPARANDO', 'PICKING'), titulo: o.equipo, sub: `${lineas(o.lines.length)} · ${o.cliente}`, pct: avance, sel: { kind: 'forklift', id: o.equipo } };
  else if (o.estado === 'preparado') lado = { etiqueta: tx('EN MUELLE', 'AT DOCK'), titulo: o.route.dock.id, sub: `${tx('Ruta', 'Route')} ${placeName(o.route.destino)}`, sel: o.route.camion ? { kind: 'truck', id: `out-${o.route.id}` } : null };
  else if (o.estado === 'pendiente') {
    lado = {
      etiqueta: o.retrasado ? tx('EN TIERRA', 'LEFT BEHIND') : tx('EN COLA', 'QUEUED'),
      titulo: placeName(o.route.destino),
      sub: o.retrasado ? tx(`salió a las ${fmt(o.route.salida)} sin él`, `left at ${fmt(o.route.salida)} without it`) : `${tx('sale', 'leaves')} ${fmt(o.route.salida)}`,
    };
  }
  else lado = { etiqueta: o.retrasado ? tx('EN TIERRA', 'LEFT BEHIND') : tx('EXPEDIDO', 'SHIPPED'), titulo: placeName(o.route.destino), sub: fmt(o.route.salida) };
  return {
    titulo: o.id,
    sub: `${o.cliente} · ${tx('ruta', 'route')} ${placeName(o.route.destino)} · ${lineas(o.lines.length)}`,
    pasos,
    lado,
  };
}

function vistaCamion(sim, tr) {
  const enMuelle = tr.estado === 'muelle';
  const pasos = [
    { label: tx('Cita', 'Booking'), det: fmt(tr.eta), estado: 'done' },
    { label: tx('Patio', 'Yard'), det: tr.tPatio != null ? `${fmt(tr.tPatio)}${tr.llegada - tr.eta > 10 ? ` (+${Math.round(tr.llegada - tr.eta)})` : ''}` : `ETA ${fmt(tr.llegada)}`, estado: estadoPaso(tr.tMuelle != null, tr.estado === 'patio') },
    { label: tx('Muelle', 'Dock'), det: tr.tMuelle != null ? `${tr.dock?.id ?? ''} · ${fmt(tr.tMuelle)}` : '—', estado: estadoPaso(tr.tMuelle != null, false) },
    { label: tx('Descarga', 'Unloading'), det: `${tr.descargados}/${tr.pales.length}`, estado: estadoPaso(tr.estado === 'fuera', enMuelle) },
    { label: tx('Ubicado', 'Put away'), det: tr.tUbicado != null ? `${fmt(tr.tUbicado)} · ${num(tr.tUbicado - tr.tMuelle)} min` : `${tr.ubicados || 0}/${tr.pales.length}`, estado: estadoPaso(tr.tUbicado != null, tr.estado === 'fuera') },
  ];
  const lado = enMuelle
    ? { etiqueta: tx('DESCARGANDO', 'UNLOADING'), titulo: tr.dock.id, sub: tr.proveedor, pct: tr.descargados / tr.pales.length, sel: { kind: 'truck', id: `in-${tr.id}` } }
    : tr.estado === 'patio'
      ? { etiqueta: tx('EN PATIO', 'IN YARD'), titulo: `${Math.round(sim.t - tr.tPatio)} min`, sub: tr.proveedor, sel: { kind: 'truck', id: `in-${tr.id}` } }
      : tr.estado === 'en_ruta'
        ? { etiqueta: tx('EN CAMINO', 'ON ITS WAY'), titulo: `ETA ${fmt(tr.llegada)}`, sub: tr.proveedor }
        : { etiqueta: tx('DESCARGADO', 'UNLOADED'), titulo: fmt(tr.tFin), sub: tr.proveedor };
  return { titulo: tr.matricula, sub: `${tr.transportista} · ${tr.proveedor} · ${tr.pales.length} ${tx('palés', 'pallets')}`, pasos, lado };
}

// ---------------------------------------------------------------------------- avisos

function toast(e) {
  const ver = e.ref?.kind ? e.ref : null;
  const vista = e.ref?.view || null;
  if (e.tipo === 'taller' && e.nivel === 'alerta') return { titulo: tx('Carretilla al taller', 'Forklift to the workshop'), ver, ia: tx('¿Cómo afecta el taller al turno?', 'How does the workshop affect the shift?') };
  if (e.tipo === 'taller') return { titulo: tx('Carretilla operativa', 'Forklift back in service'), ver };
  if (e.tipo === 'llegada') return { titulo: tx('Camión en el patio', 'Truck in the yard'), ver };
  if (e.tipo === 'muelle' && e.nivel === 'alerta') return { titulo: tx('Espera larga en el patio', 'Long wait in the yard'), ver, ia: tx('¿Cómo va la recepción?', 'How is receiving going?') };
  if (e.tipo === 'salida' && e.nivel === 'alerta') return { titulo: tx('Descarga frenada', 'Unloading held up'), ver, ia: tx('¿Cómo va la recepción?', 'How is receiving going?') };
  if (e.tipo === 'ruta' && e.nivel === 'ok') return { titulo: tx('Ruta completa', 'Route left in full'), ver };
  if (e.tipo === 'ruta' && e.nivel === 'alerta') return { titulo: tx('Pedidos en tierra', 'Orders left behind'), ver, ia: tx('¿Por qué baja el OTIF hoy?', 'Why is OTIF dropping today?') };
  if (e.tipo === 'hueco') return { titulo: tx('Palé sin hueco', 'Pallet with no location'), vista, clave: 'hueco' };
  return null;
}

// Memoria por simulación: el cálculo de riesgo oscila alrededor de 1 de un paso al siguiente; una vez en
// riesgo, la ruta sigue «en riesgo» para los avisos hasta que sale (así no avisa en ráfagas).
const avisadas = new WeakMap();

function alertas(sim) {
  const out = new Map();
  let ya = avisadas.get(sim);
  if (!ya) avisadas.set(sim, (ya = new Set()));
  for (const r of routeStatus(sim)) {
    if (r.ro.salio) continue;
    if (r.estado === 'riesgo') ya.add(r.ro.id);
    if (!ya.has(r.ro.id)) continue;
    const ro = r.ro;
    out.set(`riesgo-${ro.id}`, {
      nivel: 'alerta',
      titulo: tx('Ruta en riesgo', 'Route at risk'),
      texto: tx(`${placeName(ro.destino)} sale a las ${fmt(ro.salida)} con ${r.pendientes + r.enCurso} pedidos sin preparar.`, `${placeName(ro.destino)} leaves at ${fmt(ro.salida)} with ${r.pendientes + r.enCurso} orders still to pick.`),
      ver: ro.camion ? { kind: 'truck', id: `out-${ro.id}` } : null,
      tab: 'rutas',
      ia: tx('¿Qué rutas están en riesgo?', 'Which routes are at risk?'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------- operativa

export function crearAlmacen() {
  const local = { opt: null, dayCompare: null };
  const content = new WarehouseScene();
  return {
    id: 'almacen',
    nombre: () => tx('Almacén', 'Warehouse'),
    sub: () => site.nombre,
    lugar: () => site.nombre,
    content,
    kpis: KPIS,
    chart: CHART_ALMACEN,
    tabs: [
      { id: 'detalle', nombre: () => tx('Operativa', 'Operations') },
      { id: 'rutas', nombre: () => tx('Expediciones', 'Dispatch') },
      { id: 'opt', nombre: () => tx('Optimización', 'Optimisation') },
    ],
    hint: () => tx('Arrastra para mover · rueda para acercar · clic en una carretilla, un camión o un hueco', 'Drag to pan · scroll to zoom · click a forklift, a truck or a location'),
    legend: (mode) => LEYENDAS[mode](),

    crearSim(variant) {
      const sim = new Simulation(site, { slotting: variant === 'abc' ? 'abc' : 'actual' });
      if (!local.opt) local.opt = analyzeSlotting(variant === 'abc' ? new Simulation(site) : sim);
      return sim;
    },
    historia: () => computeHistory(site, 14),
    // Mismo día de otra operativa, hasta la hora t (para el punto de estado del selector).
    simA(t) { const s = new Simulation(site); s.advance(t - s.t); return s; },

    renderTab(tab, sim, ui) {
      if (tab === 'detalle') return (ui.sel && renderSelection(sim, ui.sel)) || renderOverview(sim);
      if (tab === 'rutas') return renderRoutes(sim);
      if (!local.dayCompare) {
        local.dayCompare = { actual: runDay(site, 0, { slotting: 'actual' }).kpis(), abc: runDay(site, 0, { slotting: 'abc' }).kpis() };
      }
      return renderOpt(local.opt, { slotting: ui.variant === 'abc' ? 'abc' : 'actual', dayCompare: local.dayCompare });
    },
    onAct(act, ui) {
      if (act === 'mode-abc') ui.setMode('abc');
      if (act === 'abc-toggle') {
        ui.setVariant(ui.variant === 'abc' ? null : 'abc');
        if (ui.variant === 'abc') ui.setMode('abc');
        ui.setTab('opt');
      }
    },
    parseSel: (kind, id) => ({ kind, id: kind === 'location' ? Number(id) : id }),
    badges: (sim) => ({ rutas: riskCount(sim) }),

    banner(sim) {
      const activas = sim.incidencias.filter((w) => w.empezo && !w.acabo);
      if (activas.length) {
        const n = activas.length;
        const ids = activas.map((w) => w.f.id).join(', ');
        const h = fmt(Math.max(...activas.map((w) => w.hasta)));
        return tx(
          `<b>${n} ${n > 1 ? 'carretillas' : 'carretilla'} en el taller</b> (${ids}) hasta las ${h}. <button type="button" class="link-btn" data-open-ai>Pregunta a la IA cómo afecta</button>`,
          `<b>${n} ${n > 1 ? 'forklifts' : 'forklift'} in the workshop</b> (${ids}) until ${h}. <button type="button" class="link-btn" data-open-ai>Ask the AI how it affects the shift</button>`,
        );
      }
      if (sim.c.sinHueco > 0 && sim.freeLocations() < 3) {
        return tx('<b>Nave llena:</b> hay palés en recepción sin hueco donde ubicarlos.', '<b>Warehouse full:</b> there are pallets in receiving with no location to go to.');
      }
      return '';
    },

    toast,
    alertas,

    tracker: {
      modos: [{ id: 'pedido', nombre: () => tx('Pedidos', 'Orders') }, { id: 'camion', nombre: () => tx('Camiones', 'Trucks') }],
      titulo: (modo) => (modo === 'pedido' ? tx('Seguimiento del pedido', 'Order tracking') : tx('Seguimiento del camión', 'Truck tracking')),
      items: (sim, modo) => (modo === 'pedido' ? pedidos(sim).map((o) => o.id) : camiones(sim).map((t) => t.id)),
      vista(sim, modo, key) {
        if (modo === 'pedido') {
          const o = sim.orders.find((x) => x.id === key);
          return o ? vistaPedido(sim, o) : null;
        }
        const tr = sim.trucks.find((x) => x.id === key);
        return tr ? vistaCamion(sim, tr) : null;
      },
      // Al seleccionar algo en la nave, el seguimiento salta a lo que corresponde.
      desdeSel(sim, sel) {
        if (sel.kind === 'forklift') {
          const f = sim.forklifts.find((x) => x.id === sel.id);
          if (f?.task?.tipo === 'picking') return { modo: 'pedido', key: f.task.pedido.id };
          if (f?.task?.tipo === 'ubicacion' && f.task.pal.truck) return { modo: 'camion', key: f.task.pal.truck.id };
        }
        if (sel.kind === 'truck' && sel.id.startsWith('in-')) return { modo: 'camion', key: sel.id.slice(3) };
        if (sel.kind === 'truck' && sel.id.startsWith('out-')) {
          const ro = sim.routes.find((r) => `out-${r.id}` === sel.id);
          const lista = pedidos(sim).filter((p) => p.route === ro);
          const o = lista.find((p) => p.estado === 'en_curso') || lista[0];
          if (o) return { modo: 'pedido', key: o.id };
        }
        return null;
      },
    },

    asistente: {
      bienvenida: () => tx(
        `Hola. Tengo delante el turno del almacén de **${site.nombre}** en tiempo real y los 14 días anteriores para comparar. Pregúntame lo que necesites. También puedo contarte quién ha creado Estiba.`,
        `Hi. I am looking at the **${site.nombre}** warehouse shift in real time, with the previous 14 days to compare against. Ask me anything. I can also tell you who built Estiba.`,
      ),
      teaser: () => tx('«¿Por qué baja el OTIF hoy?»', '"Why is OTIF dropping today?"'),
      placeholder: () => tx('Pregunta sobre el turno…', 'Ask about the shift…'),
      sugerencias,
      ctx: (sim, history) => ({ sim, history, opt: local.opt }),
      answerLocal,
      contexto,
      contextoDeRuta,
      estado(sim, history) {
        const d = diagnose(sim, history);
        const top = d.hallazgos[0];
        if (top) return { nivel: top.peso >= 3 ? 'bad' : 'warn', titulo: top.titulo };
        const riesgo = d.rutas.filter((r) => r.estado === 'riesgo').length;
        if (riesgo) return { nivel: 'warn', titulo: tx(`${riesgo} ${riesgo === 1 ? 'ruta en riesgo' : 'rutas en riesgo'}`, `${riesgo} ${riesgo === 1 ? 'route at risk' : 'routes at risk'}`) };
        return { nivel: 'ok', titulo: tx('Sin incidencias', 'No issues') };
      },
    },
  };
}
