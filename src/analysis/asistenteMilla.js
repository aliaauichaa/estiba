// Asistente de la operativa de última milla: mismo método que los otros dos (hoy frente a la media de
// los 14 días anteriores, causa en la cadena, acciones de una lista cerrada). La cadena aquí es:
// camión del cliente → sorter → ola de salida → delegación → conductores → cliente final.

import { mediaEn } from './history.js';
import { fmt } from '../sim/engine.js';
import { tx, num, pct } from '../i18n.js';
import { esPreguntaSobreAli, clasificar } from '../../lambda/asistente/ruta.mjs';
import { sobreAli } from './assistant.js';

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Título dentro de una frase: minúscula solo la primera letra (los nombres propios se quedan como están).
const minus = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const pl = (n, es1, esN, en1, enN) => `${num(n)} ${n === 1 ? tx(es1, en1) : tx(esN, enN)}`;
const bultos = (n) => pl(n, 'bulto', 'bultos', 'parcel', 'parcels');
const entregas = (n) => pl(n, 'entrega', 'entregas', 'delivery', 'deliveries');


export function diagnoseMilla(sim, history) {
  const k = sim.kpis();
  const b = mediaEn(history, sim.t);
  const out = [];
  const hora = fmt(sim.t);

  // 1. Sorter parado o con atasco hoy.
  const atasco = sim.incidencias.find((w) => w.tipo === 'sorter' && w.empezo);
  if (atasco) {
    const min = Math.round(Math.min(sim.t, atasco.hasta) - atasco.desde);
    const manual = sim.variant === 'refuerzo';
    const ahora = sim.sorterParado ? (manual ? tx(' Sigue parado; la inducción manual clasifica al 45 % del ritmo.', ' It is still down; the manual induction sorts at 45% of the rate.') : tx(' Sigue parado.', ' It is still down.')) : '';
    out.push({
      id: 'sorter',
      peso: (sim.sorterParado ? 3 : 1) + min / 60,
      titulo: tx('Atasco en el sorter', 'Sorter jam'),
      detalle: tx(`El sorter estuvo **${min} min parado** desde las ${fmt(atasco.desde)} (${atasco.es}).${ahora} Ahora hay ${bultos(k.pendientes)} esperando a la inducción.`,
        `The sorter was **down for ${min} min** from ${fmt(atasco.desde)} (${atasco.en}).${ahora} Right now ${bultos(k.pendientes)} ${k.pendientes === 1 ? 'is' : 'are'} waiting at the induction point.`),
      accion: sim.sorterParado && manual
        ? tx('La inducción manual ya está abierta (45 % del ritmo): avisar a mantenimiento y dar prioridad a los bultos de las delegaciones más lejanas.', 'The manual induction is already open (45% of the rate): call maintenance and give priority to parcels for the furthest depots.')
        : sim.sorterParado
        ? tx('Abrir una inducción manual mientras dure el atasco y avisar a mantenimiento; dar prioridad a los bultos de las delegaciones más lejanas.', 'Open a manual induction while the jam lasts and call maintenance; give priority to parcels for the furthest depots.')
        : tx('Pedir a mantenimiento la causa del atasco y revisar la inducción antes del próximo turno.', 'Ask maintenance for the cause of the jam and check the induction point before the next shift.'),
    });
  }

  // 2. Arrastre: bultos que no salen en la ola que les tocaba.
  const retrasos = sim.incidencias.filter((w) => w.tipo === 'retraso').map((w) => sim.camiones.find((c) => c.incidencia === w)).filter((c) => c && c.estado !== 'ruta');
  if (k.arrastrados > 50 || retrasos.length) {
    const prox = sim.olas.find((o) => !o.salio);
    const pendiente = [...sim.rampas.values()].flat().concat(sim.cola, sim.colaFrio, sim.camiones.flatMap((c) => c.lotes)).filter((l) => l.arrastrado).reduce((s, l) => s + l.n, 0);
    const lista = retrasos.map((c) => tx(`${c.cliente.nombre} (${Math.round(c.llegada - c.eta)} min tarde, ${bultos(c.n)})`, `${c.cliente.nombre} (${Math.round(c.llegada - c.eta)} min late, ${bultos(c.n)})`)).join(', ');
    out.push({
      id: 'arrastre',
      peso: 1.5 + k.arrastrados / 400,
      titulo: tx('Bultos que pierden su ola', 'Parcels missing their wave'),
      detalle: tx(
        `${k.corte != null ? `Salen en su ola el **${pct(k.corte)}** de los bultos${b?.corte != null ? ` (habitual ${pct(b.corte)})` : ''}; **${num(k.arrastrados)}** pierden la ola que les tocaba y salen en una posterior.` : 'Todavía no ha salido ninguna ola.'}${lista ? ` Camiones de cliente con retraso: ${lista}.` : ''}${atasco ? ' El atasco del sorter retrasó además la clasificación de la primera ola.' : ''}`,
        `${k.corte != null ? `**${pct(k.corte)}** of parcels leave on their wave${b?.corte != null ? ` (usually ${pct(b.corte)})` : ''}; **${num(k.arrastrados)}** miss their planned wave and leave on a later one.` : 'No wave has left yet.'}${lista ? ` Late customer trucks: ${lista}.` : ''}${atasco ? ' The sorter jam also delayed sorting for the first wave.' : ''}`,
      ),
      accion: (pendiente ? prox : retrasos.some((c) => c.estado !== 'fuera') ? sim.olas.find((o) => !o.salio && o.salida - sim.t > 30) : null)
        ? tx(`Pedir un camión extra antes de la ola ${(pendiente ? prox : sim.olas.find((o) => !o.salio && o.salida - sim.t > 30)).i + 1} (${fmt((pendiente ? prox : sim.olas.find((o) => !o.salio && o.salida - sim.t > 30)).salida)}) para las delegaciones con más arrastre y avisar al cliente que llegó tarde para reprogramar su cita.`, `Order an extra truck before wave ${(pendiente ? prox : sim.olas.find((o) => !o.salio && o.salida - sim.t > 30)).i + 1} (${fmt((pendiente ? prox : sim.olas.find((o) => !o.salio && o.salida - sim.t > 30)).salida)}) for the depots with the most carry-over and ask the late customer to rebook its slot.`)
        : tx('Avisar al cliente que llegó tarde para reprogramar su cita de mañana y revisar las rampas con lo que sale mañana.', 'Ask the late customer to rebook tomorrow\'s slot and review the ramps holding what goes out tomorrow.'),
    });
  }

  // 3. Delegaciones con conductores de baja: no llegan a repartir todo.
  for (const d of sim.delegaciones.filter((x) => x.bajas > x.refuerzo)) {
    const e = sim.delegacion(d);
    const enCarga = sim.enCarga(d);
    const sin = Math.max(0, sim.sinRepartir(d) - enCarga);
    const terminado = sim.t >= sim.fin || sim.olas.every((o) => o.salio);
    out.push({
      id: 'reparto',
      hub: d.id,
      peso: 2 + (d.bajas - d.refuerzo) / 2 + sin / 200,
      titulo: tx(`Faltan conductores en ${d.es}`, `Drivers missing at ${d.en}`),
      detalle: tx(
        `${d.es} trabaja hoy con **${e.conductores} de ${d.conductores} conductores** (${d.bajas} de baja${d.refuerzo ? `, ${d.refuerzo} de refuerzo` : ''}). Lleva ${entregas(e.entregados)}; ${sin ? `**${bultos(sin)}** esperan en la delegación sin furgoneta` : enCarga ? `**${bultos(enCarga)}** se están cargando en las furgonetas` : d.recibidos ? 'de momento todo lo recibido ha salido a reparto' : 'todavía no ha recibido bultos'}${sin && enCarga ? ` y ${num(enCarga)} se están cargando` : ''}.`,
        `${d.en} is working today with **${e.conductores} of ${d.conductores} drivers** (${d.bajas} off sick${d.refuerzo ? `, ${d.refuerzo} standby` : ''}). It has made ${entregas(e.entregados)}; ${sin ? `**${bultos(sin)}** are waiting at the depot with no van` : enCarga ? `**${bultos(enCarga)}** are being loaded into the vans` : d.recibidos ? 'so far everything received has gone out for delivery' : 'it has not received any parcels yet'}${sin && enCarga ? ` and ${num(enCarga)} are being loaded` : ''}.`,
      ),
      accion: terminado
        ? tx(`Planificar el refuerzo de mañana en ${d.es} y avisar a los clientes de lo que se entrega mañana.`, `Plan tomorrow's reinforcement at ${d.en} and tell customers what will be delivered tomorrow.`)
        : tx(`Reforzar ${d.es} con conductores de Madrid Este o de una ETT para la ola de tarde.`, `Reinforce ${d.en} with drivers from Madrid East or an agency for the afternoon wave.`),
    });
  }

  // 4. Ausencias en la entrega.
  const intentos = k.entregados + k.fallos;
  const extraAusencias = k.primerIntento != null && b?.primerIntento != null ? (b.primerIntento - k.primerIntento) * intentos : 0;
  if (intentos >= 200 && extraAusencias >= 10 && b.primerIntento - k.primerIntento > 0.015) {
    out.push({
      id: 'ausencias',
      peso: 1 + Math.min(2, extraAusencias / 50),
      titulo: tx('Más ausencias que de costumbre', 'More failed deliveries than usual'),
      detalle: tx(`Se entrega a la primera el **${pct(k.primerIntento)}** (habitual ${pct(b.primerIntento)}); ${pl(k.fallos, 'cliente no estaba', 'clientes no estaban', 'customer was out', 'customers were out')}.`, `**${pct(k.primerIntento)}** are delivered first time (usually ${pct(b.primerIntento)}); ${pl(k.fallos, 'cliente no estaba', 'clientes no estaban', 'customer was out', 'customers were out')}.`),
      accion: tx('Ofrecer punto de recogida o un segundo intento en la misma tarde a los ausentes.', 'Offer a pickup point or a second attempt the same afternoon to customers who were out.'),
    });
  }

  return { k, b, hora, hallazgos: out.sort((a, c) => c.peso - a.peso) };
}

