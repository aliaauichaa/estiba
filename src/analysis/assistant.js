// Asistente de operaciones. Responde con datos de la simulación: compara hoy con la media de los
// 14 días anteriores a la misma hora, busca la causa en la cadena (equipos → calles → stock → rutas)
// y propone acciones. Funciona sin servidor; si hay API configurada, un modelo redacta la respuesta
// a partir de este mismo diagnóstico (ver src/analysis/remote.js).

import { baselineAt } from './history.js';
import { fmt } from '../sim/engine.js';

const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
export const pct = (v, d = 1) => (v == null ? '—' : `${d ? nf1.format(v * 100) : nf0.format(v * 100)} %`);
export const num = (v) => (v == null ? '—' : nf0.format(v));
const pp = (a, b) => (a == null || b == null ? null : (a - b) * 100);
const sgn = (v, unit = ' p. p.') => (v == null ? '' : `${v > 0 ? '+' : '−'}${nf1.format(Math.abs(v))}${unit}`);
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

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
    out.push({
      id: 'taller',
      peso: 3 + minutos / 120,
      titulo: `${inc.length} carretilla${inc.length > 1 ? 's' : ''} en el taller`,
      detalle: `${inc.map((w) => w.f.id).join(', ')} salieron de servicio desde las ${fmt(desde)} (${inc[0].motivo}). Se han perdido unas **${nf1.format(minutos / 60)} horas-equipo**${eqHoy ? `; desde entonces trabajan de media ${nf1.format(eqHoy)} de ${sim.forklifts.length}` : ''}.${activas.length ? ` Siguen fuera ${activas.length}, vuelven hacia las ${fmt(Math.max(...activas.map((w) => w.hasta)))}.` : ' Ya están todas de vuelta.'}`,
      accion: activas.length
        ? 'Pedir una carretilla de alquiler o de otro turno para las horas que quedan, y retrasar la ubicación de palés no urgentes para que los equipos que quedan se centren en las rutas que salen antes.'
        : 'Recuperar el retraso: priorizar las rutas con pedidos pendientes y vaciar las calles de recepción en cuanto haya margen.',
    });
  }

  // 2. Utilización de los equipos.
  if (k.utilizacion != null && b?.utilizacion != null && k.utilizacion - b.utilizacion > 0.08) {
    out.push({
      id: 'carga',
      peso: 2 + (k.utilizacion - b.utilizacion) * 10,
      titulo: 'Equipos al límite',
      detalle: `La utilización de las carretillas es del **${pct(k.utilizacion)}** frente al ${pct(b.utilizacion)} habitual a esta hora. Por encima del 80–85 % cualquier pico se convierte en cola.`,
      accion: 'Repartir la carga: adelantar la preparación de las rutas de la tarde en las horas valle y no programar descargas en la franja de más picking.',
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
      titulo: 'Recepción atascada',
      detalle: `El dock-to-stock medio va en **${num(k.dts)} min** (lo normal a esta hora: ${num(b?.dts)} min). Las calles de recepción se han llenado y los camiones han estado **${num(bloq)} min parados** en muelle sin poder descargar${parados ? ` (${parados} camiones afectados)` : ''}. Ahora mismo hay ${k.calle} palés esperando ubicación.`,
      accion: 'Ubicar primero los palés de referencias con pedidos pendientes y habilitar una zona de pulmón junto a los muelles para no parar la descarga.',
    });
  }

  // 4. Capacidad de la nave.
  if (k.ocupacion > 0.95 || k.sinHueco > 0) {
    const bajos = sim.L.locations.filter((l) => l.role === 'reserva' && l.units > 0 && l.units < sim.skus[l.sku].upp * 0.3);
    out.push({
      id: 'capacidad',
      peso: 2 + k.sinHueco / 10,
      titulo: 'Nave sin huecos libres',
      detalle: `La ocupación es del **${pct(k.ocupacion)}** y ${k.sinHueco ? `**${k.sinHueco} veces** no había hueco para ubicar un palé` : 'casi no quedan huecos libres'}. Hay ${bajos.length} palés de reserva por debajo del 30 % de su capacidad.`,
      accion: `Consolidar esos ${bajos.length} palés casi vacíos (liberaría hasta ${Math.floor(bajos.length / 2)} huecos) y revisar el stock de baja rotación para sacarlo a un almacén externo.`,
    });
  }

  // 5. Roturas.
  if (k.fill != null && b?.fill != null && b.fill - k.fill > 0.008) {
    const top = sim.skus.filter((s) => s.cortas > 0).sort((a, c) => c.cortas - a.cortas).slice(0, 3);
    out.push({
      id: 'stock',
      peso: 1.5 + (b.fill - k.fill) * 100,
      titulo: 'Líneas servidas incompletas',
      detalle: `El fill rate de líneas es del **${pct(k.fill)}** (habitual ${pct(b.fill)}). Las referencias con más líneas cortas: ${top.map((s) => `${s.code} (${s.cortas})`).join(', ')}.${sim.c.cortasEnCalle ? ` En **${sim.c.cortasEnCalle} de ${sim.c.cortas}** líneas cortas había palés de esa referencia en la calle de recepción sin ubicar: el stock estaba en la nave, pero no en su hueco.` : ''}`,
      accion: sim.c.cortasEnCalle ? 'Dar prioridad de ubicación a los palés de referencias que tienen pedidos pendientes.' : 'Revisar el punto de pedido de esas referencias con compras.',
    });
  }

  // 6. Slotting (siempre se calcula; pesa poco si la nave va bien).
  return { k, b, hora, hallazgos: out.sort((a, c) => c.peso - a.peso), rutas: routeStatus(sim) };
}

