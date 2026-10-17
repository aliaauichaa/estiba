// Motor de la operativa de última milla: un turno (06:00–22:00) por pasos de 15 segundos.
//   camión del cliente → patio → muelle de entrada → cola de inducción → sorter → rampa de su
//   delegación → camión de la ola (09:00, 12:00, 15:00) → delegación → furgonetas → cliente final.
// Los bultos van en lotes («chunks») con un rango de identificadores: así se pueden seguir bultos
// concretos de punta a punta sin simular cada caja.

import { makeRng, hashSeed } from './rng.js';
import { tx } from '../i18n.js';
import { SHIFT_START, SHIFT_END, fmt, hm } from './engine.js';
import { CLIENTES, DELEGACIONES, OLAS, CONDUCTOR_MAX, FIN_REPARTO, INCIDENCIAS_HOY } from '../data/ultimamilla.js';

const STEP = 0.25;
const MUELLES = 6;
const DESCARGA = 22;          // bultos por minuto y muelle
const SORTER = 36;            // bultos por minuto
const LOTE = 25;              // bultos por lote (una jaula de la misma delegación)
const CAP_CAMION = 1800;      // bultos por camión de ola
const CARGA_FURGO = 30;       // minutos desde que llega el camión hasta que salen las furgonetas
const ACERCA = 20;            // minutos hasta la zona de reparto
const PREPARA = 70;           // minutos entre la cita del camión y la salida de su ola (descargar, clasificar, cargar)
const SEGUIDOS = 40;          // bultos de muestra para el seguimiento

const pad = (n, w = 2) => String(n).padStart(w, '0');
const mean = (s, n) => (n ? s / n : null);
// Hash entero de un bulto: decide si el cliente está ausente sin gastar números del generador.
const hashBulto = (g, day) => { let h = (g * 2654435761 + day * 97) >>> 0; h ^= h >>> 13; h = Math.imul(h, 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) % 1000; };

export class MillaSim {
  constructor(opts = {}) {
    this.day = opts.day ?? 0;
    this.variant = opts.variant ?? null; // 'refuerzo': segunda inducción manual + conductores de refuerzo
    const seed = (tag) => makeRng(hashSeed('estiba-milla-v1', this.day, tag));
    this.rIn = seed('entrada');
    this.rR = seed('reparto');
    this.rInc = seed('incid');
    this.rSeg = seed('seguidos');
    this.t = SHIFT_START;
    this.events = [];
    this.hourly = [];
    this.serie = [];
    this.c = {
      descargados: 0, clasificados: 0, cargados: 0, enOla: 0, arrastrados: 0, dwellSum: 0,
      conductorMin: 0, olasSalidas: 0,
    };
    this._h = { clasificados: 0 };
    this.olas = OLAS.map((o, i) => ({ i, salida: hm(o.hora), parte: o.conductores, salio: false }));
    this.fin = hm(FIN_REPARTO);
    this.g = 0;
    this._setupDelegaciones();
    this._setupIncidencias();
    this._setupCamiones();
    this._setupSeguidos();
    this.cola = [];          // cola de inducción (los de frío van delante)
    this.colaFrio = [];
    this.rampas = new Map(this.delegaciones.map((d) => [d.id, []]));
    this.lineas = [];        // camiones de ola
    this.rutas = [];         // rutas de reparto
    this.sorterParado = null;
    this._accSorter = 0;
  }

  // ---------------------------------------------------------------- preparación del día

  _setupDelegaciones() {
    this.delegaciones = DELEGACIONES.map((d) => ({
      ...d,
      get nombre() { return tx(d.es, d.en); },
      // Posición en el esquema: norte hacia el fondo; la distancia, comprimida.
      r: 50 + Math.sqrt(d.km) * 4.6,
      bajas: 0,
      refuerzo: 0,
      stock: [],
      recibidos: 0,
      rutasHoy: 0,
    }));
    this.deleg = new Map(this.delegaciones.map((d) => [d.id, d]));
    this.cuotas = [];
    let acc = 0;
    for (const d of this.delegaciones) { acc += d.cuota; this.cuotas.push(acc); }
  }