const INTENTS = [
  { id: 'acciones', re: /(que hago|que hacemos|recomiend|accion|prioridad|solucion|arregl|mejorar|deberia|what should|what do i do|recommend|action|priorit|fix|improve)/ },
  { id: 'planb', re: /(plan b|refuerzo|reforz|induccion manual|manual|backup|reinforce)/ },
  { id: 'sorter', re: /(sorter|clasific|atasco|jam|induccion|induction|cola|backlog|acumul|cross)/ },
  { id: 'arrastre', re: /(\bolas?\b|wave|corte|cut.?off|arrastr|carry|linehaul|se pierde|pierden|miss)/ },
  { id: 'clientes', re: /(zara|inditex|decathlon|gousto|e-?commerce|cliente|customer|client|frio|chill)/ },
  { id: 'reparto', re: /(reparto|repart|conductor|driver|furgonet|\bvans?\b|entreg|deliver|ausen|intento|attempt|baja|sick|delegaci|depot)/ },
  { id: 'resumen', re: /(resumen|como va|como vamos|estado|situacion|hoy|turno|kpi|indicador|summary|how is|how are|status|today|shift)/ },
];

let SIN_ACCIONES = false;

export function sugerenciasMilla() {
  return tx(
    ['¿Cómo va el día?', '¿Por qué hay bultos que pierden su ola?', '¿Qué delegaciones van justas?', '¿Qué hago ahora mismo?', '¿Qué cambia con el plan B?', '¿Quién ha creado Estiba?'],
    ['How is the day going?', 'Why are parcels missing their wave?', 'Which depots are struggling?', 'What should I do right now?', 'What does plan B change?', 'Who built Estiba?'],
  );
}

