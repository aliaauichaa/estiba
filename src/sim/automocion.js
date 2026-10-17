// Motor de la operativa de automoción: un turno (06:00–22:00) por pasos de 15 segundos.
// Cadena completa con aprovisionamiento por tirón (pull):
//   Tier 3 fabrica materia prima → camión al Tier 2 cuando su stock baja del punto de pedido →
//   Tier 2 fabrica componentes → camión al Tier 1 → Tier 1 fabrica módulos EN SECUENCIA (el orden
//   exacto de los coches de la línea) → lanzaderas JIT a pie de línea → la línea avanza un puesto
//   cada takt si en cada estación de módulo está el del coche que llega; si falta uno, se para entera.
// Así una cuota de chips recortada en Tier 3 tarda horas en notarse, pero acaba parando la línea.

import { makeRng, hashSeed } from './rng.js';
import { tx, pct } from '../i18n.js';
import { SHIFT_START, SHIFT_END, fmt, hm } from './engine.js';
import {
  TAKT, ESTACIONES, MODULOS, PLANTAS, INSUMOS, MODELOS, COLORES, CONCESIONARIOS, INCIDENCIAS_HOY,
} from '../data/automocion.js';

const STEP = 0.25;
const NEED = 1 / TAKT;      // juegos por minuto que consume la línea de cada módulo
const LOTE_T1 = 12;         // módulos por lanzadera
const PIE_LINEA = 14;       // módulos que se quieren a pie de línea, además de lo que cubre el trayecto
const CARGA_PORTA = 9;      // coches por portavehículos
const PRUEBA_MIN = 4;       // banco de pruebas de fin de línea

const pad = (n, w = 2) => String(n).padStart(w, '0');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const nomI = (c) => INSUMOS[c];

export class AutoSim {
  constructor(opts = {}) {
    this.day = opts.day ?? 0;
    this.variant = opts.variant ?? null; // 'dual': proveedor alternativo de chips desde las 10:00
    const seed = (tag) => makeRng(hashSeed('estiba-auto-v1', this.day, tag));
    this.rCar = seed('coches');
    this.rT = seed('transporte');
    this.rQ = seed('calidad');
    this.rInc = seed('incid');
    this.rIni = seed('inicio');
    this.t = SHIFT_START;
    this.events = [];
    this.hourly = [];
    this.serie = [];
    this.c = {
      montados: 0, paroMin: 0, paros: 0, paroPor: Object.fromEntries(MODULOS.map((m) => [m.id, 0])),
      lanzaderas: 0, lanzaderasATiempo: 0, retrasoMax: 0, probados: 0, okPrimera: 0, retrabajos: 0, expedidos: 0,
    };
    this._h = { coches: 0, paro: 0 };
    this.fpy = this.day === 0 ? 0.958 : this.rQ.range(0.955, 0.978);
    this._setupPlantas();
    this._setupCoches();
    this._setupLinea();
    this._setupIncidencias();
    this._setupTransito();
  }

  // ---------------------------------------------------------------- preparación del día