function mean(arr) {
  const v = arr.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ---------------------------------------------------------------------------- respuestas

const INTENTS = [
  { id: 'red', re: /(almacenes|\bred\b|compar|ranking|peor|mejor|otros|resto)/ },
  { id: 'acciones', re: /(que hago|que hacemos|recomiend|accion|plan|prioridad|solucion|arregl|mejorar|deberia)/ },
  { id: 'otif', re: /(otif|retras|tarde|a tiempo|puntual|por que|baja|cae|empeor|incumpl)/ },
  { id: 'rutas', re: /(ruta|salida|expedic|camion de salida|riesgo|llega|sale)/ },
  { id: 'recepcion', re: /(muelle|recepcion|descarg|patio|dock|calle|proveedor|camion|entrada|ubicar|ubicacion de pales)/ },
  { id: 'equipos', re: /(carretill|equipo|maquina|productiv|utiliz|taller|averi|personal|operari)/ },
  { id: 'capacidad', re: /(ocupaci|hueco|capacidad|lleno|espacio|sitio)/ },
  { id: 'slotting', re: /(slotting|abc|recorrid|metros|distanc|optimiz|colocar|reubic|picking)/ },
  { id: 'stock', re: /(stock|rotura|fill|incomplet|corta|falta|agotad|inventario)/ },
  { id: 'resumen', re: /(resumen|como va|como vamos|estado|situacion|hoy|turno|kpi|indicador)/ },
];

export const SUGERENCIAS = [
  '¿Cómo va el turno?',
  '¿Por qué baja el OTIF hoy?',
  '¿Qué rutas están en riesgo?',
  '¿Qué hago ahora mismo?',
  '¿Cuánto ahorraría con slotting ABC?',
  'Compara los tres almacenes',
];

export function answerLocal(question, ctx) {
  const q = norm(question);
  const { sim } = ctx;
  const d = diagnose(sim, ctx.history);

  // Menciones directas: una ruta o una referencia concreta.
  const siteName = norm(sim.site.nombre);
  const ruta = sim.routes.find((r) => {
    const full = norm(r.destino);
    const first = full.split(' ')[0];
    return q.includes(full) || (first !== siteName && q.includes(first));
  });
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
      return [
        `Puedo contestarte sobre **${sim.site.nombre}** con los datos del turno: OTIF y retrasos, rutas en riesgo, muelles y recepción, carretillas, ocupación, roturas de stock, slotting y comparación entre almacenes.`,
        'Prueba con algo como «¿por qué baja el OTIF?» o «¿qué hago ahora mismo?».',
      ].join('\n\n');
  }
}

function linea(k, b, campo, nombre, fmtv, mejorAlto = true) {
  const v = k[campo];
  const base = b?.[campo];
  if (v == null) return `- ${nombre}: sin datos todavía`;
  let comp = '';
  if (base != null) {
    const diff = v - base;
    const malo = mejorAlto ? diff < 0 : diff > 0;
    const rel = Math.abs(diff) / (Math.abs(base) || 1);
    comp = rel < 0.03 ? ' (en línea con lo habitual)' : ` (habitual ${fmtv(base)}${malo && rel > 0.1 ? ', **peor**' : ''})`;
  }
  return `- ${nombre}: **${fmtv(v)}**${comp}`;
}