export function contextoDeRutaMilla(sim) {
  return { almacen: 'Cross-dock', rutas: [...sim.delegaciones.map((d) => ({ destino: d.nombre })), ...[...new Set(sim.camiones.map((c) => c.cliente.nombre))].map((n) => ({ destino: n }))] };
}

export function answerMilla(question, ctx, { sinAcciones = false, historial = [] } = {}) {
  SIN_ACCIONES = sinAcciones;
  try {
    return responder(question, ctx, historial);
  } finally {
    SIN_ACCIONES = false;
  }
}

function responder(question, ctx, historial) {
  const q = norm(question);
  const { sim } = ctx;
  const deleg = sim.delegaciones.find((d) => [norm(d.es), norm(d.en)].some((n) => q.includes(n)));
  const cr = contextoDeRutaMilla(sim);
  if (clasificar(question, historial, cr) === 'ali' || (!deleg && esPreguntaSobreAli(question, historial, cr))) return sobreAli();
  const d = diagnoseMilla(sim, ctx.history);
  const intent = INTENTS.find((i) => i.re.test(q))?.id;
  if (deleg && intent !== 'acciones' && intent !== 'planb') return delegacionDetalle(deleg, sim);
  switch (intent) {
    case 'acciones': return acciones(d);
    case 'planb': return planB(ctx);
    case 'sorter': return sorter(d, sim);
    case 'arrastre': return arrastre(d, sim);
    case 'clientes': return clientes(sim);
    case 'reparto': return reparto(d, sim);
    case 'resumen': return resumen(d, sim);
    default:
      return tx(
        'Puedo contestarte sobre la **red de última milla** con los datos del turno: camiones de los clientes, sorter y cola de inducción, olas de salida y arrastre, delegaciones, conductores, entregas y ausencias, y el plan B.\n\nPrueba con «¿por qué hay bultos que pierden su ola?» o «¿qué hago ahora mismo?».',
        'I can answer questions about the **last-mile network** using the shift data: customer trucks, the sorter and induction queue, departure waves and carry-over, depots, drivers, deliveries and failed attempts, and plan B.\n\nTry "why are parcels missing their wave?" or "what should I do right now?".',
      );
  }
}