  _setupPlantas() {
    const r = this.rIni;
    this.plantas = PLANTAS.map((d) => ({
      ...d,
      get nombre() { return tx(d.es, d.en); },
      inv: {},
      fg: 0,
      acc: 0,
      factor: 1,
      hechoHoy: 0,
      falta: null,
      averia: null,
      clientes: [],
    }));
    this.planta = new Map(this.plantas.map((p) => [p.id, p]));
    this.proveedorDe = new Map(this.plantas.filter((p) => p.produce).map((p) => [p.produce, p]));
    for (const p of this.plantas) for (const c of p.usa || []) this.proveedorDe.get(c).clientes.push(p);
    // Consumo de cada planta (juegos/min) a ritmo de línea: lo que necesita para no parar a nadie.
    for (const p of this.plantas) p.necesita = p.tier === 1 ? NEED : 0;
    for (const tier of [2, 3]) {
      for (const p of this.plantas.filter((x) => x.tier === tier)) p.necesita = p.clientes.reduce((s, q) => s + q.necesita, 0);
    }
    for (const p of this.plantas) {
      // Stock inicial: entre 2 y 4 horas de consumo de cada insumo; el producto terminado, medio lote.
      for (const c of p.usa || []) p.inv[c] = Math.round(p.necesita * 60 * r.range(2.2, 3.6));
      p.fg = p.tier === 1 ? 0 : Math.round((p.lote || 60) * r.range(0.3, 0.7));
      p.capFg = p.tier === 3 ? p.lote * 2.5 : p.tier === 2 ? p.lote * 2.2 : 0;
    }
    // Hoy la electrónica va justa de chips: es justo la planta que más los necesita.
    if (this.day === 0) {
      const el = this.planta.get('t2-electronica');
      el.inv.chip = 130;
      el.fg = 24;
      this.planta.get('t3-chips').fg = 50;
      for (const id of ['t1-cockpit', 't1-frontal']) this.planta.get(id).inv.ecu = 56;
    }
    // Objetivo de cada Tier 1: módulos entre pie de línea y lanzaderas en camino, y cuánto puede adelantar.
    for (const p of this.plantas.filter((x) => x.tier === 1)) {
      p.objetivo = PIE_LINEA + Math.ceil(p.transito * NEED) + LOTE_T1 / 2;
      p.horizonte = p.objetivo + 2 * LOTE_T1;
    }
  }

  _setupCoches() {
    const r = this.rCar;
    const pesos = (arr) => { const tot = arr.reduce((s, x) => s + x.peso, 0); return () => { let v = r() * tot; for (const x of arr) { v -= x.peso; if (v <= 0) return x; } return arr[0]; }; };
    const modelo = pesos(MODELOS);
    const color = pesos(COLORES);
    this.coches = [];
    const n = Math.ceil((SHIFT_END - SHIFT_START) / TAKT) + ESTACIONES + 120;
    for (let i = 0; i < n; i++) {
      const m = modelo();
      const c = color();
      this.coches.push({
        n: i,
        id: `OF-${pad(this.day)}${pad(i + 1, 4)}`,
        modelo: m,
        color: c,
        get nombre() { return `${tx(this.modelo.es, this.modelo.en)} · ${tx(this.color.es, this.color.en)}`; },
        destino: r.pick(CONCESIONARIOS),
        tEntrada: null, tSalida: null, tPrueba: null, retrabajo: null, tCampa: null, tExpedido: null, ok: null,
      });
    }
  }

  _setupLinea() {
    const r = this.rIni;
    // A las 06:00 la línea está llena: coches 0…11 en las estaciones 11…0.
    this.head = ESTACIONES;
    for (let i = 0; i < ESTACIONES; i++) this.coches[i].tEntrada = SHIFT_START - (ESTACIONES - i) * TAKT;
    this.timer = 0;
    this.parada = null;          // { desde, faltan: [moduloId] }
    this.seq = {};
    for (const m of MODULOS) {
      const montado = ESTACIONES - m.estacion; // coches que ya pasaron por su estación
      const enLinea = r.int(14, 20);
      const llegado = montado + enLinea;
      const enviado = llegado + LOTE_T1;
      const listos = r.int(2, 8);
      this.seq[m.id] = { montado, llegado, enviado, hecho: enviado + listos };
    }
    this.eol = [];      // coches en el banco de pruebas o en retrabajo
    this.campa = [];    // coches terminados esperando portavehículos
    this.portas = [];   // portavehículos que han salido (para la escena)
  }