  _setupIncidencias() {
    const r = this.rInc;
    const out = [];
    if (this.day === 0) {
      for (const w of INCIDENCIAS_HOY) out.push({ ...w, desde: w.desde ? hm(w.desde) : null, hasta: w.hasta ? hm(w.hasta) : null });
    } else {
      if (r() < 0.25) { const desde = r.range(7 * 60, 13 * 60); out.push({ tipo: 'sorter', desde, hasta: desde + r.range(12, 30), es: 'microparada en el sorter', en: 'short sorter stop' }); }
      if (r() < 0.3) out.push({ tipo: 'retraso', cliente: r.pick(CLIENTES).id, minutos: Math.round(r.range(20, 55)), es: 'tráfico', en: 'traffic' });
      if (r() < 0.2) out.push({ tipo: 'bajas', delegacion: r.pick(DELEGACIONES).id, conductores: 1, es: 'conductor de baja', en: 'driver off sick' });
    }
    this.incidencias = out.map((w) => ({ ...w, empezo: false, acabo: false }));
    for (const w of this.incidencias) {
      if (w.tipo === 'bajas') this.deleg.get(w.delegacion).bajas += w.conductores;
    }
    if (this.variant === 'refuerzo') {
      const bajas = this.incidencias.find((w) => w.tipo === 'bajas');
      if (bajas) this.deleg.get(bajas.delegacion).refuerzo = bajas.conductores;
    }
  }

  _setupCamiones() {
    const r = this.rIn;
    // Horario tipo de llegada de cada cliente (la moda temprano, el frío antes de las 07:00).
    const HORARIO = { zara: ['05:50', '07:35', '11:10'], inditex: ['06:40', '10:20'], decathlon: ['07:10', '12:10'], gousto: ['06:20'], ecommerce: ['07:40', '09:30'] };
    this.camiones = [];
    let id = 0;
    for (const c of CLIENTES) {
      HORARIO[c.id].forEach((h, k) => {
        const n = Math.round((c.bultos / c.camiones) * (1 + r.normal(0, 0.06)));
        const eta = hm(h) + r.normal(0, 8);
        const lotes = [];
        let quedan = n;
        while (quedan > 0) {
          const q = Math.min(LOTE, quedan);
          const u = r() * this.cuotas[this.cuotas.length - 1];
          const di = this.cuotas.findIndex((x) => x >= u);
          lotes.push({ g0: this.g, n: q, cliente: c, hub: this.delegaciones[di].id, eta });
          this.g += q;
          quedan -= q;
        }
        id++;
        this.camiones.push({
          id: `E${pad(id)}`, cliente: c, n, lotes, eta, llegada: eta, k,
          get nombre() { return `${c.nombre}${c.camiones > 1 ? ` ${this.k + 1}` : ''}`; },
          estado: 'ruta', muelle: null, descargados: 0, acc: 0,
        });
      });
    }
    // Retrasos: el de hoy es del segundo camión de Zara; otros días, uno al azar del cliente.
    for (const w of this.incidencias.filter((x) => x.tipo === 'retraso')) {
      const cands = this.camiones.filter((t) => t.cliente.id === w.cliente);
      const cam = this.day === 0 ? cands[1] : cands[Math.floor(this.rInc() * cands.length)];
      cam.llegada += w.minutos;
      cam.incidencia = w;
    }
    this.camiones.sort((a, b) => a.llegada - b.llegada);
    this.patio = [];
    this.muelles = Array.from({ length: MUELLES }, (_, i) => ({ id: `M${i + 1}`, i, camion: null }));
    this.total = this.g;
  }

  _setupSeguidos() {
    const r = this.rSeg;
    this.seguidos = [];
    const usados = new Set();
    while (this.seguidos.length < SEGUIDOS) {
      const g = Math.floor(r() * this.total);
      if (usados.has(g)) continue;
      usados.add(g);
      let lote = null;
      let cam = null;
      for (const t of this.camiones) { lote = t.lotes.find((l) => g >= l.g0 && g < l.g0 + l.n); if (lote) { cam = t; break; } }
      this.seguidos.push({
        g,
        id: `${lote.cliente.pref}-${String(100000 + ((g * 7919 + this.day * 131) % 900000)).padStart(6, '0')}`,
        cliente: lote.cliente,
        hub: lote.hub,
        camion: cam,
        tDescarga: null, tSort: null, linea: null, ruta: null, parada: null, tEntrega: null, ausente: false,
      });
    }
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
    this._entrada(t, dt);
    this._sorter(t, dt);
    this._olas(t);
    this._delegaciones(t);
    this.c.conductorMin += this.conductoresEnRuta(t) * dt;
    if (Math.floor(t0 / 60) !== Math.floor(t / 60) || t >= SHIFT_END - 1e-9) this._snapshot();
    // Indicadores minuto a minuto: la media del histórico se compara al mismo minuto (mediaEn). El reparto,
    // por ejemplo, arranca a media mañana de golpe y la foto de la hora en punto se queda atrás.
    if (Math.floor(t0) !== Math.floor(t)) this.serie.push({ t: Math.round(t), ...this.alMinuto() });
  }