function linea(v, base, nombre, f, mejorAlto = true, esPct = false, minAbs = 1) {
  if (v == null) return `- ${nombre}: ${tx('sin datos todavía', 'no data yet')}`;
  let comp = '';
  if (base != null) {
    const diff = v - base;
    const malo = mejorAlto ? diff < 0 : diff > 0;
    const rel = Math.abs(diff) / (Math.abs(base) || 1);
    const igual = esPct ? Math.abs(diff * 100) < 0.5 : Math.abs(diff) < Math.max(minAbs, Math.abs(base) * 0.05);
    comp = igual ? tx(' (en línea con lo habitual)', ' (in line with normal)') : ` (${tx('habitual', 'usually')} ${f(base)}${malo && rel > 0.1 ? tx(', **peor**', ', **worse**') : ''})`;
  }
  return `- ${nombre}: **${f(v)}**${comp}`;
}

function resumen(d, sim) {
  const { k, b } = d;
  const partes = [tx(
    `**Cross-dock y reparto · ${d.hora}.** ${num(k.recibidos)} bultos recibidos de ${num(k.total)} previstos, ${num(k.clasificados)} clasificados y ${num(k.entregados)} entregados; ${pl(k.enRuta, 'conductor', 'conductores', 'driver', 'drivers')} en ruta.`,
    `**Cross-dock and delivery · ${d.hora}.** ${num(k.recibidos)} parcels received out of ${num(k.total)} expected, ${num(k.clasificados)} sorted and ${num(k.entregados)} delivered; ${pl(k.enRuta, 'conductor', 'conductores', 'driver', 'drivers')} on the road.`,
  )];
  partes.push([
    linea(k.corte, b?.corte, tx('Salen en su ola', 'Leave on their wave'), (v) => pct(v), true, true),
    linea(k.pendientes, b?.pendientes, tx('Esperando al sorter', 'Waiting for the sorter'), (v) => num(v), false, false, 50),
    linea(k.dwell, b?.dwell, tx('Tiempo en el cross-dock', 'Time in the cross-dock'), (v) => `${num(v)} min`, false),
    // Con pocos intentos (el arranque del reparto) no se compara: 2 de 3 no es una tendencia.
    linea(k.primerIntento, k.entregados + k.fallos >= 50 ? b?.primerIntento : null, tx('Entrega a la primera', 'First-time delivery'), (v) => pct(v), true, true),
  ].join('\n'));
  if (d.hallazgos.length) partes.push(`${tx('Lo más importante ahora', 'Most important right now')}: **${minus(d.hallazgos[0].titulo)}**. ${d.hallazgos[0].detalle}`);
  else partes.push(tx('No veo desviaciones relevantes respecto a los 14 días anteriores.', 'I see no relevant deviations from the previous 14 days.'));
  return partes.join('\n\n');
}