function resumen(d, sim) {
  const { k, b, hallazgos } = d;
  const partes = [`**${sim.site.nombre} · ${d.hora}.** ${k.preparados} pedidos preparados, ${k.pendientes} pendientes y ${k.operativas}/${k.totalCarretillas} carretillas operativas.`];
  partes.push([
    linea(k, b, 'otif', 'OTIF', (v) => pct(v)),
    linea(k, b, 'fill', 'Fill rate de líneas', (v) => pct(v)),
    linea(k, b, 'dts', 'Dock-to-stock', (v) => `${num(v)} min`, false),
    linea(k, b, 'utilizacion', 'Utilización de equipos', (v) => pct(v), false),
    linea(k, b, 'ocupacion', 'Ocupación', (v) => pct(v), false),
  ].join('\n'));
  if (hallazgos.length) partes.push(`Lo más importante ahora: **${hallazgos[0].titulo.toLowerCase()}**. ${hallazgos[0].detalle}`);
  else partes.push('No veo desviaciones relevantes respecto a los 14 días anteriores.');
  return partes.join('\n\n');
}

function otif(d, sim) {
  const { k, b, hallazgos, rutas } = d;
  if (k.otif == null) return 'Todavía no ha salido ninguna ruta, así que no hay OTIF que medir. Te puedo decir qué rutas van justas («¿qué rutas están en riesgo?»).';
  const dOt = pp(k.otif, b?.otif);
  const dAt = pp(k.aTiempo, b?.aTiempo);
  const dFi = pp(k.fill, b?.fill);
  const partes = [`El OTIF va en **${pct(k.otif)}**${b?.otif != null ? ` frente al ${pct(b.otif)} habitual a esta hora (${sgn(dOt)})` : ''}.`];
  if (dOt != null && dOt > -1.5) partes.push('Está dentro de lo normal; no hay una caída que explicar.');
  const comp = [];
  if (dAt != null) comp.push(`- **A tiempo:** ${pct(k.aTiempo)} (${sgn(dAt)}). ${k.retrasados} pedidos se quedaron en tierra.`);
  if (dFi != null) comp.push(`- **Completos:** fill rate ${pct(k.fill)} (${sgn(dFi)}).`);
  if (comp.length) partes.push(`Se descompone así:\n${comp.join('\n')}`);
  const tarde = rutas.filter((r) => r.estado === 'salio-tarde');
  if (tarde.length) partes.push(`Rutas que salieron incompletas: ${tarde.map((r) => `${r.ro.destino} (${r.ro.expedidos}/${r.total})`).join(', ')}.`);
  const causas = hallazgos.filter((h) => ['taller', 'carga', 'recepcion', 'stock', 'capacidad'].includes(h.id));
  if (causas.length) {
    partes.push(`**Por qué:**\n${causas.map((h) => `- **${h.titulo}.** ${h.detalle}`).join('\n')}`);
    if (causas.some((h) => h.id === 'taller') && causas.some((h) => h.id === 'recepcion')) {
      partes.push('La cadena es esta: con menos carretillas, el picking urgente se come la capacidad, los palés se acumulan en las calles de recepción, los camiones no pueden descargar y el stock tarda en llegar a su hueco.');
    }
  }
  return partes.join('\n\n');
}

function rutas(d) {
  const pend = d.rutas.filter((r) => !r.ro.salio);
  if (!pend.length) return 'Ya han salido todas las rutas del día.';
  const filas = pend.map((r) => {
    const tag = r.estado === 'riesgo' ? '**en riesgo**' : r.estado === 'justa' ? 'justa' : 'bien';
    return `- ${r.ro.destino} (${fmt(r.ro.salida)}, ${r.ro.dock.id}): ${r.listos}/${r.total} listos, ${r.enCurso} en preparación${r.sinLiberar ? `, ${r.sinLiberar} aún sin liberar` : ''} → ${tag}`;
  });
  const riesgo = pend.filter((r) => r.estado === 'riesgo');
  const cab = riesgo.length
    ? `Hay **${riesgo.length} ruta${riesgo.length > 1 ? 's' : ''} en riesgo** con la capacidad prevista (${d.k.operativas} carretillas operativas ahora${d.k.operativas < d.k.totalCarretillas ? ', contando con las que vuelven del taller' : ''}).`
    : 'Con la capacidad actual todas las rutas pendientes llegan a tiempo.';
  return `${cab}\n\n${filas.join('\n')}\n\nEl cálculo suma el trabajo pendiente de cada ruta y de las que salen antes, y lo compara con los minutos de carretilla disponibles hasta su salida (descontando taller y un 20 % para recepción).`;
}

