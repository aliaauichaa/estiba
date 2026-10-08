// Asistente de operaciones. Responde con datos de la simulación: compara hoy con la media de los
// 14 días anteriores a la misma hora, busca la causa en la cadena (equipos → calles → stock → rutas)
// y propone acciones. Funciona sin servidor; si hay API configurada, un modelo redacta la respuesta
// a partir de este mismo diagnóstico (ver src/analysis/remote.js).
// Todo texto va en español e inglés con tx('es', 'en'), según el idioma de la interfaz.

import { baselineAt } from './history.js';
import { fmt } from '../sim/engine.js';
import { tx, num, pct, ppUnit, placeName } from '../i18n.js';
import { esPreguntaSobreAli } from '../../lambda/asistente/ruta.mjs';

export { num, pct };
const n1 = (v) => num(v, 1);
const pp = (a, b) => (a == null || b == null ? null : (a - b) * 100);
const sgn = (v) => (v == null ? '' : `${Math.abs(v) < 0.05 ? '±' : v > 0 ? '+' : '−'}${n1(Math.abs(v))}${ppUnit()}`);
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const plural = (n, es1, esN, en1, enN) => tx(n === 1 ? es1 : esN, n === 1 ? en1 : enN);
const forklifts = (n) => plural(n, 'carretilla', 'carretillas', 'forklift', 'forklifts');
const route = (ro) => placeName(ro.destino);

// ---------------------------------------------------------------------------- diagnóstico

export function routeStatus(sim) {
  const avgMin = sim.c.pedidosPreparados ? sim.c.minutosPicking / sim.c.pedidosPreparados : 9;
  // Minutos-equipo disponibles desde ahora hasta T, descontando las carretillas en el taller
  // y reservando un 20 % para ubicar palés de recepción.
  const capacidad = (T) => 0.8 * sim.forklifts.reduce((s, f) => {
    const w = f.taller;
    let min = Math.max(0, T - sim.t);
    if (w && !w.acabo) min -= Math.max(0, Math.min(T, w.hasta) - Math.max(sim.t, w.desde));
    return s + Math.max(0, min);
  }, 0);
  let carga = 0; // minutos-equipo acumulados de las rutas anteriores
  return sim.routes.map((ro) => {
    const total = ro.pedidos.length;
    const listos = ro.pedidos.filter((o) => o.estado === 'preparado' || (o.estado === 'expedido' && o.aTiempo)).length;
    const enCurso = ro.pedidos.filter((o) => o.estado === 'en_curso').length;
    const sinLiberar = ro.pedidos.filter((o) => o.estado === 'pendiente' && o.release > sim.t).length;
    const pendientes = ro.pedidos.filter((o) => o.estado === 'pendiente').length;
    let estado;
    let riesgo = 0;
    if (ro.salio) {
      estado = ro.expedidos === total ? 'salio-ok' : 'salio-tarde';
    } else {
      carga += (pendientes + enCurso * 0.5) * avgMin;
      const cap = capacidad(ro.salida);
      riesgo = cap > 0 ? carga / cap : 9;
      estado = riesgo > 1 ? 'riesgo' : riesgo > 0.75 ? 'justa' : 'ok';
    }
    return { ro, total, listos, enCurso, pendientes, sinLiberar, estado, riesgo };
  });
}

