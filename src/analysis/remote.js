// Redacción con un modelo (Claude en Amazon Bedrock) a través de la Lambda de lambda/asistente.
// Solo se activa si se define VITE_ESTIBA_API al compilar. El modelo recibe el diagnóstico ya
// calculado y la respuesta local; no inventa datos porque no tiene otros.

import { diagnose } from './assistant.js';
import { fmt } from '../sim/engine.js';
import { lang, placeName } from '../i18n.js';

export const API_URL = import.meta.env?.VITE_ESTIBA_API || '';

function contexto(ctx) {
  const d = diagnose(ctx.sim, ctx.history);
  const k = d.k;
  const round = (v, n = 3) => (v == null ? null : Number(v.toFixed(n)));
  return {
    almacen: `${ctx.sim.site.nombre} (${ctx.sim.site.zona})`,
    hora: fmt(ctx.sim.t),
    indicadores: {
      otif: round(k.otif), aTiempo: round(k.aTiempo), fill: round(k.fill), dockToStockMin: round(k.dts, 0),
      ocupacion: round(k.ocupacion), utilizacion: round(k.utilizacion), lineasHoraEquipo: round(k.productividad, 1),
      carretillasOperativas: `${k.operativas}/${k.totalCarretillas}`, palesEnCalles: k.calle, camionesEnPatio: k.patio,
      pedidosPendientes: k.pendientes, pedidosRetrasados: k.retrasados,
    },
    mediaMismaHora: d.b ? { otif: round(d.b.otif), fill: round(d.b.fill), dockToStockMin: round(d.b.dts, 0), utilizacion: round(d.b.utilizacion) } : null,
    hallazgos: d.hallazgos.map((h) => ({ titulo: h.titulo, detalle: h.detalle, accion: h.accion })),
    rutas: d.rutas.map((r) => ({ destino: placeName(r.ro.destino), salida: fmt(r.ro.salida), estado: r.estado, pedidosListos: r.listos, pedidosEnPreparacion: r.enCurso, pedidosPendientes: r.pendientes, pedidosAunNoLiberados: r.sinLiberar, pedidosTotal: r.total, expedidos: r.ro.salio ? r.ro.expedidos : null })),
    slotting: ctx.opt ? {
      minutosPedidoActual: round(ctx.opt.escenarios[0].minutosPedido, 1),
      minutosPedidoABC: round(ctx.opt.escenarios[2].minutosPedido, 1),
      horasEquipoAhorroDia: round(ctx.opt.horasAhorro, 1),
    } : null,
  };
}

export async function answerRemote(question, ctx, local, historial = []) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idioma: lang, pregunta: question, contexto: contexto(ctx), respuestaBase: local, historial: historial.slice(-6) }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.texto) throw new Error('sin texto');
    return data.texto;
  } finally {
    clearTimeout(timer);
  }
}