function recepcion(d, sim) {
  const { k, b } = d;
  const esperando = sim.yard.length;
  const enMuelle = sim.L.inDocks.filter((x) => x.truck);
  const partes = [
    `**Recepción en ${sim.site.nombre}:** ${k.palesRecibidos} palés descargados y ${k.palesUbicados} ubicados. Dock-to-stock medio: **${num(k.dts)} min**${b?.dts != null ? ` (habitual ${num(b.dts)} min)` : ''}.`,
    `Ahora: ${enMuelle.length} camiones en muelle, ${esperando} en el patio y ${k.calle} palés en las calles esperando carretilla. Minutos de descarga parada por calle llena: **${num(k.bloqueoCalle)}**${b?.bloqueo != null ? ` (habitual ${num(b.bloqueo)})` : ''}.`,
  ];
  const h = d.hallazgos.find((x) => x.id === 'recepcion' || x.id === 'capacidad');
  if (h) partes.push(`**${h.titulo}.** ${h.accion}`);
  return partes.join('\n\n');
}

function equipos(d, sim) {
  const filas = sim.forklifts.map((f) => {
    const est = f.enTaller ? 'en taller' : f.task?.tipo === 'taller' ? 'yendo al taller' : f.task?.tipo === 'picking' ? 'preparando pedido' : f.task?.tipo === 'ubicacion' ? 'ubicando palé' : 'libre';
    const u = f.disponible > 0 ? f.ocupado / f.disponible : null;
    return `- ${f.id}: ${est} · ${f.lineas} líneas, ${f.pales} palés · utilización ${pct(u, 0)}`;
  });
  const { k, b } = d;
  const partes = [`**${k.operativas} de ${k.totalCarretillas} carretillas operativas.** Utilización media ${pct(k.utilizacion)}${b?.utilizacion != null ? ` (habitual ${pct(b.utilizacion)})` : ''}; productividad ${num(k.productividad)} líneas por hora y equipo.`, filas.join('\n')];
  const h = d.hallazgos.find((x) => x.id === 'taller' || x.id === 'carga');
  if (h) partes.push(`${h.detalle}\n\n**Qué haría:** ${h.accion}`);
  return partes.join('\n\n');
}

function capacidad(d, sim) {
  const { k } = d;
  const libres = sim.freeLocations();
  const h = d.hallazgos.find((x) => x.id === 'capacidad');
  return [
    `La nave tiene ${sim.L.locations.length} huecos: **${libres} libres** (ocupación ${pct(k.ocupacion)}).`,
    h ? `${h.detalle}\n\n**Qué haría:** ${h.accion}` : 'Hay margen suficiente para la recepción prevista de hoy.',
  ].join('\n\n');
}

function stock(d, sim) {
  const { k } = d;
  const top = sim.skus.filter((s) => s.cortas > 0).sort((a, b) => b.cortas - a.cortas).slice(0, 5);
  const partes = [`Fill rate de líneas: **${pct(k.fill)}**. ${sim.c.cortas} líneas servidas incompletas hoy.`];
  if (top.length) partes.push(`Referencias con más líneas cortas:\n${top.map((s) => `- ${s.code} · ${s.nombre} (clase ${s.cls}): ${s.cortas}`).join('\n')}`);
  if (sim.c.cortasEnCalle) partes.push(`En **${sim.c.cortasEnCalle}** de esas líneas el producto estaba en la calle de recepción, sin ubicar. Es un problema de flujo interno, no de compras.`);
  return partes.join('\n\n');
}