export function diagnose(sim, history) {
  const k = sim.kpis();
  const b = baselineAt(history, sim.t);
  const out = [];
  const hora = fmt(sim.t);

  // 1. Equipos fuera de servicio.
  const inc = sim.incidencias.filter((w) => w.empezo);
  if (inc.length) {
    const minutos = inc.reduce((s, w) => s + Math.max(0, Math.min(sim.t, w.hasta) - w.desde), 0);
    const activas = inc.filter((w) => !w.acabo);
    const desde = Math.min(...inc.map((w) => w.desde));
    const eqHoy = mean(sim.hourly.filter((h) => h.hora >= Math.floor(desde / 60)).map((h) => h.equipos));
    const ids = inc.map((w) => w.f.id).join(', ');
    const vuelta = activas.length ? fmt(Math.max(...activas.map((w) => w.hasta))) : null;
    out.push({
      id: 'taller',
      peso: 3 + minutos / 120,
      titulo: tx(`${inc.length} ${forklifts(inc.length)} en el taller`, `${inc.length} ${forklifts(inc.length)} in the workshop`),
      detalle: tx(
        `${ids} salieron de servicio desde las ${fmt(desde)} (${inc[0].motivo}). Se han perdido unas **${n1(minutos / 60)} horas-equipo**${eqHoy ? `; desde entonces trabajan de media ${n1(eqHoy)} de ${sim.forklifts.length}` : ''}.${activas.length ? ` Siguen fuera ${activas.length}, vuelven hacia las ${vuelta}.` : ' Ya están todas de vuelta.'}`,
        `${ids} went out of service from ${fmt(desde)} (${inc[0].motivo}). About **${n1(minutos / 60)} equipment-hours** have been lost${eqHoy ? `; since then an average of ${n1(eqHoy)} of ${sim.forklifts.length} have been working` : ''}.${activas.length ? ` ${activas.length} still out, back around ${vuelta}.` : ' All of them are back now.'}`,
      ),
      accion: activas.length
        ? tx('Pedir una carretilla de alquiler o de otro turno para las horas que quedan, y retrasar la ubicación de palés no urgentes para que los equipos que quedan se centren en las rutas que salen antes.',
          'Bring in a rental forklift or one from another shift for the remaining hours, and hold back non-urgent put-away so the remaining trucks focus on the routes leaving first.')
        : tx('Recuperar el retraso: priorizar las rutas con pedidos pendientes y vaciar las calles de recepción en cuanto haya margen.',
          'Catch up: prioritise routes with pending orders and clear the receiving lanes as soon as there is slack.'),
    });
  }

  // 2. Utilización de los equipos.
  if (k.utilizacion != null && b?.utilizacion != null && k.utilizacion - b.utilizacion > 0.08) {
    out.push({
      id: 'carga',
      peso: 2 + (k.utilizacion - b.utilizacion) * 10,
      titulo: tx('Equipos al límite', 'Equipment at full stretch'),
      detalle: tx(
        `La utilización de las carretillas es del **${pct(k.utilizacion)}** frente al ${pct(b.utilizacion)} habitual a esta hora. Por encima del 80–85 % cualquier pico se convierte en cola.`,
        `Forklift utilisation is **${pct(k.utilizacion)}** against the usual ${pct(b.utilizacion)} at this time. Above 80–85%, any peak turns into a queue.`,
      ),
      accion: tx('Repartir la carga: adelantar la preparación de las rutas de la tarde en las horas valle y no programar descargas en la franja de más picking.',
        'Spread the load: pick the afternoon routes early during quiet hours and avoid booking deliveries in the busiest picking window.'),
    });
  }

  // 3. Recepción: calles llenas y dock-to-stock.
  const bloq = k.bloqueoCalle;
  const bloqBase = b?.bloqueo ?? 0;
  if ((k.dts != null && b?.dts != null && k.dts > b.dts * 1.6 && k.dts - b.dts > 15) || bloq - bloqBase > 60) {
    const parados = sim.trucks.filter((tr) => tr.bloqueo > 5).length;
    out.push({
      id: 'recepcion',
      peso: 2 + Math.min(4, (bloq - bloqBase) / 150),
      titulo: tx('Recepción atascada', 'Receiving is jammed'),
      detalle: tx(
        `El dock-to-stock medio va en **${num(k.dts)} min** (lo normal a esta hora: ${num(b?.dts)} min). Las calles de recepción se han llenado y los camiones han estado **${num(bloq)} min parados** en muelle sin poder descargar${parados ? ` (${parados} camiones afectados)` : ''}. Ahora mismo hay ${k.calle} palés esperando ubicación.`,
        `Average dock-to-stock is **${num(k.dts)} min** (normal at this time: ${num(b?.dts)} min). The receiving lanes filled up and trucks spent **${num(bloq)} min stopped** at the dock unable to unload${parados ? ` (${parados} trucks affected)` : ''}. Right now ${k.calle} pallets are waiting for put-away.`,
      ),
      accion: tx('Ubicar primero los palés de referencias con pedidos pendientes y habilitar una zona de pulmón junto a los muelles para no parar la descarga.',
        'Put away first the pallets of SKUs with pending orders, and open a buffer area next to the docks so unloading never stops.'),
    });
  }

  // 4. Capacidad de la nave.
  if (k.ocupacion > 0.95 || k.sinHueco > 0) {
    const bajos = sim.L.locations.filter((l) => l.role === 'reserva' && l.units > 0 && l.units < sim.skus[l.sku].upp * 0.3);
    out.push({
      id: 'capacidad',
      peso: 2 + k.sinHueco / 10,
      titulo: tx('Nave sin huecos libres', 'Warehouse out of free locations'),
      detalle: tx(
        `La ocupación es del **${pct(k.ocupacion)}** y ${k.sinHueco ? `**${k.sinHueco} veces** no había hueco para ubicar un palé` : 'casi no quedan huecos libres'}. Hay ${bajos.length} palés de reserva por debajo del 30 % de su capacidad.`,
        `Occupancy is **${pct(k.ocupacion)}** and ${k.sinHueco ? `**${k.sinHueco} times** there was no free location for a pallet` : 'there are hardly any free locations left'}. ${bajos.length} reserve pallets are below 30% of their capacity.`,
      ),
      accion: tx(
        `Consolidar esos ${bajos.length} palés casi vacíos (liberaría hasta ${Math.floor(bajos.length / 2)} huecos) y revisar el stock de baja rotación para sacarlo a un almacén externo.`,
        `Consolidate those ${bajos.length} nearly empty pallets (frees up to ${Math.floor(bajos.length / 2)} locations) and review slow-moving stock to move it to overflow storage.`,
      ),
    });
  }

  // 5. Roturas.
  if (k.fill != null && b?.fill != null && b.fill - k.fill > 0.008) {
    const top = sim.skus.filter((s) => s.cortas > 0).sort((a, c) => c.cortas - a.cortas).slice(0, 3);
    const lista = top.map((s) => `${s.code} (${s.cortas})`).join(', ');
    out.push({
      id: 'stock',
      peso: 1.5 + (b.fill - k.fill) * 100,
      titulo: tx('Líneas servidas incompletas', 'Lines shipped short'),
      detalle: tx(
        `El fill rate de líneas es del **${pct(k.fill)}** (habitual ${pct(b.fill)}). Las referencias con más líneas cortas: ${lista}.${sim.c.cortasEnCalle ? ` En **${sim.c.cortasEnCalle} de ${sim.c.cortas}** líneas cortas había palés de esa referencia en la calle de recepción sin ubicar: el stock estaba en la nave, pero no en su hueco.` : ''}`,
        `Line fill rate is **${pct(k.fill)}** (usually ${pct(b.fill)}). SKUs with the most short lines: ${lista}.${sim.c.cortasEnCalle ? ` In **${sim.c.cortasEnCalle} of ${sim.c.cortas}** short lines there were pallets of that SKU sitting in the receiving lane: the stock was in the building, just not in its location.` : ''}`,
      ),
      accion: sim.c.cortasEnCalle
        ? tx('Dar prioridad de ubicación a los palés de referencias que tienen pedidos pendientes.', 'Give put-away priority to pallets of SKUs with pending orders.')
        : tx('Revisar el punto de pedido de esas referencias con compras.', 'Review the reorder point for those SKUs with purchasing.'),
    });
  }

  return { k, b, hora, hallazgos: out.sort((a, c) => c.peso - a.peso), rutas: routeStatus(sim) };
}