function sorter(d, sim) {
  const h = d.hallazgos.find((x) => x.id === 'sorter');
  const partes = [tx(`El sorter lleva **${bultos(d.k.clasificados)}** clasificados hoy y hay ${num(d.k.pendientes)} en cola.${sim.sorterParado ? ' **Ahora mismo está parado.**' : ''}`, `The sorter has sorted **${bultos(d.k.clasificados)}** today and ${num(d.k.pendientes)} are queued.${sim.sorterParado ? ' **It is down right now.**' : ''}`)];
  if (h) partes.push(`**${h.titulo}.** ${h.detalle}`);
  if (h && !SIN_ACCIONES) partes.push(`**${tx('Qué haría', 'What I would do')}:** ${h.accion}`);
  return partes.join('\n\n');
}

function arrastre(d, sim) {
  const h = d.hallazgos.find((x) => x.id === 'arrastre');
  const olas = sim.olas.map((o) => {
    const ls = sim.lineas.filter((l) => l.ola === o.i);
    const n = ls.reduce((s, l) => s + l.n, 0);
    const tarde = ls.reduce((s, l) => s + l.tarde, 0);
    return o.salio
      ? tx(`- Ola ${o.i + 1} (${fmt(o.salida)}): ${bultos(n)}${tarde ? `, ${num(tarde)} de una ola anterior` : ''}`, `- Wave ${o.i + 1} (${fmt(o.salida)}): ${bultos(n)}${tarde ? `, ${num(tarde)} carried over` : ''}`)
      : tx(`- Ola ${o.i + 1} (${fmt(o.salida)}): pendiente`, `- Wave ${o.i + 1} (${fmt(o.salida)}): still to leave`);
  });
  const partes = [`${tx('Olas de hoy', "Today's waves")}:\n${olas.join('\n')}`];
  if (h) partes.push(`**${h.titulo}.** ${h.detalle}`);
  else partes.push(tx('De momento todos los bultos salen en la ola que les toca.', 'So far every parcel leaves on its planned wave.'));
  if (h && !SIN_ACCIONES) partes.push(`**${tx('Qué haría', 'What I would do')}:** ${h.accion}`);
  return partes.join('\n\n');
}

function clientes(sim) {
  const por = new Map();
  for (const c of sim.camiones) {
    const x = por.get(c.cliente) || { n: 0, llegados: 0, tarde: 0 };
    x.n += c.n;
    if (c.estado !== 'ruta') x.llegados += c.n;
    if (c.llegada - c.eta > 15 && c.estado !== 'ruta') x.tarde++;
    por.set(c.cliente, x);
  }
  const filas = [...por].map(([c, x]) => tx(`- **${c.nombre}**${c.frio ? ' (frío, va primero en la ruta)' : ''}: ${num(x.llegados)} de ${bultos(x.n)} recibidos${x.tarde ? `, ${pl(x.tarde, 'camión con retraso', 'camiones con retraso', '', '')}` : ''}`, `- **${c.nombre}**${c.frio ? ' (chilled, first on the route)' : ''}: ${num(x.llegados)} of ${bultos(x.n)} received${x.tarde ? `, ${pl(x.tarde, '', '', 'late truck', 'late trucks')}` : ''}`));
  return `${tx('Clientes de hoy (volúmenes simulados)', "Today's customers (simulated volumes)")}:\n${filas.join('\n')}`;
}