  _incidencias(t) {
    for (const w of this.incidencias) {
      if (w.tipo === 'bajas' && !w.empezo) {
        w.empezo = true;
        const d = this.deleg.get(w.delegacion);
        this.log('bajas', `${d.es}: ${w.conductores} ${w.es} hoy${d.refuerzo ? `; entran ${d.refuerzo} de refuerzo` : ''}`, `${d.en}: ${w.conductores} ${w.en} today${d.refuerzo ? `; ${d.refuerzo} standby drivers come in` : ''}`, 'alerta', { kind: 'hub', id: d.id });
      }
      if (w.tipo !== 'sorter') continue;
      if (!w.empezo && t >= w.desde) {
        w.empezo = true;
        this.sorterParado = w;
        this.log('sorter', `Sorter parado: ${w.es}${this.variant === 'refuerzo' ? '. Se abre una inducción manual (45 % del ritmo)' : ''}`, `Sorter stopped: ${w.en}${this.variant === 'refuerzo' ? '. A manual induction is opened (45% of the rate)' : ''}`, 'alerta', { view: 'sorter' });
      }
      if (w.empezo && !w.acabo && t >= w.hasta) {
        w.acabo = true;
        this.sorterParado = null;
        this.log('sorter', `El sorter vuelve a clasificar tras ${Math.round(w.hasta - w.desde)} min parado; hay ${this.pendientes()} bultos esperando`, `The sorter is back after ${Math.round(w.hasta - w.desde)} min down; ${this.pendientes()} parcels are waiting`, 'ok', { view: 'sorter' });
      }
    }
  }

  _entrada(t, dt) {
    for (const cam of this.camiones) {
      if (cam.estado === 'ruta' && t >= cam.llegada) {
        cam.estado = 'patio';
        cam.tPatio = t;
        this.patio.push(cam);
        const tarde = cam.llegada - cam.eta;
        // Los que llegaron antes de abrir no se anuncian uno a uno.
        if (cam.llegada > SHIFT_START) {
          this.log('llegada', `Llega el camión de ${cam.cliente.nombre} con ${cam.n} bultos${tarde > 15 ? `, ${Math.round(tarde)} min tarde` : ''}`, `${cam.cliente.nombre} truck arrives with ${cam.n} parcels${tarde > 15 ? `, ${Math.round(tarde)} min late` : ''}`, tarde > 30 ? 'alerta' : 'info', { kind: 'camion', id: cam.id });
        }
      }
    }
    for (const m of this.muelles) {
      if (!m.camion && this.patio.length) {
        const cam = this.patio.shift();
        m.camion = cam;
        cam.muelle = m;
        cam.estado = 'muelle';
        cam.tMuelle = t;
      }
      const cam = m.camion;
      if (!cam) continue;
      cam.acc += DESCARGA * dt;
      while (cam.lotes.length && cam.acc >= cam.lotes[0].n) {
        const l = cam.lotes.shift();
        cam.acc -= l.n;
        cam.descargados += l.n;
        this.c.descargados += l.n;
        const lote = { ...l, tDescarga: t, camion: cam.id };
        (l.cliente.frio ? this.colaFrio : this.cola).push(lote);
        this._marca(lote, (s) => { s.tDescarga = t; });
      }
      if (!cam.lotes.length) {
        cam.estado = 'fuera';
        cam.tFin = t;
        m.camion = null;
      }
    }
  }

  // Aplica fn a los bultos seguidos que caen en el lote.
  _marca(lote, fn) {
    for (const s of this.seguidos) if (s.g >= lote.g0 && s.g < lote.g0 + lote.n) fn(s);
  }

