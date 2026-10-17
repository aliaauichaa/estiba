// Asistente de la operativa de automoción. Igual que el del almacén: compara hoy con la media de los 14
// días anteriores a la misma hora y busca la causa recorriendo la cadena hacia atrás
// (línea → Tier 1 → Tier 2 → Tier 3). Solo recomienda acciones de una lista cerrada.

import { mediaEn } from './history.js';
import { fmt, SHIFT_END } from '../sim/engine.js';
import { textoCuota } from '../sim/automocion.js';
import { tx, num, pct, ppUnit } from '../i18n.js';
import { MODULOS, INSUMOS, TAKT } from '../data/automocion.js';
import { esPreguntaSobreAli, clasificar } from '../../lambda/asistente/ruta.mjs';
import { sobreAli } from './assistant.js';

const n1 = (v) => num(v, 1);
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const insumo = (c) => tx(INSUMOS[c].es, INSUMOS[c].en);
const modulo = (id) => { const m = MODULOS.find((x) => x.id === id); return tx(m.es, m.en).toLowerCase(); };
const tierN = (p) => `Tier ${p.tier}`;
// Título dentro de una frase: minúscula solo la primera letra (los nombres propios se quedan como están).
const minus = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const pl = (n, es1, esN, en1, enN) => `${num(n)} ${n === 1 ? tx(es1, en1) : tx(esN, enN)}`;

const sgn = (v) => (v == null ? '' : `${Math.abs(v) < 0.05 ? '±' : v > 0 ? '+' : '−'}${n1(Math.abs(v))}${ppUnit()}`);

// Insumo más justo de una planta: el que le falta o, si no, el de menos cobertura.
function masJusto(sim, p) {
  if (!p.usa?.length) return null;
  if (p.falta) return p.falta;
  return p.usa.slice().sort((a, b) => sim.coberturaInsumo(p, a) - sim.coberturaInsumo(p, b))[0];
}

// Cadena de causas de un módulo, hacia atrás hasta el Tier 3.
export function cadena(sim, moduloId) {
  const m = MODULOS.find((x) => x.id === moduloId);
  const pasos = [];
  const t1 = sim.planta.get(m.t1);
  const retraso = sim.incidencias.find((w) => w.tipo === 'retraso' && w.planta === t1.id && w.empezo);
  if (retraso) pasos.push({ planta: t1, tipo: 'retraso', w: retraso, enRuta: sim.camiones.some((k) => k.incidencia === retraso && k.estado === 'ruta') });
  let p = t1;
  for (let guard = 0; guard < 3 && p; guard++) {
    const c = masJusto(sim, p);
    if (!c) {
      if (p.cuota != null) pasos.push({ planta: p, tipo: 'cuota' });
      if (p.averia) pasos.push({ planta: p, tipo: 'averia' });
      break;
    }
    const cob = sim.coberturaInsumo(p, c);
    if (p.averia) pasos.push({ planta: p, tipo: 'averia' });
    if (!p.falta && cob > 120) break;
    pasos.push({ planta: p, tipo: 'insumo', c, cob, sin: p.falta === c });
    p = sim.proveedorDe.get(c);
    if (p && p.tier === 3) {
      if (p.cuota != null || p.averia) pasos.push({ planta: p, tipo: p.averia ? 'averia' : 'cuota' });
      break;
    }
  }
  return pasos;
}

function textoCadena(pasos) {
  return pasos.map((s) => {
    const p = s.planta;
    if (s.tipo === 'retraso') {
      return s.enRuta
        ? tx(`la lanzadera de ${p.es} llegará unos ${s.w.minutos} min tarde (${s.w.es})`, `the ${p.en} shuttle will arrive about ${s.w.minutos} min late (${s.w.en})`)
        : tx(`la lanzadera de ${p.es} llegó unos ${s.w.minutos} min tarde (${s.w.es})`, `the ${p.en} shuttle arrived about ${s.w.minutos} min late (${s.w.en})`);
    }
    if (s.tipo === 'cuota') return tx(`**${p.es} (${tierN(p)})** trabaja con la cuota al ${textoCuota(p)}`, `**${p.en} (${tierN(p)})** is running with its allocation at ${textoCuota(p)}`);
    if (s.tipo === 'averia') return tx(`**${p.es} (${tierN(p)})** está parada por avería`, `**${p.en} (${tierN(p)})** is down with a breakdown`);
    return s.sin
      ? tx(`**${p.es} (${tierN(p)})** se ha quedado sin ${insumo(s.c)}`, `**${p.en} (${tierN(p)})** has run out of ${insumo(s.c)}`)
      : tx(`**${p.es} (${tierN(p)})** va justa de ${insumo(s.c)} (${num(s.cob)} min)`, `**${p.en} (${tierN(p)})** is short of ${insumo(s.c)} (${num(s.cob)} min)`);
  }).join(' ← ');
}