function reparto(d, sim) {
  const filas = sim.delegaciones.map((x) => {
    const e = sim.delegacion(x);
    const carga = sim.enCarga(x);
    const sin = Math.max(0, sim.sinRepartir(x) - carga);
    return tx(
      `- ${x.es}: ${entregas(e.entregados)}, ${e.enRuta}/${e.conductores} conductores en ruta${x.bajas ? ` (${x.bajas} de baja${x.refuerzo ? `, ${x.refuerzo} de refuerzo` : ''})` : ''}${sin ? `, ${bultos(sin)} esperando` : ''}${carga ? `, ${num(carga)} cargándose` : ''}`,
      `- ${x.en}: ${entregas(e.entregados)}, ${e.enRuta}/${e.conductores} drivers on the road${x.bajas ? ` (${x.bajas} off sick${x.refuerzo ? `, ${x.refuerzo} standby` : ''})` : ''}${sin ? `, ${bultos(sin)} waiting` : ''}${carga ? `, ${num(carga)} being loaded` : ''}`,
    );
  });
  const primera = d.k.primerIntento != null ? tx(`; a la primera el ${pct(d.k.primerIntento)}`, `; ${pct(d.k.primerIntento)} first time`) : '';
  const partes = [tx(`**${entregas(d.k.entregados)}** hoy${primera}. ${pl(d.k.enRuta, 'conductor', 'conductores', 'driver', 'drivers')} en ruta ahora.`, `**${entregas(d.k.entregados)}** today${primera}. ${pl(d.k.enRuta, 'conductor', 'conductores', 'driver', 'drivers')} on the road now.`), filas.join('\n')];
  const h = d.hallazgos.find((x) => x.id === 'reparto' || x.id === 'ausencias');
  if (h) partes.push(SIN_ACCIONES ? `**${h.titulo}.** ${h.detalle}` : `**${h.titulo}.** ${h.detalle}\n\n**${tx('Qué haría', 'What I would do')}:** ${h.accion}`);
  return partes.join('\n\n');
}

function delegacionDetalle(x, sim) {
  const e = sim.delegacion(x);
  const carga = sim.enCarga(x);
  const sin = Math.max(0, sim.sinRepartir(x) - carga);
  return tx(
    `**${x.es}** · ${num(x.km)} km del cross-dock, ${x.transito} min de camión. Conductores hoy: ${e.conductores} de ${x.conductores}${x.bajas ? ` (${x.bajas} de baja${x.refuerzo ? `, ${x.refuerzo} de refuerzo` : ''})` : ''}; ${e.enRuta} en ruta. Ha recibido ${bultos(x.recibidos)}, lleva ${entregas(e.entregados)} y ${pl(e.fallos, 'ausencia', 'ausencias', '', '')}; ${num(e.camino)} vienen de camino y ${num(e.rampa)} esperan en su rampa del cross-dock.${sin ? ` **${bultos(sin)}** esperan en la delegación.` : ''}${carga ? ` ${num(carga)} se están cargando en las furgonetas.` : ''}`,
    `**${x.en}** · ${num(x.km)} km from the cross-dock, ${x.transito} min by truck. Drivers today: ${e.conductores} of ${x.conductores}${x.bajas ? ` (${x.bajas} off sick${x.refuerzo ? `, ${x.refuerzo} standby` : ''})` : ''}; ${e.enRuta} on the road. It has received ${bultos(x.recibidos)}, made ${entregas(e.entregados)} and had ${pl(e.fallos, '', '', 'failed attempt', 'failed attempts')}; ${num(e.camino)} are on the way and ${num(e.rampa)} are waiting at its cross-dock ramp.${sin ? ` **${bultos(sin)}** are waiting at the depot.` : ''}${carga ? ` ${num(carga)} are being loaded into the vans.` : ''}`,
  );
}