  _sorter(t, dt) {
    const ritmo = this.sorterParado ? (this.variant === 'refuerzo' ? SORTER * 0.45 : 0) : SORTER;
    this._accSorter += ritmo * dt;
    while (this._accSorter >= 1) {
      const q = this.colaFrio.length ? this.colaFrio : this.cola;
      const l = q[0];
      if (!l) { this._accSorter = Math.min(this._accSorter, 1); break; }
      const k = Math.min(l.n, Math.floor(this._accSorter));
      const parte = { ...l, n: k, tSort: t };
      this.rampas.get(l.hub).push(parte);
      this._marca(parte, (s) => { s.tSort = t; });
      this._accSorter -= k;
      this.c.clasificados += k;
      this._h.clasificados += k;
      if (k === l.n) q.shift();
      else { l.g0 += k; l.n -= k; }
    }
  }

  // Ola en la que debería salir un lote según la cita de su camión: la primera que deja tiempo para
  // descargar, clasificar y cargar. Si sale en una posterior es arrastre (por un retraso o un atasco).
  olaPrevista(eta) {
    const o = this.olas.find((x) => x.salida >= eta + PREPARA);
    return o ? o.i : this.olas.length;
  }

  _olas(t) {
    for (const ola of this.olas) {
      if (ola.salio || t < ola.salida) continue;
      ola.salio = true;
      this.c.olasSalidas++;
      for (const d of this.delegaciones) {
        const rampa = this.rampas.get(d.id);
        const carga = [];
        let n = 0;
        while (rampa.length && n + rampa[0].n <= CAP_CAMION) { const l = rampa.shift(); carga.push(l); n += l.n; }
        let tarde = 0;
        for (const l of carga) {
          if (l.arrastrado) tarde += l.n;
          else this.c.enOla += l.n;
          this.c.dwellSum += (t - l.tDescarga) * l.n;
        }
        this.c.cargados += n;
        const linea = {
          id: `L${ola.i + 1}-${d.id}`, ola: ola.i, hub: d, n, lotes: carga, salida: t,
          llegada: t + d.transito * (1 + this.rR.normal(0, 0.05)), estado: 'ruta', tarde,
        };
        this.lineas.push(linea);
        for (const l of carga) this._marca(l, (s) => { s.linea = linea; });
        // Lo que se queda en la rampa por haber llegado o clasificado tarde.
        const tocaba = (l) => l.hub === d.id && this.olaPrevista(l.eta) <= ola.i;
        const quedan = rampa.reduce((s, l) => s + l.n, 0)
          + this.cola.concat(this.colaFrio).filter(tocaba).reduce((s, l) => s + l.n, 0)
          + this.camiones.reduce((s, cam) => s + cam.lotes.filter(tocaba).reduce((a, l) => a + l.n, 0), 0);
        if (quedan > 150 || tarde > 150) {
          this.log('ola', `Sale el camión de la ola ${ola.i + 1} a ${d.es} con ${n} bultos; ${quedan > 150 ? `se quedan ${quedan} que tenían que ir en él` : `${tarde} venían de la ola anterior`}`, `Wave ${ola.i + 1} truck to ${d.en} leaves with ${n} parcels; ${quedan > 150 ? `${quedan} that should have been on it stay behind` : `${tarde} were carried over from the previous wave`}`, 'alerta', { kind: 'linea', id: linea.id });
        }
      }
      // Lo que tenía que ir en esta ola y no ha ido (sin clasificar, en el sorter o aún en su camión) es arrastre:
      // se cuenta ya, al salir la ola, no cuando sale en la siguiente.
      const marca = (l) => { if (!l.arrastrado && this.olaPrevista(l.eta) <= ola.i) { l.arrastrado = true; this.c.arrastrados += l.n; } };
      for (const r of this.rampas.values()) r.forEach(marca);
      this.cola.forEach(marca);
      this.colaFrio.forEach(marca);
      for (const cam of this.camiones) cam.lotes.forEach(marca);
      const total = this.lineas.filter((l) => l.ola === ola.i).reduce((s, l) => s + l.n, 0);
      this.log('ola', `Sale la ola ${ola.i + 1}: ${total} bultos hacia ${this.delegaciones.length} delegaciones`, `Wave ${ola.i + 1} leaves: ${total} parcels to ${this.delegaciones.length} depots`, 'info', { view: 'red' });
    }
  }

  conductoresDia(d) {
    return d.conductores - d.bajas + d.refuerzo;
  }