// ---------------------------------------------------------------------------- diagnóstico

export function diagnoseAuto(sim, history) {
  const k = sim.kpis();
  const b = mediaEn(history, sim.t);
  const out = [];
  const hora = fmt(sim.t);
  const cuota = sim.plantas.find((p) => p.tier === 3 && p.cuota != null);
  // A última hora lo que se pida ya no llega a la línea hoy: chips 140 min + Electrónica + lanzadera + fabricación.
  // Medido con el simulador: activar el plan B después de las 17:00 no saca ni un coche más.
  const tarde = sim.t > SHIFT_END - 300;
  const planBActivo = sim.variant === 'dual' || sim.incidencias.some((w) => w.tipo === 'alternativo');
  let parosConPlanB = false;
  // Con el plan B elegido: antes de las 10:00 aún no ha entrado; después, ya está en marcha.
  const alternativo = sim.incidencias.find((w) => w.tipo === 'alternativo');
  const planBTexto = () => (alternativo && !alternativo.empezo
    ? tx(`El plan B ya está activado: el proveedor alternativo entra a las ${fmt(alternativo.desde)}; mientras, pedir un envío urgente de chips a Electrónica y resecuenciar la línea.`, `Plan B is already activated: the alternative supplier kicks in at ${fmt(alternativo.desde)}; meanwhile, request an urgent chip shipment to Electronics and resequence the line.`)
    : tx('El plan B ya está en marcha: pedir un envío urgente de chips a Electrónica y resecuenciar la línea hasta que lleguen.', 'Plan B is already under way: request an urgent chip shipment to Electronics and resequence the line until they arrive.'));

  // 1. Paros de línea, con su cadena: la del módulo que la para ahora, o la del que más minutos lleva.
  if (k.paros >= 1) {
    const por = Object.entries(sim.c.paroPor).filter(([, v]) => v >= 0.5).sort((a, c) => c[1] - a[1]);
    const mid = sim.parada?.faltan[0] ?? por[0][0];
    const pasos = cadena(sim, mid);
    const cadenaChips = !!(cuota && pasos.some((s) => s.planta === cuota));
    parosConPlanB = !planBActivo && cadenaChips;
    // Sigue activo si la línea está parada o si la causa sigue ahí (falta de insumo, cuota, avería, retraso en ruta).
    const activa = !!sim.parada || pasos.some((s) => (s.tipo === 'retraso' ? s.enRuta : s.tipo !== 'insumo' || s.sin || s.cob < 60));
    const reparto = por.map(([id, v]) => `${modulo(id)} ${num(v)} min`).join(', ');
    const ahora = sim.parada ? tx(` Ahora mismo está **parada** desde las ${fmt(sim.parada.desde)}.`, ` Right now it has been **stopped** since ${fmt(sim.parada.desde)}.`) : '';
    out.push({
      id: 'paros',
      peso: activa ? 3 + k.paros / 60 : 1 + k.paros / 120,
      titulo: sim.parada ? tx('Línea parada por falta de módulos', 'Line stopped for missing modules') : tx('Paros de línea hoy por falta de módulos', 'Line stops today for missing modules'),
      detalle: tx(
        `La línea lleva **${num(k.paros)} min parada** hoy en ${sim.c.paros} ${sim.c.paros === 1 ? 'paro' : 'paros'} (${reparto}).${ahora}${pasos.length ? ` Cadena: ${textoCadena(pasos)}.` : ''}`,
        `The line has been **stopped for ${num(k.paros)} min** today in ${sim.c.paros} ${sim.c.paros === 1 ? 'stop' : 'stops'} (${reparto}).${ahora}${pasos.length ? ` Chain: ${textoCadena(pasos)}.` : ''}`,
      ),
      accion: cadenaChips && tarde
        ? (planBActivo
          ? tx('Dejar activado el proveedor alternativo de chips para el turno de mañana y planificar la secuencia de mañana con menos versiones con electrónica.',
            'Keep the alternative chip supplier on for tomorrow\'s shift and plan tomorrow\'s sequence with fewer high-electronics trims.')
          : tx('Activar el proveedor alternativo de chips para el turno de mañana (hoy ya no llegaría a la línea) y planificar la secuencia de mañana con menos versiones con electrónica.',
            'Activate the alternative chip supplier for tomorrow\'s shift (it would not reach the line today) and plan tomorrow\'s sequence with fewer high-electronics trims.'))
        : cadenaChips && planBActivo
        ? planBTexto()
        : parosConPlanB
        ? tx('Activar el proveedor alternativo de chips (plan B) y pedir un envío urgente a Electrónica; mientras llega, resecuenciar la línea para adelantar las versiones con menos electrónica.',
          'Activate the alternative chip supplier (plan B) and request an urgent shipment to Electronics; until it arrives, resequence the line to bring forward the trims with less electronics.')
        : activa
          ? tx('Pedir al Tier 1 una lanzadera de reserva y subir el stock a pie de línea de ese módulo mientras dure la incidencia.',
            'Ask the Tier 1 for a standby shuttle and raise the line-side stock of that module while the incident lasts.')
          : tx('Revisar con el Tier 1 la ruta alternativa y el stock de seguridad de ese módulo para el próximo retraso.',
            'Review the alternative route and that module\'s safety stock with the Tier 1 before the next delay.'),
    });
  }

  // 2. Suministro en riesgo aunque la línea aún no haya parado por ello.
  const riesgo = sim.insumosEnRiesgo(90);
  if (riesgo.length && !parosConPlanB) {
    const top = riesgo.slice(0, 3).map((r) => tx(`${r.p.es} (${tierN(r.p)}): ${insumo(r.c)}, ${num(r.cob)} min`, `${r.p.en} (${tierN(r.p)}): ${insumo(r.c)}, ${num(r.cob)} min`)).join('; ');
    out.push({
      id: 'suministro',
      peso: 2 + riesgo.length / 2,
      titulo: tx('Suministro en riesgo', 'Supply at risk'),
      detalle: tx(`${riesgo.length === 1 ? 'Hay **1 insumo con menos de 90 min de cobertura**' : `Hay **${riesgo.length} insumos con menos de 90 min de cobertura**`}: ${top}.${cuota ? ` Origen: ${cuota.es} (Tier 3) con la cuota al ${textoCuota(cuota)}.` : ''}`,
        `${riesgo.length === 1 ? '**1 input has under 90 min of coverage**' : `**${riesgo.length} inputs have under 90 min of coverage**`}: ${top}.${cuota ? ` Source: ${cuota.en} (Tier 3), allocation at ${textoCuota(cuota)}.` : ''}`),
      accion: cuota && tarde
        ? (planBActivo
          ? tx('Dejar activado el proveedor alternativo de chips para mañana y revisar con Electrónica el stock de seguridad de centralitas.', 'Keep the alternative chip supplier on for tomorrow and review the control-unit safety stock with Electronics.')
          : tx('Activar el proveedor alternativo de chips para mañana (hoy ya no llegaría a la línea) y revisar con Electrónica el stock de seguridad de centralitas.', 'Activate the alternative chip supplier for tomorrow (it would not reach the line today) and review the control-unit safety stock with Electronics.'))
        : cuota
        ? (planBActivo ? planBTexto() : tx('Activar el proveedor alternativo de chips (plan B) antes de que la falta llegue a la línea.', 'Activate the alternative chip supplier (plan B) before the shortage reaches the line.'))
        : tx('Adelantar el siguiente camión del proveedor y subir el stock de seguridad de ese insumo.', 'Bring forward the supplier\'s next truck and raise that input\'s safety stock.'),
    });
  } else if (cuota && !out.length) {
    out.push({
      id: 'suministro',
      peso: 1.5,
      titulo: tx('Cuota de chips recortada', 'Chip allocation cut'),
      detalle: tx(`${cuota.es} (Tier 3) trabaja con la cuota al ${textoCuota(cuota)}. De momento los stocks de Tier 2 y Tier 1 lo absorben.`, `${cuota.en} (Tier 3) has its allocation at ${textoCuota(cuota)}. For now Tier 2 and Tier 1 stocks absorb it.`),
      accion: planBActivo ? planBTexto() : tx('Activar el proveedor alternativo de chips (plan B) antes de que la falta llegue a la línea.', 'Activate the alternative chip supplier (plan B) before the shortage reaches the line.'),
    });
  }

  // 3. Transporte JIT: lanzaderas que llegan tarde. Un retraso ya resuelto no es un problema de ahora.
  const retrasos = sim.incidencias.filter((w) => w.tipo === 'retraso' && w.empezo);
  const activos = retrasos.filter((w) => sim.camiones.some((c) => c.incidencia === w && c.estado === 'ruta'));
  const tardeAhora = sim.camiones.filter((c) => c.tipo === 't1' && c.estado === 'ruta' && c.llegada - c.prevista > 10);
  if (activos.length || tardeAhora.length) {
    const lista = retrasos.map((w) => tx(`${sim.planta.get(w.planta).es} (${w.minutos} min, ${w.es})`, `${sim.planta.get(w.planta).en} (${w.minutos} min, ${w.en})`)).join(', ');
    out.push({
      id: 'transporte',
      peso: 1.5 + activos.length,
      titulo: tx('Lanzaderas con retraso', 'Late shuttles'),
      detalle: tx(`Llegan a tiempo el **${pct(k.otd1)}** de las lanzaderas${b?.otd1 != null ? ` (habitual ${pct(b.otd1)})` : ''}.${lista ? ` Retrasos de hoy: ${lista}.` : ''} Con secuencia JIT, una lanzadera tarde retiene también a las siguientes del mismo módulo.`,
        `**${pct(k.otd1)}** of shuttles arrive on time${b?.otd1 != null ? ` (usually ${pct(b.otd1)})` : ''}.${lista ? ` Today's delays: ${lista}.` : ''} With JIT sequencing, a late shuttle also holds up the next ones for the same module.`),
      accion: tx('Pedir al Tier 1 una lanzadera de reserva y avisar a logística de entrada; revisar la ruta alternativa para las siguientes.', 'Ask the Tier 1 for a standby shuttle and alert inbound logistics; review the alternative route for the next ones.'),
    });
  }

  // 4. Avería en Tier 2.
  const averias = sim.plantas.filter((p) => p.averia);
  for (const p of averias) {
    out.push({
      id: 'averia',
      peso: 2,
      titulo: tx(`Avería en ${p.es}`, `Breakdown at ${p.en}`),
      detalle: tx(`${p.es} (${tierN(p)}) está parada hasta las ${fmt(p.averia.hasta)}; sus clientes tiran del stock que tienen.`, `${p.en} (${tierN(p)}) is down until ${fmt(p.averia.hasta)}; its customers are using up their stock.`),
      accion: tx('Acordar con el Tier 2 un turno extra para recuperar el stock en cuanto vuelva a producir.', 'Agree an extra shift with the Tier 2 to rebuild stock as soon as it is back up.'),
    });
  }

  // 5. Calidad en fin de línea.
  const extraRetrabajo = k.fpy != null && b?.fpy != null ? (b.fpy - k.fpy) * k.probados : 0;
  if (k.probados >= 60 && extraRetrabajo >= 3 && b.fpy - k.fpy > 0.015) {
    out.push({
      id: 'calidad',
      peso: 1 + Math.min(2, extraRetrabajo / 10),
      titulo: tx('Más retrabajo que de costumbre', 'More rework than usual'),
      detalle: tx(`El FPY (coches que pasan el banco de pruebas a la primera) es del **${pct(k.fpy)}** frente al ${pct(b.fpy)} habitual; ${k.retrabajos === 1 ? '1 coche ha ido' : `${k.retrabajos} coches han ido`} a retrabajo.`,
        `FPY (cars passing the end-of-line test first time) is **${pct(k.fpy)}** against the usual ${pct(b.fpy)}; ${pl(k.retrabajos, 'coche', 'coches', 'car', 'cars')} went to rework.`),
      accion: tx('Revisar en el banco de pruebas el defecto más repetido y reforzar la estación que lo origina.', 'Review the most frequent defect at the test bench and reinforce the station causing it.'),
    });
  }

  const modulos = MODULOS.map((m) => {
    const prox = sim.camiones.filter((c) => c.estado === 'ruta' && c.modulo === m.id).sort((a, c) => a.llegada - c.llegada)[0];
    return { m, cob: sim.coberturaModulo(m.id), prox, t1: sim.planta.get(m.t1) };
  });
  return { k, b, hora, hallazgos: out.sort((a, c) => c.peso - a.peso), modulos, cuota, parosConPlanB };
}

// ---------------------------------------------------------------------------- respuestas

const INTENTS = [
  { id: 'acciones', re: /(que hago|que hacemos|recomiend|accion|prioridad|solucion|arregl|mejorar|deberia|what should|what do i do|recommend|action|priorit|fix|improve)/ },
  { id: 'planb', re: /(plan b|alternativ|segundo proveedor|otro proveedor|dual|second source|backup supplier|other supplier)/ },
  { id: 'calidad', re: /(calidad|quality|fpy|retrabajo|rework|defect|banco de prueba|test)/ },
  { id: 'transporte', re: /(camion|lanzadera|shuttle|truck|transporte|transport|llega|arriv|retraso|delay|jit|secuencia|sequence)/ },
  { id: 'suministro', re: /(chip|semicon|tier|proveedor|supplier|suministro|supply|falta|rotura|shortage|ecu|centralit|electronic|riesgo|risk|stock|cobertura|coverage)/ },
  { id: 'paros', re: /(para|paro|parad|stop|linea|line|por que|why|cae|baja|drop|retras)/ },
  { id: 'plan', re: /(plan|cuantos coches|coches|produccion|production|objetivo|target|how many cars|cars)/ },
  { id: 'resumen', re: /(resumen|como va|como vamos|estado|situacion|hoy|turno|kpi|indicador|summary|how is|how are|status|today|shift)/ },
];

let SIN_ACCIONES = false;

export function sugerenciasAuto() {
  return tx(
    ['¿Cómo va la producción?', '¿Por qué se para la línea?', '¿Qué proveedores están en riesgo?', '¿Qué hago ahora mismo?', '¿Qué pasaría con el plan B?', '¿Quién ha creado Estiba?'],
    ['How is production going?', 'Why does the line stop?', 'Which suppliers are at risk?', 'What should I do right now?', 'What would plan B change?', 'Who built Estiba?'],
  );
}

export function contextoDeRutaAuto(sim) {
  return { almacen: tx('Montaje final', 'Final assembly'), rutas: sim.plantas.map((p) => ({ destino: p.nombre })) };
}

export function answerAuto(question, ctx, { sinAcciones = false, historial = [] } = {}) {
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
  const planta = sim.plantas.find((p) => [norm(p.es), norm(p.en)].some((n) => q.includes(n)));
  const cr = contextoDeRutaAuto(sim);
  if (clasificar(question, historial, cr) === 'ali' || (!planta && esPreguntaSobreAli(question, historial, cr))) return sobreAli();
  const d = diagnoseAuto(sim, ctx.history);
  const intent = INTENTS.find((i) => i.re.test(q))?.id;
  if (planta && intent !== 'acciones' && intent !== 'planb') return plantaDetalle(planta, sim);
  switch (intent) {
    case 'acciones': return acciones(d);
    case 'planb': return planB(ctx);
    case 'calidad': return calidad(d);
    case 'transporte': return transporte(d, sim);
    case 'suministro': return suministro(d, sim);
    case 'paros': return paros(d, sim);
    case 'plan':
    case 'resumen': return resumen(d, sim);
    default:
      return tx(
        'Puedo contestarte sobre la **cadena de automoción** con los datos del turno: producción frente al plan, paros de línea y su causa, cobertura de los módulos a pie de línea, proveedores Tier 1, 2 y 3 en riesgo, lanzaderas JIT, calidad y el plan B.\n\nPrueba con «¿por qué se para la línea?» o «¿qué hago ahora mismo?».',
        'I can answer questions about the **automotive supply chain** using the shift data: production against plan, line stops and their cause, line-side module coverage, Tier 1, 2 and 3 suppliers at risk, JIT shuttles, quality and plan B.\n\nTry "why does the line stop?" or "what should I do right now?".',
      );
  }
}

function linea(v, base, nombre, f, mejorAlto = true, esPct = false) {
  if (v == null) return `- ${nombre}: ${tx('sin datos todavía', 'no data yet')}`;
  let comp = '';
  if (base != null) {
    const diff = v - base;
    const malo = mejorAlto ? diff < 0 : diff > 0;
    const rel = Math.abs(diff) / (Math.abs(base) || 1);
    const igual = esPct ? Math.abs(diff * 100) < 0.5 : Math.abs(diff) < Math.max(1, Math.abs(base) * 0.05);
    comp = igual ? tx(' (en línea con lo habitual)', ' (in line with normal)') : ` (${tx('habitual', 'usually')} ${f(base)}${malo && rel > 0.1 ? tx(', **peor**', ', **worse**') : ''})`;
  }
  return `- ${nombre}: **${f(v)}**${comp}`;
}

function resumen(d, sim) {
  const { k, b } = d;
  const estado = sim.parada
    ? tx(`**parada** desde las ${fmt(sim.parada.desde)} (falta ${sim.parada.faltan.map(modulo).join(', ')})`, `**stopped** (since ${fmt(sim.parada.desde)}, missing ${sim.parada.faltan.map(modulo).join(', ')})`)
    : tx('en marcha', 'running');
  const partes = [tx(
    `**Montaje final · ${d.hora}.** ${pl(k.montados, 'coche', 'coches', 'car', 'cars')} de ${num(k.planificados)} ${k.planificados === 1 ? 'planificado' : 'planificados'}; la línea está ${estado}.`,
    `**Final assembly · ${d.hora}.** ${pl(k.montados, 'coche', 'coches', 'car', 'cars')} out of ${num(k.planificados)} planned; the line is ${estado}.`,
  )];
  partes.push([
    linea(k.plan, b?.plan, tx('Cumplimiento del plan', 'Plan attainment'), (v) => pct(v), true, true),
    linea(k.paros, b?.paros, tx('Minutos de paro', 'Minutes stopped'), (v) => `${num(v)} min`, false),
    linea(k.cobertura, b?.cobertura, tx('Cobertura JIS mínima', 'Minimum JIS coverage'), (v) => `${num(v)} min`),
    linea(k.otd1, b?.otd1, tx('Lanzaderas a tiempo', 'Shuttles on time'), (v) => pct(v), true, true),
    linea(k.fpy, k.probados >= 30 ? b?.fpy : null, 'FPY', (v) => pct(v), true, true),
  ].join('\n'));
  if (d.hallazgos.length) partes.push(`${tx('Lo más importante ahora', 'Most important right now')}: **${minus(d.hallazgos[0].titulo)}**. ${d.hallazgos[0].detalle}`);
  else partes.push(tx('No veo desviaciones relevantes respecto a los 14 días anteriores.', 'I see no relevant deviations from the previous 14 days.'));
  return partes.join('\n\n');
}

function paros(d, sim) {
  const h = d.hallazgos.find((x) => x.id === 'paros');
  if (!h) {
    const s = d.hallazgos.find((x) => x.id === 'suministro');
    return [tx('Hoy la línea no ha parado.', 'The line has not stopped today.'), s ? `**${s.titulo}.** ${s.detalle}` : tx('Todos los módulos llegan a tiempo a pie de línea.', 'All modules are reaching the line on time.')].join(' ');
  }
  const mods = d.modulos.map((x) => tx(`- ${x.m.es}: ${x.cob} min a pie de línea${x.prox ? `, próxima lanzadera ${fmt(x.prox.llegada)}` : ''}`, `- ${x.m.en}: ${x.cob} min at the line${x.prox ? `, next shuttle ${fmt(x.prox.llegada)}` : ''}`));
  return [`**${h.titulo}.** ${h.detalle}`, `${tx('Cobertura a pie de línea', 'Line-side coverage')}:\n${mods.join('\n')}`, SIN_ACCIONES ? '' : `**${tx('Qué haría', 'What I would do')}:** ${h.accion}`].filter(Boolean).join('\n\n');
}

function suministro(d, sim) {
  const riesgo = sim.insumosEnRiesgo(120);
  const partes = [];
  if (d.cuota) partes.push(tx(`**${d.cuota.es} (Tier 3)** trabaja con la cuota al ${textoCuota(d.cuota)}: es el origen de la falta de chips, y de ahí de las centralitas (ECU) que necesitan Cockpit y Frontal.`,
    `**${d.cuota.en} (Tier 3)** has its allocation at ${textoCuota(d.cuota)}: that is where the chip shortage starts, and with it the control units (ECU) that Cockpit and Front end need.`));
  if (riesgo.length) {
    partes.push(`${tx('Insumos con menos de 2 horas de cobertura', 'Inputs with under 2 hours of coverage')}:\n${riesgo.slice(0, 6).map((r) => tx(
      `- ${r.p.es} (${tierN(r.p)}): ${insumo(r.c)}, **${num(r.cob)} min**${r.enCamino ? `, ${r.enCamino} juegos en camino` : ', nada en camino'}`,
      `- ${r.p.en} (${tierN(r.p)}): ${insumo(r.c)}, **${num(r.cob)} min**${r.enCamino ? `, ${r.enCamino} sets on the way` : ', nothing on the way'}`,
    )).join('\n')}`);
  } else {
    partes.push(tx('Todos los insumos de Tier 1 y Tier 2 tienen más de 2 horas de cobertura.', 'Every Tier 1 and Tier 2 input has more than 2 hours of coverage.'));
  }
  const h = d.hallazgos.find((x) => x.id === 'suministro') || (d.parosConPlanB ? d.hallazgos.find((x) => x.id === 'paros') : null);
  if (h && !SIN_ACCIONES) partes.push(`**${tx('Qué haría', 'What I would do')}:** ${h.accion}`);
  return partes.join('\n\n');
}

function transporte(d, sim) {
  const enRuta = sim.camiones.filter((c) => c.estado === 'ruta');
  const lanz = enRuta.filter((c) => c.tipo === 't1').sort((a, b) => a.llegada - b.llegada);
  const partes = [tx(
    `Hay **${pl(enRuta.length, 'camión', 'camiones', 'truck', 'trucks')} en ruta** (${pl(lanz.length, 'lanzadera', 'lanzaderas', 'shuttle', 'shuttles')} de Tier 1 hacia la línea).${d.k.otd1 != null ? ` Han llegado a tiempo el ${pct(d.k.otd1)} de las lanzaderas de hoy.` : ''}`,
    `There ${enRuta.length === 1 ? 'is' : 'are'} **${pl(enRuta.length, 'camión', 'camiones', 'truck', 'trucks')} on the road** (${pl(lanz.length, 'lanzadera', 'lanzaderas', 'shuttle', 'shuttles')} from Tier 1 heading to the line).${d.k.otd1 != null ? ` ${pct(d.k.otd1)} of today's shuttles arrived on time.` : ''}`,
  )];
  if (lanz.length) partes.push(`${tx('Próximas lanzaderas', 'Next shuttles')}:\n${lanz.slice(0, 5).map((c) => `- ${tx(c.origen.es, c.origen.en)}: ${c.n} ${tx('módulos', 'modules')} · ${fmt(c.llegada)}${c.llegada - c.prevista > 10 ? tx(' (con retraso)', ' (late)') : ''}`).join('\n')}`);
  const h = d.hallazgos.find((x) => x.id === 'transporte');
  if (h) partes.push(`**${h.titulo}.** ${SIN_ACCIONES ? h.detalle : h.accion}`);
  return partes.join('\n\n');
}

function calidad(d) {
  const { k, b } = d;
  const h = d.hallazgos.find((x) => x.id === 'calidad');
  if (k.fpy == null) return tx('Todavía no ha pasado ningún coche por el banco de pruebas.', 'No car has reached the test bench yet.');
  return [tx(`FPY: **${pct(k.fpy)}**${b?.fpy != null ? ` (habitual ${pct(b.fpy)}, ${sgn((k.fpy - b.fpy) * 100)})` : ''}. ${k.retrabajos === 1 ? '1 coche ha pasado' : `${num(k.retrabajos)} coches han pasado`} por retrabajo hoy.`,
    `FPY: **${pct(k.fpy)}**${b?.fpy != null ? ` (usually ${pct(b.fpy)}, ${sgn((k.fpy - b.fpy) * 100)})` : ''}. ${pl(k.retrabajos, 'coche', 'coches', 'car', 'cars')} ${k.retrabajos === 1 ? 'has' : 'have'} gone through rework today.`),
  h && !SIN_ACCIONES ? `**${tx('Qué haría', 'What I would do')}:** ${h.accion}` : ''].filter(Boolean).join('\n\n');
}

function planB(ctx) {
  const c = ctx.compare?.();
  if (!c) return tx('Estoy calculando el plan B; pregúntame en unos segundos.', 'I am still computing plan B; ask me again in a few seconds.');
  const { hoy, dual } = c;
  return tx([
    `**Plan B: proveedor alternativo de chips desde las 10:00** (mismo día, mismos pedidos e incidencias; solo cambia el suministro de chips).`,
    `- Sin plan B: ${hoy.montados} coches (${pct(hoy.plan)} del plan) y ${num(hoy.paros)} min de paro.`,
    `- Con plan B: **${dual.montados} coches (${pct(dual.plan)})** y ${num(dual.paros)} min de paro.`,
    `Lo puedes simular en la pestaña Plan B.`,
  ].join('\n'), [
    `**Plan B: alternative chip supplier from 10:00** (same day, same orders and incidents; only the chip supply changes).`,
    `- Without plan B: ${hoy.montados} cars (${pct(hoy.plan)} of plan) and ${num(hoy.paros)} min stopped.`,
    `- With plan B: **${dual.montados} cars (${pct(dual.plan)})** and ${num(dual.paros)} min stopped.`,
    `You can simulate it in the Plan B tab.`,
  ].join('\n'));
}

function plantaDetalle(p, sim) {
  const ins = (p.usa || []).map((c) => tx(`${insumo(c)} ${num(sim.coberturaInsumo(p, c))} min (${p.inv[c]} juegos${sim.enCamino(p, c) ? `, ${sim.enCamino(p, c)} en camino` : ''})`, `${insumo(c)} ${num(sim.coberturaInsumo(p, c))} min (${p.inv[c]} sets${sim.enCamino(p, c) ? `, ${sim.enCamino(p, c)} on the way` : ''})`)).join('; ');
  const estado = p.averia ? tx('parada por avería', 'down with a breakdown') : p.falta ? tx(`parada, sin ${insumo(p.falta)}`, `stopped, no ${insumo(p.falta)}`) : p.cuota != null ? tx(`con la cuota al ${textoCuota(p)}`, `allocation at ${textoCuota(p)}`) : tx('produciendo', 'producing');
  return tx(
    `**${p.es} (${tierN(p)})** · ${estado}. Hoy ha fabricado ${pl(p.hechoHoy, 'juego', 'juegos', 'set', 'sets')}.${ins ? ` Cobertura de sus insumos: ${ins}.` : ''}${p.tier !== 1 ? ` Stock de producto terminado: ${pl(p.fg, 'juego', 'juegos', 'set', 'sets')}.` : ''}`,
    `**${p.en} (${tierN(p)})** · ${estado}. It has made ${pl(p.hechoHoy, 'juego', 'juegos', 'set', 'sets')} today.${ins ? ` Input coverage: ${ins}.` : ''}${p.tier !== 1 ? ` Finished stock: ${pl(p.fg, 'juego', 'juegos', 'set', 'sets')}.` : ''}`,
  );
}

export function accionesAuto(d) {
  return d.hallazgos.map((h) => ({ id: h.id, titulo: h.titulo, texto: h.accion }));
}

function acciones(d) {
  if (SIN_ACCIONES) {
    if (!d.hallazgos.length) return tx('Ahora mismo no hay nada urgente: la línea va en línea con lo habitual.', 'Nothing urgent right now: the line is in line with normal.');
    return `${tx('Situación', 'Situation')}:\n${d.hallazgos.map((h) => `- **${h.titulo}.** ${h.detalle}`).join('\n')}`;
  }
  const items = accionesAuto(d).map((a) => `**${a.titulo}:** ${a.texto}`);
  if (!items.length) return tx('Ahora mismo no hay nada urgente: la línea y los proveedores van como de costumbre.', 'Nothing urgent right now: the line and suppliers are running as usual.');
  return `${tx('Por orden de impacto', 'In order of impact')}:\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
}

// Datos que recibe el modelo en la Lambda (mismas cifras que la respuesta base).
export function contextoAuto(ctx) {
  const d = diagnoseAuto(ctx.sim, ctx.history);
  const { k, b } = d;
  const sim = ctx.sim;
  const round = (v, n = 3) => (v == null ? null : Number(v.toFixed(n)));
  return {
    operativa: 'automocion',
    planta: tx('Montaje final del fabricante (OEM)', 'Carmaker final assembly (OEM)'),
    hora: d.hora,
    indicadores: {
      plan: round(k.plan), cochesMontados: k.montados, cochesPlanificados: k.planificados, minutosParo: round(k.paros, 0), paros: sim.c.paros,
      coberturaJISMinimaMin: k.cobertura, lanzaderasATiempo: round(k.otd1), fpy: round(k.fpy), retrabajos: k.retrabajos, insumosEnRiesgo: k.riesgo,
    },
    mediaMismaHora: b ? { plan: round(b.plan), minutosParo: round(b.paros, 0), coberturaJISMinimaMin: round(b.cobertura, 0), lanzaderasATiempo: round(b.otd1), fpy: round(b.fpy) } : null,
    linea: sim.parada ? { estado: 'parada', desde: fmt(sim.parada.desde), faltan: sim.parada.faltan } : { estado: 'en marcha' },
    hallazgos: d.hallazgos.map((h) => ({ id: h.id, titulo: h.titulo, detalle: h.detalle })),
    acciones: accionesAuto(d),
    modulos: d.modulos.map((x) => ({ modulo: x.m.id, coberturaMin: x.cob, proximaLanzadera: x.prox ? fmt(x.prox.llegada) : null })),
    proveedores: sim.plantas.map((p) => {
      const c = masJusto(sim, p);
      return { planta: p.nombre, tier: p.tier, estado: p.averia ? 'averia' : p.falta ? `sin ${p.falta}` : p.cuota != null ? `cuota ${Math.round(p.cuota * 100)}%${p.alternativo ? ` + alternativo (${Math.round(p.factor * 100)}% total)` : ''}` : 'ok', insumoMasJusto: c, coberturaMin: c ? round(sim.coberturaInsumo(p, c), 0) : null };
    }),
    nota: `takt ${TAKT} min`,
  };
}