function planB(ctx) {
  const c = ctx.compare?.();
  if (!c) return tx('Estoy calculando el plan B; pregúntame en unos segundos.', 'I am still computing plan B; ask me again in a few seconds.');
  const { hoy, refuerzo } = c;
  return tx([
    '**Plan B: inducción manual durante el atasco y conductores de refuerzo en la delegación con bajas** (mismo día, mismos camiones e incidencias).',
    `- Sin plan B: ${num(hoy.entregados)} entregas, ${num(hoy.sinRepartir)} bultos sin repartir y el ${pct(hoy.corte)} en su ola.`,
    `- Con plan B: **${num(refuerzo.entregados)} entregas**, ${num(refuerzo.sinRepartir)} sin repartir y el ${pct(refuerzo.corte)} en su ola.`,
    'Lo puedes simular en la pestaña Plan B.',
  ].join('\n'), [
    '**Plan B: manual induction during the jam and standby drivers at the depot with absences** (same day, same trucks and incidents).',
    `- Without plan B: ${num(hoy.entregados)} deliveries, ${num(hoy.sinRepartir)} parcels undelivered and ${pct(hoy.corte)} on their wave.`,
    `- With plan B: **${num(refuerzo.entregados)} deliveries**, ${num(refuerzo.sinRepartir)} undelivered and ${pct(refuerzo.corte)} on their wave.`,
    'You can simulate it in the Plan B tab.',
  ].join('\n'));
}

export function accionesMilla(d) {
  return d.hallazgos.map((h) => ({ id: h.hub ? `reparto-${h.hub}` : h.id, titulo: h.titulo, texto: h.accion }));
}

function acciones(d) {
  if (SIN_ACCIONES) {
    if (!d.hallazgos.length) return tx('Ahora mismo no hay nada urgente: el día va como de costumbre.', 'Nothing urgent right now: the day is going as usual.');
    return `${tx('Situación', 'Situation')}:\n${d.hallazgos.map((h) => `- **${h.titulo}.** ${h.detalle}`).join('\n')}`;
  }
  const items = accionesMilla(d).map((a) => `**${a.titulo}:** ${a.texto}`);
  if (!items.length) return tx('Ahora mismo no hay nada urgente: el cross-dock y el reparto van como de costumbre.', 'Nothing urgent right now: the cross-dock and deliveries are running as usual.');
  return `${tx('Por orden de impacto', 'In order of impact')}:\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
}

export function contextoMilla(ctx) {
  const d = diagnoseMilla(ctx.sim, ctx.history);
  const { k, b } = d;
  const sim = ctx.sim;
  const round = (v, n = 3) => (v == null ? null : Number(v.toFixed(n)));
  return {
    operativa: 'ultima-milla',
    centro: tx('Cross-dock Getafe y 8 delegaciones', 'Getafe cross-dock and 8 depots'),
    hora: d.hora,
    indicadores: {
      bultosPrevistos: k.total, recibidos: k.recibidos, clasificados: k.clasificados, esperandoSorter: k.pendientes, enSuOla: round(k.corte), arrastrados: k.arrastrados,
      minutosEnCrossdock: round(k.dwell, 0), entregados: k.entregados, ausencias: k.fallos, entregaALaPrimera: round(k.primerIntento), conductoresEnRuta: k.enRuta, conductores: k.conductores,
      sorterParado: !!sim.sorterParado,
    },
    mediaMismaHora: b ? { enSuOla: round(b.corte), esperandoSorter: round(b.pendientes, 0), minutosEnCrossdock: round(b.dwell, 0), entregaALaPrimera: round(b.primerIntento) } : null,
    hallazgos: d.hallazgos.map((h) => ({ id: h.id, titulo: h.titulo, detalle: h.detalle })),
    acciones: accionesMilla(d),
    olas: sim.olas.map((o) => ({ ola: o.i + 1, salida: fmt(o.salida), salio: o.salio })),
    delegaciones: sim.delegaciones.map((x) => {
      const e = sim.delegacion(x);
      return { delegacion: x.nombre, conductores: e.conductores, plantilla: x.conductores, bajas: x.bajas, enRuta: e.enRuta, entregados: e.entregados, ausencias: e.fallos, esperando: Math.max(0, sim.sinRepartir(x) - sim.enCarga(x)), cargando: sim.enCarga(x), recibidos: x.recibidos };
    }),
    nota: tx('Volúmenes simulados; las marcas de cliente son solo ejemplos.', 'Simulated volumes; customer brands are examples only.'),
  };
}