  _delegaciones(t) {
    for (const lin of this.lineas) {
      if (lin.estado === 'ruta' && t >= lin.llegada) {
        lin.estado = 'delegacion';
        lin.tDeleg = t;
        const d = lin.hub;
        d.stock.push(...lin.lotes);
        d.recibidos += lin.n;
        lin.salidaFurgos = t + CARGA_FURGO;
      }
      if (lin.estado === 'delegacion' && t >= lin.salidaFurgos) {
        lin.estado = 'repartida';
        this._repartir(lin.hub, lin.ola, t);
      }
    }
    // Al cierre del reparto, lo que queda en la delegación pasa a mañana.
    if (!this._cerrado && t >= this.fin) {
      this._cerrado = true;
      for (const d of this.delegaciones) {
        const quedan = this.sinRepartir(d, t);
        if (quedan > 40) this.log('cierre', `${d.es}: quedan ${quedan} bultos sin repartir; salen mañana`, `${d.en}: ${quedan} parcels left undelivered; they go out tomorrow`, 'alerta', { kind: 'hub', id: d.id });
      }
    }
  }

  // Las furgonetas de la ola salen con lo que haya en la delegación (frío primero en la ruta).
  _repartir(d, ola, t) {
    const n = Math.max(1, Math.round(this.conductoresDia(d) * this.olas[ola].parte));
    const stock = d.stock.splice(0);
    const total = stock.reduce((s, l) => s + l.n, 0);
    if (!total) return;
    stock.sort((a, b) => (b.cliente.frio ? 1 : 0) - (a.cliente.frio ? 1 : 0));
    const usados = Math.min(n, Math.ceil(total / 20));
    const porRuta = Math.min(CONDUCTOR_MAX, Math.ceil(total / usados));
    let lotes = stock;
    for (let i = 0; i < usados && lotes.length; i++) {
      const paso = this.rR.range(2.8, 3.4);
      const salida = t + this.rR.range(0, 6);
      // Lo que no da tiempo a repartir antes del cierre se queda en la delegación.
      const maxTiempo = Math.max(0, Math.floor((this.fin - salida - ACERCA) / paso));
      const cupo = Math.min(porRuta, maxTiempo);
      const carga = [];
      let c = 0;
      while (lotes.length && c < cupo) {
        const l = lotes[0];
        const k = Math.min(l.n, cupo - c);
        carga.push({ ...l, n: k });
        if (k === l.n) lotes.shift(); else lotes[0] = { ...l, g0: l.g0 + k, n: l.n - k };
        c += k;
      }
      if (!c) break;
      d.rutasHoy++;
      const ruta = { id: `${d.cod ?? d.id.slice(0, 3).toUpperCase()}-${pad(d.rutasHoy)}`, hub: d, ola, salida, paso, n: c, lotes: carga, fallos: new Uint16Array(c + 1) };
      // Ausencias decididas por bulto (5 %, 3 % en frío): prefijo acumulado para contar rápido.
      let j = 0;
      for (const l of carga) {
        for (let q = 0; q < l.n; q++) {
          const g = l.g0 + q;
          const fallo = hashBulto(g, this.day) < (l.cliente.frio ? 30 : 50);
          ruta.fallos[j + 1] = ruta.fallos[j] + (fallo ? 1 : 0);
          j++;
        }
      }
      let pos = 0;
      for (const l of carga) {
        this._marca(l, (s) => { s.ruta = ruta; s.parada = pos + (s.g - l.g0); s.tEntrega = salida + ACERCA + (s.parada + 1) * paso; s.ausente = hashBulto(s.g, this.day) < (l.cliente.frio ? 30 : 50); });
        pos += l.n;
      }
      ruta.fin = salida + ACERCA + c * paso;
      this.rutas.push(ruta);
    }
    if (lotes.length) d.stock.push(...lotes);
    const salen = this.rutas.filter((r) => r.hub === d && r.ola === ola);
    if (salen.length) {
      const n = salen.reduce((s, r) => s + r.n, 0);
      this.log('reparto', `${d.es}: ${salen.length === 1 ? 'sale 1 furgoneta' : `salen ${salen.length} furgonetas`} con ${n} bultos`, `${d.en}: ${salen.length === 1 ? '1 van heads out' : `${salen.length} vans head out`} with ${n} parcels`, 'info', { kind: 'hub', id: d.id });
    }
  }

  _snapshot() {
    const k = this.kpis();
    this.hourly.push({
      hora: Math.floor((this.t - 1e-6) / 60),
      clasificados: this._h.clasificados,
      clasificadosAcum: k.clasificados,
      corte: k.corte,
      enRuta: k.enRuta,
      pendientes: k.pendientes,
      dwell: k.dwell,
      entregados: k.entregados,
      primerIntento: k.primerIntento,
      productividad: k.productividad,
      recibidos: k.recibidos,
    });
    this._h = { clasificados: 0 };
  }