function slotting(opt) {
  if (!opt) return 'Estoy calculando el análisis de slotting; pregúntame en unos segundos.';
  const [a, r, abc] = opt.escenarios;
  return [
    `Con los **${opt.pedidos} pedidos de hoy**, cada pedido cuesta de media ${nf1.format(a.minutosPedido)} min y ${num(a.metrosPedido)} m de recorrido tal como está la nave.`,
    `- Solo ordenando la ruta: ${nf1.format(r.minutosPedido)} min (−${pct(r.ahorro)}).`,
    `- Con slotting ABC + ruta: **${nf1.format(abc.minutosPedido)} min (−${pct(abc.ahorro)})**, ${num(abc.metrosPedido)} m por pedido.`,
    `Son **${nf1.format(opt.horasAhorro)} horas-equipo al día**, unas ${nf1.format(opt.equipos)} carretillas de un turno de 8 h. Ahora mismo ${opt.aFuera} de ${opt.aTotal} referencias A están fuera de la zona dorada. Implantarlo supone ${opt.cambios} cambios de ubicación; los de más impacto están en la pestaña Optimización.`,
  ].join('\n');
}

function acciones(d) {
  const { hallazgos, rutas: rs } = d;
  const riesgo = rs.filter((r) => r.estado === 'riesgo');
  const items = [];
  if (riesgo.length) items.push(`**Rutas:** concentrar equipos en ${riesgo.map((r) => `${r.ro.destino} (${fmt(r.ro.salida)})`).join(', ')}; avisar al cliente si no da tiempo, antes de la hora de salida.`);
  for (const h of hallazgos) items.push(`**${h.titulo}:** ${h.accion}`);
  if (!items.length) return 'Ahora mismo no hay nada urgente: el turno va en línea con lo habitual. Buen momento para adelantar la preparación de las rutas de la tarde o para hacer recuentos cíclicos.';
  return `Por orden de impacto:\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
}

function rutaDetalle(d, ro, sim) {
  const r = d.rutas.find((x) => x.ro === ro);
  const late = ro.pedidos.filter((o) => o.retrasado);
  const cortas = ro.pedidos.filter((o) => o.cortas > 0);
  const partes = [`**Ruta ${ro.destino}** · salida ${fmt(ro.salida)} por ${ro.dock.id} · ${r.total} pedidos.`];
  if (ro.salio) {
    partes.push(`Salió con **${ro.expedidos}/${r.total}** pedidos.${late.length ? ` Se quedaron ${late.length} (preparados tarde)${late[0].equipo ? `; el primero lo estaba preparando ${late[0].equipo}` : ''}.` : ''}${cortas.length ? ` ${cortas.length} pedidos llevaban alguna línea incompleta.` : ''}`);
  } else {
    partes.push(`Lleva ${r.listos} listos, ${r.enCurso} en preparación y ${r.pendientes} pendientes${r.sinLiberar ? ` (${r.sinLiberar} aún no liberados)` : ''}. Estado: **${r.estado === 'riesgo' ? 'en riesgo' : r.estado === 'justa' ? 'justa' : 'a tiempo'}**; quedan ${num(ro.salida - sim.t)} min.`);
  }
  return partes.join('\n\n');
}

function skuDetalle(sku, sim) {
  const locs = [...sku.locs].map((i) => sim.L.locations[i]).filter((l) => l.units > 0);
  const stock = locs.reduce((s, l) => s + l.units, 0);
  const face = sim.L.locations[sku.face];
  return [
    `**${sku.code}** · ${sku.nombre} · clase ${sku.cls}.`,
    `Stock: ${num(stock)} cajas en ${locs.length} huecos; picking en ${face.id} (nivel ${face.level + 1}, ${num(face.units)} cajas). Demanda prevista ${num(sku.demanda)} cajas/día.`,
    `Hoy: ${sku.lineas} líneas, ${sku.cortas} incompletas.`,
  ].join('\n\n');
}

function red(ctx) {
  const rows = ctx.network?.();
  if (!rows?.length) return 'No tengo todavía los datos del resto de almacenes.';
  const filas = rows.map((r) => `- **${r.site.nombre}**: OTIF ${pct(r.k.otif)}, fill ${pct(r.k.fill)}, dock-to-stock ${num(r.k.dts)} min, ocupación ${pct(r.k.ocupacion)}, ${r.k.operativas}/${r.k.totalCarretillas} carretillas${r.top ? ` · ${r.top.titulo.toLowerCase()}` : ''}`);
  const peor = rows.slice().sort((a, b) => (a.k.otif ?? 1) - (b.k.otif ?? 1))[0];
  return [`Comparación a las ${fmt(rows[0].k.t)} (mismo momento del turno en los tres):`, filas.join('\n'), peor.top ? `El que más preocupa es **${peor.site.nombre}**: ${peor.top.detalle}` : ''].filter(Boolean).join('\n\n');
}