function mean(arr) {
  const v = arr.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ---------------------------------------------------------------------------- respuestas

// Las palabras clave valen en los dos idiomas, sea cual sea el de la interfaz.
const INTENTS = [
  { id: 'red', re: /(almacenes|\bred\b|compar|ranking|peor|mejor|otros|resto|warehouses|network|worst|best|other sites)/ },
  { id: 'acciones', re: /(que hago|que hacemos|recomiend|accion|plan|prioridad|solucion|arregl|mejorar|deberia|what should|what do i do|recommend|action|priorit|fix|improve)/ },
  { id: 'otif', re: /(otif|retras|tarde|a tiempo|puntual|por que|baja|cae|empeor|incumpl|late|on time|why|drop|falling|worse)/ },
  { id: 'rutas', re: /(ruta|salida|expedic|camion de salida|riesgo|llega|sale|route|dispatch|outbound|risk|depart)/ },
  { id: 'recepcion', re: /(muelle|recepcion|descarg|patio|dock|calle|proveedor|camion|entrada|ubicar|receiv|unload|yard|lane|inbound|truck|supplier|put.?away)/ },
  { id: 'equipos', re: /(carretill|equipo|maquina|productiv|utiliz|taller|averi|personal|operari|forklift|equipment|workshop|breakdown|staff)/ },
  { id: 'capacidad', re: /(ocupaci|hueco|capacidad|lleno|espacio|sitio|occupan|capacity|full|space|location)/ },
  { id: 'slotting', re: /(slotting|abc|recorrid|metros|distanc|optimiz|colocar|reubic|picking|travel|metres|meters|relocat)/ },
  { id: 'stock', re: /(stock|rotura|fill|incomplet|corta|falta|agotad|inventario|short|missing|out of stock|inventory)/ },
  { id: 'resumen', re: /(resumen|como va|como vamos|estado|situacion|hoy|turno|kpi|indicador|summary|how is|how are|status|today|shift)/ },
];

export function sugerencias() {
  return tx(
    ['¿Cómo va el turno?', '¿Por qué baja el OTIF hoy?', '¿Qué rutas están en riesgo?', '¿Qué hago ahora mismo?', '¿Cuánto ahorraría con slotting ABC?', 'Compara los tres almacenes', '¿Quién ha creado Estiba?'],
    ['How is the shift going?', 'Why is OTIF dropping today?', 'Which routes are at risk?', 'What should I do right now?', 'How much would ABC slotting save?', 'Compare the three warehouses', 'Who built Estiba?'],
  );
}

// Sin la Lambda (desarrollo local, o si falla) no hay ficha de Ali en el navegador: presentación fija,
// con los mismos datos que la ficha (Proyecto IA/ficha-ali), y su LinkedIn.
const LINKEDIN_ALI = 'https://www.linkedin.com/in/ali-aauicha/';
function sobreAli() {
  return tx(
    `**Estiba** la ha creado **Ali Aauicha Azghouli** como demo de portafolio, con datos simulados. Ali trabajó unos cinco años en operaciones y cadena de suministro (Fluiconnecto, Paack y Grupo Sesé) y desde 2026 es desarrollador Cloud e IA, con tres productos propios en producción sobre AWS: Quillaflow, Mi Campo con IA y ShootingStats.\n\nAhora mismo no puedo consultar su ficha completa para darte más detalle.\n\nMás sobre Ali: ${LINKEDIN_ALI}`,
    `**Estiba** was built by **Ali Aauicha Azghouli** as a portfolio demo with simulated data. Ali spent about five years in operations and supply chain (Fluiconnecto, Paack and Grupo Sesé) and since 2026 has been a Cloud & AI developer with three products of his own in production on AWS: Quillaflow, Mi Campo con IA and ShootingStats.\n\nI can't look up his full profile right now to give you more detail.\n\nMore about Ali: ${LINKEDIN_ALI}`,
  );
}

// sinAcciones: versión para pasar al modelo como respuesta base, sin recomendaciones (las acciones
// le llegan aparte como lista cerrada y no debe reescribirlas).
let SIN_ACCIONES = false;

// historial: el mismo que usan la etiqueta de main.js y la Lambda para decidir si la pregunta es sobre Ali.
export function answerLocal(question, ctx, { sinAcciones = false, historial = [] } = {}) {
  SIN_ACCIONES = sinAcciones;
  try {
    return responder(question, ctx, historial);
  } finally {
    SIN_ACCIONES = false;
  }
}

// Almacén y destinos del turno, con la misma forma que el contexto que recibe la Lambda (ruta.mjs).
export function contextoDeRuta(sim) {
  return { almacen: sim.site.nombre, rutas: sim.routes.map((r) => ({ destino: placeName(r.destino) })) };
}

function responder(question, ctx, historial = []) {
  const q = norm(question);
  const { sim } = ctx;

  // Menciones directas: una ruta o una referencia concreta. Van antes que el hilo de una conversación
  // sobre Ali: «¿Y lo de Huesca?» tras hablar de él es del turno.
  const siteName = norm(sim.site.nombre);
  const ruta = sim.routes.find((r) => {
    const names = [norm(r.destino), norm(placeName(r.destino))];
    return names.some((full) => {
      const first = full.split(' ')[0];
      return q.includes(full) || (first !== siteName && q.includes(first));
    });
  });
  const sobre = !ruta && !/[a-z]{3}-\d{4}/.test(q) && esPreguntaSobreAli(question, historial, contextoDeRuta(sim));
  if (sobre) return sobreAli();
  const d = diagnose(sim, ctx.history);
  if (ruta && !/compar/.test(q)) return rutaDetalle(d, ruta, sim);
  const code = q.match(/[a-z]{3}-\d{4}/);
  if (code) {
    const sku = sim.skus.find((s) => norm(s.code) === code[0]);
    if (sku) return skuDetalle(sku, sim);
  }

  const intent = INTENTS.find((i) => i.re.test(q))?.id;
  switch (intent) {
    case 'red': return red(ctx);
    case 'acciones': return acciones(d);
    case 'otif': return otif(d, sim);
    case 'rutas': return rutas(d);
    case 'recepcion': return recepcion(d, sim);
    case 'equipos': return equipos(d, sim);
    case 'capacidad': return capacidad(d, sim);
    case 'slotting': return slotting(ctx.opt);
    case 'stock': return stock(d, sim);
    case 'resumen': return resumen(d, sim);
    default:
      return tx(
        `Puedo contestarte sobre **${sim.site.nombre}** con los datos del turno: OTIF y retrasos, rutas en riesgo, muelles y recepción, carretillas, ocupación, roturas de stock, slotting y comparación entre almacenes.\n\nPrueba con algo como «¿por qué baja el OTIF?» o «¿qué hago ahora mismo?».`,
        `I can answer questions about **${sim.site.nombre}** using the shift data: OTIF and delays, routes at risk, docks and receiving, forklifts, occupancy, stockouts, slotting and comparisons between warehouses.\n\nTry something like "why is OTIF dropping?" or "what should I do right now?".`,
      );
  }
}

function linea(k, b, campo, nombre, fmtv, mejorAlto = true) {
  const v = k[campo];
  const base = b?.[campo];
  if (v == null) return `- ${nombre}: ${tx('sin datos todavía', 'no data yet')}`;
  let comp = '';
  if (base != null) {
    const diff = v - base;
    const malo = mejorAlto ? diff < 0 : diff > 0;
    const rel = Math.abs(diff) / (Math.abs(base) || 1);
    comp = rel < 0.03
      ? tx(' (en línea con lo habitual)', ' (in line with normal)')
      : ` (${tx('habitual', 'usually')} ${fmtv(base)}${malo && rel > 0.1 ? tx(', **peor**', ', **worse**') : ''})`;
  }
  return `- ${nombre}: **${fmtv(v)}**${comp}`;
}

function resumen(d, sim) {
  const { k, b, hallazgos } = d;
  const partes = [tx(
    `**${sim.site.nombre} · ${d.hora}.** ${k.preparados} pedidos preparados, ${k.pendientes} pendientes y ${k.operativas}/${k.totalCarretillas} carretillas operativas.`,
    `**${sim.site.nombre} · ${d.hora}.** ${k.preparados} orders picked, ${k.pendientes} pending and ${k.operativas}/${k.totalCarretillas} forklifts in service.`,
  )];
  partes.push([
    linea(k, b, 'otif', 'OTIF', (v) => pct(v)),
    linea(k, b, 'fill', tx('Fill rate de líneas', 'Line fill rate'), (v) => pct(v)),
    linea(k, b, 'dts', 'Dock-to-stock', (v) => `${num(v)} min`, false),
    linea(k, b, 'utilizacion', tx('Utilización de equipos', 'Equipment utilisation'), (v) => pct(v), false),
    linea(k, b, 'ocupacion', tx('Ocupación', 'Occupancy'), (v) => pct(v), false),
  ].join('\n'));
  if (hallazgos.length) partes.push(`${tx('Lo más importante ahora', 'Most important right now')}: **${hallazgos[0].titulo.toLowerCase()}**. ${hallazgos[0].detalle}`);
  else partes.push(tx('No veo desviaciones relevantes respecto a los 14 días anteriores.', 'I see no relevant deviations from the previous 14 days.'));
  return partes.join('\n\n');
}

function otif(d, sim) {
  const { k, b, hallazgos, rutas: rs } = d;
  if (k.otif == null) {
    return tx('Todavía no ha salido ninguna ruta, así que no hay OTIF que medir. Te puedo decir qué rutas van justas («¿qué rutas están en riesgo?»).',
      'No route has left yet, so there is no OTIF to measure. I can tell you which routes are tight ("which routes are at risk?").');
  }
  const dOt = pp(k.otif, b?.otif);
  const dAt = pp(k.aTiempo, b?.aTiempo);
  const dFi = pp(k.fill, b?.fill);
  const partes = [tx(
    `El OTIF va en **${pct(k.otif)}**${b?.otif != null ? ` frente al ${pct(b.otif)} habitual a esta hora (${sgn(dOt)})` : ''}.`,
    `OTIF stands at **${pct(k.otif)}**${b?.otif != null ? ` against the usual ${pct(b.otif)} at this time (${sgn(dOt)})` : ''}.`,
  )];
  if (dOt != null && dOt > -1.5) partes.push(tx('Está dentro de lo normal; no hay una caída que explicar.', 'That is within normal range; there is no drop to explain.'));
  const comp = [];
  if (dAt != null) comp.push(tx(`- **A tiempo:** ${pct(k.aTiempo)} (${sgn(dAt)}). ${k.retrasados} pedidos se quedaron en tierra.`, `- **On time:** ${pct(k.aTiempo)} (${sgn(dAt)}). ${k.retrasados} orders were left behind.`));
  if (dFi != null) comp.push(tx(`- **Completos:** fill rate ${pct(k.fill)} (${sgn(dFi)}).`, `- **In full:** fill rate ${pct(k.fill)} (${sgn(dFi)}).`));
  if (comp.length) partes.push(`${tx('Se descompone así', 'Breakdown')}:\n${comp.join('\n')}`);
  const tarde = rs.filter((r) => r.estado === 'salio-tarde');
  if (tarde.length) partes.push(`${tx('Rutas que salieron incompletas', 'Routes that left short')}: ${tarde.map((r) => `${route(r.ro)} (${r.ro.expedidos}/${r.total})`).join(', ')}.`);
  const causas = hallazgos.filter((h) => ['taller', 'carga', 'recepcion', 'stock', 'capacidad'].includes(h.id));
  if (causas.length) {
    partes.push(`**${tx('Por qué', 'Why')}:**\n${causas.map((h) => `- **${h.titulo}.** ${h.detalle}`).join('\n')}`);
    if (causas.some((h) => h.id === 'taller') && causas.some((h) => h.id === 'recepcion')) {
      partes.push(tx('La cadena es esta: con menos carretillas, el picking urgente se come la capacidad, los palés se acumulan en las calles de recepción, los camiones no pueden descargar y el stock tarda en llegar a su hueco.',
        'The chain is this: with fewer forklifts, urgent picking eats the capacity, pallets pile up in the receiving lanes, trucks cannot unload and stock takes longer to reach its location.'));
    }
  }
  return partes.join('\n\n');
}

function rutas(d) {
  const pend = d.rutas.filter((r) => !r.ro.salio);
  if (!pend.length) return tx('Ya han salido todas las rutas del día.', 'All of today\'s routes have already left.');
  const filas = pend.map((r) => {
    const tag = r.estado === 'riesgo' ? tx('**en riesgo**', '**at risk**') : r.estado === 'justa' ? tx('justa', 'tight') : tx('bien', 'fine');
    return tx(
      `- ${route(r.ro)} (${fmt(r.ro.salida)}, ${r.ro.dock.id}): ${r.listos}/${r.total} listos, ${r.enCurso} en preparación${r.sinLiberar ? `, ${r.sinLiberar} aún sin liberar` : ''} → ${tag}`,
      `- ${route(r.ro)} (${fmt(r.ro.salida)}, ${r.ro.dock.id}): ${r.listos}/${r.total} ready, ${r.enCurso} being picked${r.sinLiberar ? `, ${r.sinLiberar} not released yet` : ''} → ${tag}`,
    );
  });
  const riesgo = pend.filter((r) => r.estado === 'riesgo');
  const n = riesgo.length;
  const cab = n
    ? tx(
      `Hay **${n} ${n > 1 ? 'rutas' : 'ruta'} en riesgo** con la capacidad prevista (${d.k.operativas} carretillas operativas ahora${d.k.operativas < d.k.totalCarretillas ? ', contando con las que vuelven del taller' : ''}).`,
      `**${n} ${n > 1 ? 'routes are' : 'route is'} at risk** with the expected capacity (${d.k.operativas} forklifts in service now${d.k.operativas < d.k.totalCarretillas ? ', counting those coming back from the workshop' : ''}).`,
    )
    : tx('Con la capacidad actual todas las rutas pendientes llegan a tiempo.', 'With current capacity, every pending route makes it on time.');
  const nota = tx(
    'El cálculo suma el trabajo pendiente de cada ruta y de las que salen antes, y lo compara con los minutos de carretilla disponibles hasta su salida (descontando taller y un 20 % para recepción).',
    'The calculation adds up the pending work for each route and the ones leaving before it, and compares it with the forklift minutes available until departure (minus the workshop and 20% for receiving).',
  );
  return `${cab}\n\n${filas.join('\n')}\n\n${nota}`;
}

function recepcion(d, sim) {
  const { k, b } = d;
  const esperando = sim.yard.length;
  const enMuelle = sim.L.inDocks.filter((x) => x.truck).length;
  const partes = [
    tx(
      `**Recepción en ${sim.site.nombre}:** ${k.palesRecibidos} palés descargados y ${k.palesUbicados} ubicados. Dock-to-stock medio: **${num(k.dts)} min**${b?.dts != null ? ` (habitual ${num(b.dts)} min)` : ''}.`,
      `**Receiving at ${sim.site.nombre}:** ${k.palesRecibidos} pallets unloaded and ${k.palesUbicados} put away. Average dock-to-stock: **${num(k.dts)} min**${b?.dts != null ? ` (usually ${num(b.dts)} min)` : ''}.`,
    ),
    tx(
      `Ahora: ${enMuelle} camiones en muelle, ${esperando} en el patio y ${k.calle} palés en las calles esperando carretilla. Minutos de descarga parada por calle llena: **${num(k.bloqueoCalle)}**${b?.bloqueo != null ? ` (habitual ${num(b.bloqueo)})` : ''}.`,
      `Now: ${enMuelle} trucks at the docks, ${esperando} in the yard and ${k.calle} pallets in the lanes waiting for a forklift. Minutes of unloading stopped by a full lane: **${num(k.bloqueoCalle)}**${b?.bloqueo != null ? ` (usually ${num(b.bloqueo)})` : ''}.`,
    ),
  ];
  const h = d.hallazgos.find((x) => x.id === 'recepcion' || x.id === 'capacidad');
  if (h) partes.push(`**${h.titulo}.** ${SIN_ACCIONES ? h.detalle : h.accion}`);
  return partes.join('\n\n');
}

export function forkliftState(f) {
  if (f.enTaller) return tx('en taller', 'in the workshop');
  const t = f.task?.tipo;
  if (t === 'taller') return tx('yendo al taller', 'heading to the workshop');
  if (t === 'picking') return tx('preparando pedido', 'picking an order');
  if (t === 'ubicacion') return tx('ubicando palé', 'putting away a pallet');
  return tx('libre', 'idle');
}

function equipos(d, sim) {
  const filas = sim.forklifts.map((f) => {
    const u = f.disponible > 0 ? f.ocupado / f.disponible : null;
    return tx(
      `- ${f.id}: ${forkliftState(f)} · ${f.lineas} líneas, ${f.pales} palés · utilización ${pct(u, 0)}`,
      `- ${f.id}: ${forkliftState(f)} · ${f.lineas} lines, ${f.pales} pallets · utilisation ${pct(u, 0)}`,
    );
  });
  const { k, b } = d;
  const partes = [tx(
    `**${k.operativas} de ${k.totalCarretillas} carretillas operativas.** Utilización media ${pct(k.utilizacion)}${b?.utilizacion != null ? ` (habitual ${pct(b.utilizacion)})` : ''}; productividad ${num(k.productividad)} líneas por hora y equipo.`,
    `**${k.operativas} of ${k.totalCarretillas} forklifts in service.** Average utilisation ${pct(k.utilizacion)}${b?.utilizacion != null ? ` (usually ${pct(b.utilizacion)})` : ''}; productivity ${num(k.productividad)} lines per hour per truck.`,
  ), filas.join('\n')];
  const h = d.hallazgos.find((x) => x.id === 'taller' || x.id === 'carga');
  if (h) partes.push(SIN_ACCIONES ? h.detalle : `${h.detalle}\n\n**${tx('Qué haría', 'What I would do')}:** ${h.accion}`);
  return partes.join('\n\n');
}

function capacidad(d, sim) {
  const { k } = d;
  const libres = sim.freeLocations();
  const h = d.hallazgos.find((x) => x.id === 'capacidad');
  return [
    tx(`La nave tiene ${sim.L.locations.length} huecos: **${libres} libres** (ocupación ${pct(k.ocupacion)}).`,
      `The warehouse has ${sim.L.locations.length} locations: **${libres} free** (occupancy ${pct(k.ocupacion)}).`),
    h ? (SIN_ACCIONES ? h.detalle : `${h.detalle}\n\n**${tx('Qué haría', 'What I would do')}:** ${h.accion}`)
      : tx('Hay margen suficiente para la recepción prevista de hoy.', 'There is enough room for today\'s expected deliveries.'),
  ].join('\n\n');
}

function stock(d, sim) {
  const { k } = d;
  const top = sim.skus.filter((s) => s.cortas > 0).sort((a, b) => b.cortas - a.cortas).slice(0, 5);
  const partes = [tx(`Fill rate de líneas: **${pct(k.fill)}**. ${sim.c.cortas} líneas servidas incompletas hoy.`,
    `Line fill rate: **${pct(k.fill)}**. ${sim.c.cortas} lines shipped short today.`)];
  if (top.length) {
    partes.push(`${tx('Referencias con más líneas cortas', 'SKUs with the most short lines')}:\n${top.map((s) => `- ${s.code} · ${s.nombre} (${tx('clase', 'class')} ${s.cls}): ${s.cortas}`).join('\n')}`);
  }
  if (sim.c.cortasEnCalle) {
    partes.push(tx(`En **${sim.c.cortasEnCalle}** de esas líneas el producto estaba en la calle de recepción, sin ubicar. Es un problema de flujo interno, no de compras.`,
      `In **${sim.c.cortasEnCalle}** of those lines the product was sitting in the receiving lane, not yet put away. That is an internal flow problem, not a purchasing one.`));
  }
  return partes.join('\n\n');
}

function slotting(opt) {
  if (!opt) return tx('Estoy calculando el análisis de slotting; pregúntame en unos segundos.', 'I am still computing the slotting analysis; ask me again in a few seconds.');
  const [a, r, abc] = opt.escenarios;
  return tx([
    `Con los **${opt.pedidos} pedidos de hoy**, cada pedido cuesta de media ${n1(a.minutosPedido)} min y ${num(a.metrosPedido)} m de recorrido tal como está la nave.`,
    `- Solo ordenando la ruta: ${n1(r.minutosPedido)} min (−${pct(r.ahorro)}).`,
    `- Con slotting ABC + ruta: **${n1(abc.minutosPedido)} min (−${pct(abc.ahorro)})**, ${num(abc.metrosPedido)} m por pedido.`,
    `Son **${n1(opt.horasAhorro)} horas-equipo al día**, unas ${n1(opt.equipos)} carretillas de un turno de 8 h. Ahora mismo ${opt.aFuera} de ${opt.aTotal} referencias A están fuera de la zona dorada. Implantarlo supone ${opt.cambios} cambios de ubicación; los de más impacto están en la pestaña Optimización.`,
  ].join('\n'), [
    `With **today's ${opt.pedidos} orders**, each order takes on average ${n1(a.minutosPedido)} min and ${num(a.metrosPedido)} m of travel with the current layout.`,
    `- Just sequencing the route: ${n1(r.minutosPedido)} min (−${pct(r.ahorro)}).`,
    `- With ABC slotting + routing: **${n1(abc.minutosPedido)} min (−${pct(abc.ahorro)})**, ${num(abc.metrosPedido)} m per order.`,
    `That is **${n1(opt.horasAhorro)} equipment-hours a day**, about ${n1(opt.equipos)} forklifts on an 8-hour shift. Right now ${opt.aFuera} of ${opt.aTotal} A SKUs are outside the golden zone. Implementing it means ${opt.cambios} relocations; the highest-impact ones are in the Optimisation tab.`,
  ].join('\n'));
}

// Lista cerrada de acciones que salen del diagnóstico. Es lo único que el asistente puede
// recomendar: la respuesta local las usa tal cual y el modelo solo puede elegir entre ellas.
export function accionesDisponibles(d) {
  const riesgo = d.rutas.filter((r) => r.estado === 'riesgo');
  const out = [];
  if (riesgo.length) {
    const lista = riesgo.map((r) => `${route(r.ro)} (${fmt(r.ro.salida)})`).join(', ');
    out.push({
      id: 'rutas',
      titulo: tx('Rutas', 'Routes'),
      texto: tx(`Concentrar equipos en ${lista}; avisar al cliente si no da tiempo, antes de la hora de salida.`,
        `Focus equipment on ${lista}; warn the customer before departure time if it will not make it.`),
    });
  }
  for (const h of d.hallazgos) out.push({ id: h.id, titulo: h.titulo, texto: h.accion });
  return out;
}

function acciones(d) {
  if (SIN_ACCIONES) {
    if (!d.hallazgos.length) return tx('Ahora mismo no hay nada urgente: el turno va en línea con lo habitual.', 'Nothing urgent right now: the shift is in line with normal.');
    return `${tx('Situación', 'Situation')}:\n${d.hallazgos.map((h) => `- **${h.titulo}.** ${h.detalle}`).join('\n')}`;
  }
  const items = accionesDisponibles(d).map((a) => `**${a.titulo}:** ${a.texto}`);
  if (!items.length) {
    return tx('Ahora mismo no hay nada urgente: el turno va en línea con lo habitual. Buen momento para adelantar la preparación de las rutas de la tarde o para hacer recuentos cíclicos.',
      'Nothing urgent right now: the shift is in line with normal. A good moment to pick the afternoon routes early or run cycle counts.');
  }
  return `${tx('Por orden de impacto', 'In order of impact')}:\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
}

function rutaDetalle(d, ro, sim) {
  const r = d.rutas.find((x) => x.ro === ro);
  const late = ro.pedidos.filter((o) => o.retrasado);
  const cortas = ro.pedidos.filter((o) => o.cortas > 0);
  const partes = [tx(`**Ruta ${route(ro)}** · salida ${fmt(ro.salida)} por ${ro.dock.id} · ${r.total} pedidos.`,
    `**${route(ro)} route** · leaves ${fmt(ro.salida)} from ${ro.dock.id} · ${r.total} orders.`)];
  if (ro.salio) {
    partes.push(tx(
      `Salió con **${ro.expedidos}/${r.total}** pedidos.${late.length ? ` Se quedaron ${late.length} (preparados tarde)${late[0].equipo ? `; el primero lo estaba preparando ${late[0].equipo}` : ''}.` : ''}${cortas.length ? ` ${cortas.length} pedidos llevaban alguna línea incompleta.` : ''}`,
      `It left with **${ro.expedidos}/${r.total}** orders.${late.length ? ` ${late.length} were left behind (picked late)${late[0].equipo ? `; the first one was being picked by ${late[0].equipo}` : ''}.` : ''}${cortas.length ? ` ${cortas.length} orders had at least one short line.` : ''}`,
    ));
  } else {
    const est = r.estado === 'riesgo' ? tx('en riesgo', 'at risk') : r.estado === 'justa' ? tx('justa', 'tight') : tx('a tiempo', 'on time');
    partes.push(tx(
      `Lleva ${r.listos} listos, ${r.enCurso} en preparación y ${r.pendientes} pendientes${r.sinLiberar ? ` (${r.sinLiberar} aún no liberados)` : ''}. Estado: **${est}**; quedan ${num(ro.salida - sim.t)} min.`,
      `${r.listos} ready, ${r.enCurso} being picked and ${r.pendientes} pending${r.sinLiberar ? ` (${r.sinLiberar} not released yet)` : ''}. Status: **${est}**; ${num(ro.salida - sim.t)} min to go.`,
    ));
  }
  return partes.join('\n\n');
}

function skuDetalle(sku, sim) {
  const locs = [...sku.locs].map((i) => sim.L.locations[i]).filter((l) => l.units > 0);
  const total = locs.reduce((s, l) => s + l.units, 0);
  const face = sim.L.locations[sku.face];
  return tx([
    `**${sku.code}** · ${sku.nombre} · clase ${sku.cls}.`,
    `Stock: ${num(total)} cajas en ${locs.length} huecos; picking en ${face.id} (nivel ${face.level + 1}, ${num(face.units)} cajas). Demanda prevista ${num(sku.demanda)} cajas/día.`,
    `Hoy: ${sku.lineas} líneas, ${sku.cortas} incompletas.`,
  ], [
    `**${sku.code}** · ${sku.nombre} · class ${sku.cls}.`,
    `Stock: ${num(total)} cases in ${locs.length} locations; pick face ${face.id} (level ${face.level + 1}, ${num(face.units)} cases). Forecast demand ${num(sku.demanda)} cases/day.`,
    `Today: ${sku.lineas} lines, ${sku.cortas} short.`,
  ]).join('\n\n');
}

function red(ctx) {
  const rows = ctx.network?.();
  if (!rows?.length) return tx('No tengo todavía los datos del resto de almacenes.', 'I do not have the other warehouses\' data yet.');
  const filas = rows.map((r) => tx(
    `- **${r.site.nombre}**: OTIF ${pct(r.k.otif)}, fill ${pct(r.k.fill)}, dock-to-stock ${num(r.k.dts)} min, ocupación ${pct(r.k.ocupacion)}, ${r.k.operativas}/${r.k.totalCarretillas} carretillas${r.top ? ` · ${r.top.titulo.toLowerCase()}` : ''}`,
    `- **${r.site.nombre}**: OTIF ${pct(r.k.otif)}, fill ${pct(r.k.fill)}, dock-to-stock ${num(r.k.dts)} min, occupancy ${pct(r.k.ocupacion)}, ${r.k.operativas}/${r.k.totalCarretillas} forklifts${r.top ? ` · ${r.top.titulo.toLowerCase()}` : ''}`,
  ));
  const peor = rows.slice().sort((a, b) => (a.k.otif ?? 1) - (b.k.otif ?? 1))[0];
  return [
    tx(`Comparación a las ${fmt(rows[0].k.t)} (mismo momento del turno en los tres):`, `Comparison at ${fmt(rows[0].k.t)} (same point in the shift for all three):`),
    filas.join('\n'),
    peor.top ? tx(`El que más preocupa es **${peor.site.nombre}**: ${peor.top.detalle}`, `The most worrying is **${peor.site.nombre}**: ${peor.top.detalle}`) : '',
  ].filter(Boolean).join('\n\n');
}