  // ---------------------------------------------------------------- lectura

  hechas(ruta, t = this.t) {
    return Math.max(0, Math.min(ruta.n, Math.floor((t - ruta.salida - ACERCA) / ruta.paso)));
  }

  estadoRuta(ruta, t = this.t) {
    const hechas = this.hechas(ruta, t);
    const fallos = ruta.fallos[hechas];
    return { hechas, entregados: hechas - fallos, fallos, enRuta: t >= ruta.salida && t < ruta.fin };
  }

  alMinuto() {
    const c = this.c;
    let entregados = 0;
    let fallos = 0;
    for (const r of this.rutas) { const e = this.estadoRuta(r); entregados += e.entregados; fallos += e.fallos; }
    const cargadosOla = c.enOla + c.arrastrados;
    return {
      entregados,
      clasificadosAcum: c.clasificados,
      enRuta: this.conductoresEnRuta(),
      pendientes: this.pendientes(),
      corte: cargadosOla ? c.enOla / cargadosOla : null,
      dwell: c.cargados ? c.dwellSum / c.cargados : null,
      primerIntento: entregados + fallos ? entregados / (entregados + fallos) : null,
    };
  }

  // Bultos de los camiones de ola que acaban de llegar a la delegación y se están cargando en las furgonetas.
  enCarga(d) {
    return this.lineas.filter((l) => l.hub === d && l.estado === 'delegacion').reduce((s, l) => s + l.n, 0);
  }

  conductoresEnRuta(t = this.t) {
    let n = 0;
    for (const r of this.rutas) if (t >= r.salida && t < r.fin) n++;
    return n;
  }

  pendientes() {
    let n = 0;
    for (const l of this.cola) n += l.n;
    for (const l of this.colaFrio) n += l.n;
    return n;
  }

  enRampa(id) {
    return this.rampas.get(id).reduce((s, l) => s + l.n, 0);
  }

  sinRepartir(d, t = this.t) {
    let n = d.stock.reduce((s, l) => s + l.n, 0);
    if (t >= this.fin) for (const r of this.rutas) if (r.hub === d) n += r.n - this.hechas(r, t);
    return n;
  }

  delegacion(d, t = this.t) {
    let entregados = 0;
    let fallos = 0;
    let enRuta = 0;
    let rutas = 0;
    for (const r of this.rutas) {
      if (r.hub !== d) continue;
      const e = this.estadoRuta(r, t);
      entregados += e.entregados;
      fallos += e.fallos;
      if (e.enRuta) { enRuta++; }
      rutas++;
    }
    const camino = this.lineas.filter((l) => l.hub === d && l.estado === 'ruta').reduce((s, l) => s + l.n, 0);
    return { entregados, fallos, enRuta, rutas, stock: d.stock.reduce((s, l) => s + l.n, 0), camino, rampa: this.enRampa(d.id), conductores: this.conductoresDia(d) };
  }

  kpis() {
    const c = this.c;
    let entregados = 0;
    let fallos = 0;
    for (const r of this.rutas) { const e = this.estadoRuta(r); entregados += e.entregados; fallos += e.fallos; }
    const cargadosOla = c.enOla + c.arrastrados;
    return {
      t: this.t,
      recibidos: c.descargados,
      clasificados: c.clasificados,
      pendientes: this.pendientes(),
      corte: cargadosOla ? c.enOla / cargadosOla : null,
      dwell: mean(c.dwellSum, c.cargados),
      entregados,
      fallos,
      cargados: c.cargados,
      primerIntento: entregados + fallos ? entregados / (entregados + fallos) : null,
      productividad: c.conductorMin > 30 ? (entregados + fallos) / (c.conductorMin / 60) : null,
      enRuta: this.conductoresEnRuta(),
      conductores: this.delegaciones.reduce((s, d) => s + this.conductoresDia(d), 0),
      arrastrados: c.arrastrados,
      sinRepartir: this.delegaciones.reduce((s, d) => s + this.sinRepartir(d), 0),
      total: this.total,
    };
  }
}

export function runMillaDay(day, opts = {}) {
  const sim = new MillaSim({ ...opts, day });
  sim.advance(SHIFT_END - SHIFT_START);
  return sim;
}