  _setupIncidencias() {
    const r = this.rInc;
    const out = [];
    if (this.day === 0) {
      for (const inc of INCIDENCIAS_HOY) out.push({ ...inc, desde: hm(inc.desde), hasta: inc.hasta ? hm(inc.hasta) : null });
      if (this.variant === 'dual') out.push({ tipo: 'alternativo', planta: 't3-chips', desde: hm('10:00'), factor: 0.6, es: 'entra el proveedor alternativo de chips', en: 'the alternative chip supplier kicks in' });
    } else {
      if (r() < 0.4) {
        const t1 = r.pick(this.plantas.filter((p) => p.tier === 1));
        out.push({ tipo: 'retraso', planta: t1.id, desde: r.range(8 * 60, 18 * 60), minutos: Math.round(r.range(15, 40)), es: 'retención en la carretera', en: 'traffic hold-up' });
      }
      if (r() < 0.25) {
        const t2 = r.pick(this.plantas.filter((p) => p.tier === 2));
        const desde = r.range(7 * 60, 17 * 60);
        out.push({ tipo: 'averia', planta: t2.id, desde, hasta: desde + r.range(60, 150), es: 'avería en una prensa', en: 'press breakdown' });
      }
    }
    this.incidencias = out.map((w) => ({ ...w, empezo: false, acabo: false }));
  }

  // Camiones que ya iban de camino a las 06:00.
  _setupTransito() {
    this.camiones = [];
    this._idCam = 0;
    const r = this.rIni;
    for (const q of this.plantas) {
      for (const c of q.usa || []) {
        const sup = this.proveedorDe.get(c);
        // Hoy no venía ningún camión de chips: el recorte de cuota ya se notaba ayer.
        if (r() < 0.45 && !(this.day === 0 && c === 'chip')) {
          const salio = SHIFT_START - r.range(0.1, 0.9) * sup.transito;
          this._camion({ tipo: q.tier === 1 ? 't2' : 't3', origen: sup, destino: q, insumo: c, n: sup.lote, salida: salio, llegada: salio + sup.transito });
        }
      }
    }
    for (const m of MODULOS) {
      const t1 = this.planta.get(m.t1);
      const salio = SHIFT_START - r.range(0.2, 0.8) * t1.transito;
      const s = this.seq[m.id];
      this._camion({ tipo: 't1', origen: t1, destino: null, modulo: m.id, n: LOTE_T1, desdeSeq: s.llegado, salida: salio, llegada: salio + t1.transito, prevista: salio + t1.transito });
    }
  }

  _camion(c) {
    this._idCam++;
    const cam = { id: `K${pad(this._idCam, 3)}`, estado: 'ruta', retraso: 0, prevista: c.prevista ?? c.llegada, ...c };
    this.camiones.push(cam);
    return cam;
  }

  // ---------------------------------------------------------------- bucle

  advance(minutes) {
    this.clock = Math.min((this.clock ?? this.t) + minutes, SHIFT_END);
    while (this.t + STEP <= this.clock + 1e-9) this._step(STEP);
  }

  get terminado() { return this.t >= SHIFT_END - 1e-9; }

  log(tipo, es, en, nivel = 'info', ref = null) {
    this.events.push({ t: this.t, tipo, es, en, nivel, ref, get texto() { return tx(this.es, this.en); } });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  _step(dt) {
    const t0 = this.t;
    this.t += dt;
    const t = this.t;
    this._incidencias(t);
    this._produccion(dt);
    this._reponer(t);
    this._llegadas(t);
    this._linea(t, dt);
    this._finDeLinea(t);
    if (Math.floor(t0 / 60) !== Math.floor(t / 60) || t >= SHIFT_END - 1e-9) this._snapshot();
    // Indicadores minuto a minuto: la media del histórico se compara al mismo minuto (mediaEn).
    if (Math.floor(t0) !== Math.floor(t)) this.serie.push({ t: Math.round(t), ...this.alMinuto() });
  }

  _incidencias(t) {
    for (const w of this.incidencias) {
      const p = this.planta.get(w.planta);
      if (!w.empezo && t >= w.desde) {
        w.empezo = true;
        if (w.tipo === 'cuota') {
          p.factor = w.factor;
          p.cuota = w.factor; // cuota del fabricante (p.factor es lo que llega en total, con el plan B incluido)
          this.log('suministro', `${p.es} (Tier 3): ${w.es}. Las centralitas de Tier 2 dependen de esos chips.`, `${p.en} (Tier 3): ${w.en}. Tier 2 control units depend on those chips.`, 'alerta', { kind: 'planta', id: p.id });
        } else if (w.tipo === 'alternativo') {
          p.factor = Math.min(1, p.factor + w.factor);
          p.alternativo = true;
          this.log('suministro', `Plan B: ${w.es} (cuota total ${Math.round(p.factor * 100)} %).`, `Plan B: ${w.en} (total allocation ${Math.round(p.factor * 100)}%).`, 'ok', { kind: 'planta', id: p.id });
        } else if (w.tipo === 'averia') {
          p.averia = w;
          this.log('averia', `${p.es} (Tier 2) para: ${w.es}, hasta las ${fmt(w.hasta)}`, `${p.en} (Tier 2) stops: ${w.en}, until ${fmt(w.hasta)}`, 'alerta', { kind: 'planta', id: p.id });
        } else if (w.tipo === 'retraso') {
          // Se retrasa la lanzadera de ese Tier 1 que va de camino (o la próxima que salga).
          w.pendiente = true;
        }
      }
      if (w.tipo === 'retraso' && w.pendiente) {
        const cam = this.camiones.find((k) => k.estado === 'ruta' && k.tipo === 't1' && k.origen === p);
        if (cam) {
          w.pendiente = false;
          cam.llegada += w.minutos;
          cam.incidencia = w;
          this._ordenarLanzaderas(cam.modulo);
          this.log('retraso', `Lanzadera de ${p.es} retenida (${w.es}): llegará unos ${w.minutos} min tarde`, `${p.en} shuttle held up (${w.en}): about ${w.minutos} min late`, 'alerta', { kind: 'camion', id: cam.id });
        }
      }
      if (w.empezo && !w.acabo && w.hasta != null && t >= w.hasta) {
        w.acabo = true;
        if (w.tipo === 'averia') {
          p.averia = null;
          this.log('averia', `${p.es} vuelve a producir`, `${p.en} is producing again`, 'ok', { kind: 'planta', id: p.id });
        }
      }
    }
  }

  _produccion(dt) {
    for (const p of this.plantas) {
      const cap = p.averia ? 0 : p.ritmo * p.factor * dt;
      if (p.tier === 3) {
        if (p.fg < p.capFg) { p.acc += cap; while (p.acc >= 1) { p.acc -= 1; p.fg++; p.hechoHoy++; } }
        continue;
      }
      if (p.tier === 2 && p.fg >= p.capFg) continue;
      if (p.tier === 1) {
        const s = this.seq[p.modulo];
        if (s.hecho - s.montado >= p.horizonte) continue;
      }
      p.acc += cap;
      let falta = null;
      while (p.acc >= 1) {
        falta = (p.usa || []).find((c) => p.inv[c] < 1) || null;
        if (falta) { p.acc = Math.min(p.acc, 1); break; }
        for (const c of p.usa) p.inv[c]--;
        p.acc -= 1;
        p.hechoHoy++;
        if (p.tier === 2) p.fg++;
        else this.seq[p.modulo].hecho++;
      }
      if (!falta && (p.usa || []).some((c) => p.inv[c] < 1)) falta = p.usa.find((c) => p.inv[c] < 1);
      // Aviso al quedarse sin insumo; el de vuelta, solo cuando lleva 30 min produciendo sin cortes
      // (con la cuota recortada para y arranca cada pocos minutos y llenaría el registro).
      const ref = { kind: 'planta', id: p.id };
      if (falta) {
        p.ultimaFalta = this.t;
        if (!p.avisada) {
          p.avisada = falta;
          this.log('rotura', `${p.es} (Tier ${p.tier}) se queda sin ${nomI(falta).es} y para`, `${p.en} (Tier ${p.tier}) runs out of ${nomI(falta).en} and stops`, 'alerta', ref);
        }
      } else if (p.avisada && this.t - p.ultimaFalta >= 30) {
        this.log('rotura', `${p.es} (Tier ${p.tier}) lleva 30 min produciendo sin cortes: ya tiene ${nomI(p.avisada).es}`, `${p.en} (Tier ${p.tier}) has run 30 min without stopping: supply of ${nomI(p.avisada).en} is back`, 'ok', ref);
        p.avisada = null;
      }
      p.falta = falta;
    }
  }

  enCamino(q, c) {
    let n = 0;
    for (const k of this.camiones) if (k.estado === 'ruta' && k.destino === q && k.insumo === c) n += k.n;
    return n;
  }

  // Cada cliente mira su posición (stock + en camino) de cada insumo; si baja del punto de pedido,
  // su proveedor manda un camión. Si el proveedor tiene poco, atiende primero al que menos cobertura tiene.
  _reponer(t) {
    for (const sup of this.plantas) {
      if (sup.tier === 1) continue;
      const pide = sup.clientes.map((q) => {
        const r = q.necesita;
        const pos = q.inv[sup.produce] + this.enCamino(q, sup.produce);
        return { q, r, pos, cob: q.inv[sup.produce] / r, rop: r * (sup.transito + 100) };
      }).filter((x) => x.pos < x.rop).sort((a, b) => a.cob - b.cob);
      for (const x of pide) {
        // Si al cliente se le acaba antes de que llegue un lote entero, sale lo que haya (con un mínimo).
        const urgente = x.cob < sup.transito + 30;
        const minimo = sup.lote * (urgente ? (sup.tier === 3 ? 0.25 : 0.15) : 0.35);
        if (sup.fg < minimo) continue;
        const n = Math.min(sup.lote, sup.fg);
        sup.fg -= n;
        const tr = sup.transito * (1 + this.rT.normal(0, 0.05));
        this._camion({ tipo: x.q.tier === 1 ? 't2' : 't3', origen: sup, destino: x.q, insumo: sup.produce, n, salida: t, llegada: t + tr, prevista: t + sup.transito });
      }
    }
    // Lanzaderas Tier 1 → línea: lote completo, o lo que haya si la línea va a quedarse sin ese módulo.
    for (const m of MODULOS) {
      const s = this.seq[m.id];
      const listos = s.hecho - s.enviado;
      const pie = s.llegado - s.montado + (s.enviado - s.llegado);
      const t1 = this.planta.get(m.t1);
      if ((listos >= LOTE_T1 && pie <= t1.objetivo) || (listos >= 3 && pie < 10)) {
        const n = Math.min(listos, LOTE_T1);
        const tr = t1.transito * (1 + this.rT.normal(0, 0.06));
        this._camion({ tipo: 't1', origen: t1, destino: null, modulo: m.id, n, desdeSeq: s.enviado, salida: t, llegada: t + tr, prevista: t + t1.transito });
        s.enviado += n;
        this._ordenarLanzaderas(m.id);
      }
    }
  }

  // Los módulos van en secuencia: una lanzadera no puede adelantar a la anterior del mismo módulo.
  _ordenarLanzaderas(mod) {
    const ls = this.camiones.filter((k) => k.estado === 'ruta' && k.modulo === mod).sort((a, b) => a.desdeSeq - b.desdeSeq);
    let prev = -Infinity;
    for (const k of ls) {
      if (k.llegada < prev + 0.5) k.llegada = prev + 0.5;
      prev = k.llegada;
    }
  }

  _llegadas(t) {
    for (const k of this.camiones) {
      if (k.estado !== 'ruta' || t < k.llegada) continue;
      k.estado = 'entregado';
      k.tEntrega = t;
      if (k.tipo === 't1') {
        this.seq[k.modulo].llegado += k.n;
        this.c.lanzaderas++;
        const tarde = t - k.prevista;
        if (tarde <= 5) this.c.lanzaderasATiempo++;
        this.c.retrasoMax = Math.max(this.c.retrasoMax, tarde);
        if (tarde > 15) {
          this.log('llegada', `Llega a línea la lanzadera de ${k.origen.es} con ${Math.round(tarde)} min de retraso`, `${k.origen.en} shuttle reaches the line ${Math.round(tarde)} min late`, 'info', { kind: 'planta', id: k.origen.id });
        }
      } else {
        k.destino.inv[k.insumo] += k.n;
      }
    }
    // Se conservan un rato los entregados (la escena los ve aparcar) y luego se olvidan.
    if (this.camiones.length > 60) this.camiones = this.camiones.filter((k) => k.estado === 'ruta' || t - k.tEntrega < 3);
  }

  cocheEn(estacion) {
    const n = this.head - 1 - estacion;
    return n >= 0 ? this.coches[n] : null;
  }

  _linea(t, dt) {
    if (!this.parada) this.timer += dt;
    if (this.timer < TAKT) return;
    this.timer = TAKT;
    // Para avanzar, en cada estación de módulo tiene que estar el módulo del coche que entra en ella.
    const faltan = MODULOS.filter((m) => this.seq[m.id].llegado <= this.head - m.estacion);
    if (faltan.length) {
      if (!this.parada) {
        this.parada = { desde: t, faltan: faltan.map((m) => m.id) };
        this.c.paros++;
        const m = faltan[0];
        this.log('paro', `Línea parada en S${pad(m.estacion + 1)}: falta el módulo de ${m.es.toLowerCase()} del coche que entra`, `Line stopped at S${pad(m.estacion + 1)}: the ${m.en.toLowerCase()} module for the incoming car is missing`, 'alerta', { kind: 'planta', id: m.t1 });
      } else {
        this.parada.faltan = faltan.map((m) => m.id);
      }
      this.c.paroMin += dt;
      this._h.paro += dt;
      for (const m of faltan) this.c.paroPor[m.id] += dt / faltan.length;
      return;
    }
    if (this.parada) {
      const dur = t - this.parada.desde;
      this.log('marcha', `La línea vuelve a arrancar tras ${Math.round(dur)} min parada`, `The line restarts after ${Math.round(dur)} min stopped`, 'ok', null);
      this.parada = null;
    }
    for (const m of MODULOS) this.seq[m.id].montado++;
    const sale = this.cocheEn(ESTACIONES - 1);
    this.head++;
    this.timer -= TAKT;
    const entra = this.coches[this.head - 1];
    if (entra) entra.tEntrada = t;
    if (sale) {
      sale.tSalida = t;
      sale.tPrueba = t + PRUEBA_MIN;
      this.eol.push(sale);
      this.c.montados++;
      this._h.coches++;
    }
  }

  _finDeLinea(t) {
    for (const car of [...this.eol]) {
      if (car.ok == null && t >= car.tPrueba) {
        this.c.probados++;
        if (this.rQ() < this.fpy) {
          car.ok = true;
          this.c.okPrimera++;
        } else {
          car.ok = false;
          car.retrabajo = t + this.rQ.range(20, 45);
          this.c.retrabajos++;
        }
      }
      if (car.ok === true || (car.ok === false && t >= car.retrabajo)) {
        car.tCampa = t;
        this.eol.splice(this.eol.indexOf(car), 1);
        this.campa.push(car);
      }
    }
    if (this.campa.length >= CARGA_PORTA) {
      const carga = this.campa.splice(0, CARGA_PORTA);
      for (const car of carga) car.tExpedido = t;
      this.c.expedidos += carga.length;
      const destino = carga[0].destino;
      this.portas.push({ t, destino, n: carga.length });
      if (this.portas.length > 6) this.portas.shift();
      // Reparto con varias paradas: se nombran los concesionarios a los que va.
      const destinos = [...new Set(carga.map((c) => c.destino))];
      const lista = destinos.length > 3 ? `${destinos.slice(0, 3).join(', ')}…` : destinos.join(', ');
      this.log('expedicion', `Sale un portavehículos con ${carga.length} coches para ${lista}`, `A car transporter leaves with ${carga.length} cars for ${lista}`, 'info', null);
    }
  }

  _snapshot() {
    const k = this.kpis();
    this.hourly.push({
      hora: Math.floor((this.t - 1e-6) / 60),
      coches: this._h.coches,
      paroHora: this._h.paro,
      plan: k.plan,
      paros: k.paros,
      cobertura: k.cobertura,
      otd1: k.otd1,
      fpy: k.fpy,
      riesgo: k.riesgo,
      montados: k.montados,
    });
    this._h = { coches: 0, paro: 0 };
  }

  // ---------------------------------------------------------------- lectura

  coberturaModulo(mid) {
    const s = this.seq[mid];
    return (s.llegado - s.montado) * TAKT;
  }

  // Minutos de consumo que cubre el stock de un insumo en una planta.
  coberturaInsumo(p, c) {
    return p.necesita > 0 ? p.inv[c] / p.necesita : Infinity;
  }

  insumosEnRiesgo(umbral = 60) {
    const out = [];
    for (const p of this.plantas) {
      for (const c of p.usa || []) {
        const cob = this.coberturaInsumo(p, c);
        if (cob < umbral) out.push({ p, c, cob, enCamino: this.enCamino(p, c) });
      }
    }
    return out.sort((a, b) => a.cob - b.cob);
  }

  alMinuto() {
    const c = this.c;
    const plan = this.planificados();
    return {
      montados: c.montados,
      paros: c.paroMin,
      plan: plan ? c.montados / plan : null,
      cobertura: Math.min(...MODULOS.map((m) => this.coberturaModulo(m.id))),
      riesgo: this.insumosEnRiesgo().length,
      otd1: c.lanzaderas ? c.lanzaderasATiempo / c.lanzaderas : null,
      fpy: c.probados ? c.okPrimera / c.probados : null,
    };
  }

  planificados() {
    return Math.max(0, Math.floor((this.t - SHIFT_START) / TAKT));
  }

  kpis() {
    const c = this.c;
    const plan = this.planificados();
    return {
      t: this.t,
      montados: c.montados,
      planificados: plan,
      plan: plan ? c.montados / plan : null,
      paros: c.paroMin,
      cobertura: Math.min(...MODULOS.map((m) => this.coberturaModulo(m.id))),
      otd1: c.lanzaderas ? c.lanzaderasATiempo / c.lanzaderas : null,
      fpy: c.probados ? c.okPrimera / c.probados : null,
      riesgo: this.insumosEnRiesgo().length,
      parada: !!this.parada,
      retrabajos: c.retrabajos,
      probados: c.probados,
      campa: this.campa.length,
      expedidos: c.expedidos,
      enRuta: this.camiones.filter((k) => k.estado === 'ruta').length,
    };
  }
}

// Cuota de un Tier 3 recortado, dicha igual en todas partes: la del fabricante y, con el plan B, lo que
// llega en total con el proveedor alternativo.
export function textoCuota(p) {
  const base = pct(p.cuota ?? p.factor, 0);
  return p.alternativo
    ? tx(`${base} + proveedor alternativo (${pct(p.factor, 0)} en total)`, `${base} + alternative supplier (${pct(p.factor, 0)} in total)`)
    : base;
}

export function runAutoDay(day, opts = {}) {
  const sim = new AutoSim({ ...opts, day });
  sim.advance(SHIFT_END - SHIFT_START);
  return sim;
}

export { mean };
