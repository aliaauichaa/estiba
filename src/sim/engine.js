// Motor de simulación de un turno de almacén (06:00–22:00) por pasos de 15 segundos.
// Modela la cadena completa: camiones que llegan → patio → muelle → calle de recepción →
// carretilla ubica el palé → el stock queda disponible → pedidos que se preparan →
// ruta que sale a su hora. Así un problema en un eslabón se nota en los siguientes.

import { makeRng, hashSeed, cumulative } from './rng.js';
import {
  buildLayout, travel, routeNearest, routeAsListed, routeWaypoints, locationCost, LEVEL_PENALTY, DIM,
} from './layout.js';
import { FAMILIAS, TRANSPORTISTAS, PROVEEDORES } from '../data/sites.js';

export const SHIFT_START = 6 * 60;
export const SHIFT_END = 22 * 60;
const STEP = 0.25;
const UNLOAD_MIN = 1.1;       // minutos por palé que descarga el personal de muelle
const PRIORITY_WINDOW = 80;   // un pedido pasa a urgente si su ruta sale en menos de esto
const WAVE_HORIZON = 200;     // y solo se libera para preparar si sale en menos de esto
const AVG_LINES = 3.6;
const AVG_QTY = 6;

const pad = (n) => String(n).padStart(2, '0');
export const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
export const fmt = (t) => {
  const v = Math.max(0, Math.round(t));
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

export class Simulation {
  constructor(site, opts = {}) {
    this.site = site;
    this.day = opts.day ?? 0;
    this.slotting = opts.slotting ?? 'actual';
    this.routeMode = opts.routeMode ?? 'nn';
    const seed = (tag) => makeRng(hashSeed(site.seed, this.day, tag));
    this.rSku = seed('sku');
    this.rSlot = seed('slot');
    this.rStock = seed('stock');
    this.rOrd = seed('orders');
    this.rIn = seed('inbound');
    this.rInc = seed('incid');

    this.L = buildLayout(site);
    this.t = SHIFT_START;
    this.events = [];
    this.hourly = [];
    this.lanes = Object.fromEntries(this.L.inDocks.map((d) => [d.id, []]));
    this.yard = [];
    this.leaving = [];
    this.c = {
      lineasPick: 0, lineasCompletas: 0, cajas: 0, pedidosPreparados: 0,
      pedidosVencidos: 0, otifOk: 0, aTiempo: 0, completos: 0, retrasados: 0,
      palesUbicados: 0, palesRecibidos: 0, camionesDescargados: 0, sinHueco: 0,
      metrosPicking: 0, minutosBloqueoCalle: 0, minutosPicking: 0, cortasEnCalle: 0, cortas: 0,
    };
    this.dockToStock = [];
    this.esperas = [];
    this._h = this._newHour();

    this._setupSkus();
    this._setupLocations();
    this._setupRoutes();
    this._setupOrders();
    this._setupInbound();
    this._setupForklifts();
  }

  // ---------------------------------------------------------------- preparación del día

  _setupSkus() {
    const r = this.rSku;
    const n = this.site.skus;
    const raw = Array.from({ length: n }, (_, k) => 1 / Math.pow(k + 1, 0.9));
    const tot = raw.reduce((a, b) => a + b, 0);
    const dailyCases = this.site.pedidosDia * AVG_LINES * AVG_QTY;
    let acc = 0;
    this.skus = raw.map((w, k) => {
      const fam = r.pick(FAMILIAS);
      const share = w / tot;
      acc += share;
      return {
        idx: k,
        code: `${fam.pref}-${1000 + ((k * 7919) % 9000)}`,
        nombre: `${fam.nombre} · ${r.pick(fam.variantes)}`,
        familia: fam.nombre,
        share,
        demanda: share * dailyCases,
        upp: r.int(36, 72),
        cls: acc <= 0.8 ? 'A' : acc <= 0.95 ? 'B' : 'C',
        face: -1,
        locs: new Set(),
        lineas: 0,
        cortas: 0,
      };
    });
    this.skuCum = cumulative(raw);
  }

  _setupLocations() {
    const L = this.L;
    const locs = L.locations;
    const q = this.slotting === 'abc' ? 1 : this.site.calidadSlotting;
    const order = locs.map((l) => ({ l, cost: locationCost(L, l) })).sort((a, b) => a.cost - b.cost);
    order.forEach((o, i) => { o.key = q * (i / order.length) + (1 - q) * this.rSlot(); });
    order.sort((a, b) => a.key - b.key);
    for (const sku of this.skus) {
      const loc = order[sku.idx].l;
      loc.sku = sku.idx;
      loc.role = 'pick';
      sku.face = loc.idx;
      sku.locs.add(loc.idx);
    }

    // Stock inicial: entre 0,6 y 3,2 días de cobertura; algunas referencias casi agotadas.
    const r = this.rStock;
    const reserve = [];
    for (const sku of this.skus) {
      let cover = sku.cls === 'A' ? r.range(1.3, 3.2) : r.range(0.8, 3.2);
      if (r() < 0.02) cover = r.range(0, 0.25);
      // Toda referencia tiene al menos media caja-palé en su hueco de picking, salvo las casi agotadas.
      let units = Math.max(Math.round(cover * sku.demanda), Math.round(sku.upp * r.range(0.5, 1)));
      if (cover < 0.25) units = Math.round(cover * sku.demanda);
      const face = locs[sku.face];
      face.units = Math.min(sku.upp, units);
      units -= face.units;
      while (units > 0) {
        const u = Math.min(sku.upp, units);
        reserve.push({ sku: sku.idx, units: u });
        units -= u;
      }
    }
    r.shuffle(reserve);
    const free = r.shuffle(locs.filter((l) => l.sku === -1));
    const slots = Math.max(0, Math.round(locs.length * this.site.ocupacion) - this.skus.length);
    for (let i = 0; i < Math.min(slots, reserve.length, free.length); i++) {
      const loc = free[i];
      loc.sku = reserve[i].sku;
      loc.units = reserve[i].units;
      loc.role = 'reserva';
      this.skus[loc.sku].locs.add(loc.idx);
    }
  }

  _setupRoutes() {
    const out = this.L.outDocks;
    this.routes = this.site.rutas.map(([destino, s], i) => ({
      id: i,
      destino,
      salida: hm(s),
      corte: hm(s) - 40,
      llegaCamion: hm(s) - 110,
      dock: out[i % out.length],
      pedidos: [],
      camion: false,
      salio: false,
      expedidos: 0,
    }));
  }

  _setupOrders() {
    const r = this.rOrd;
    const n = Math.round(this.site.pedidosDia * (1 + r.normal(0, 0.05)));
    const orders = [];
    for (let k = 0; k < n; k++) {
      const release = r() < 0.1 ? r.range(5 * 60, 7 * 60) : r.range(7 * 60, 18.5 * 60);
      const route = this.routes.find((ro) => ro.corte >= release + 25);
      if (!route) continue;
      const nl = Math.min(12, 1 + r.poisson(AVG_LINES - 1));
      const seen = new Set();
      const lines = [];
      for (let i = 0; i < nl * 3 && lines.length < nl; i++) {
        const s = r.weighted(this.skuCum);
        if (seen.has(s)) continue;
        seen.add(s);
        lines.push({ sku: s, qty: 1 + r.poisson(AVG_QTY - 1), served: 0 });
      }
      orders.push({
        id: '',
        cliente: `Tienda ${route.destino.split(' ')[0]} ${pad(r.int(1, 48))}`,
        release,
        route,
        lines,
        estado: 'pendiente',
        cortas: 0,
        equipo: null,
        listo: null,
        aTiempo: null,
        completo: null,
      });
    }
    orders.sort((a, b) => a.route.salida - b.route.salida || a.release - b.release);
    orders.forEach((o, i) => { o.id = `P-${pad(this.day)}${String(i + 1).padStart(4, '0')}`; o.route.pedidos.push(o); });
    this.orders = orders;
    this.queue = orders.slice();
  }

  _setupInbound() {
    const r = this.rIn;
    const n = Math.max(4, this.site.camionesEntrada + r.int(-1, 1));
    const cases = this.orders.reduce((s, o) => s + o.lines.reduce((a, l) => a + l.qty, 0), 0);
    const avgUpp = this.skus.reduce((s, k) => s + k.upp * k.share, 0);
    const pallets = Math.round((cases / avgUpp) * (0.95 + r.normal(0, 0.05)));
    const letters = 'BCDFGHJKLMNPRSTVWXYZ';
    this.trucks = [];
    for (let i = 0; i < n; i++) {
      // Llegadas concentradas por la mañana, como suele pasar con los proveedores.
      const u = i / (n - 1);
      const eta = 6.25 * 60 + Math.pow(u, 1.25) * (17.5 - 6.25) * 60 + r.normal(0, 12);
      const pales = [];
      const count = Math.max(4, Math.round(pallets / n + r.normal(0, 2)));
      for (let k = 0; k < count; k++) {
        const s = r.weighted(this.skuCum);
        pales.push({ sku: s, units: this.skus[s].upp });
      }
      this.trucks.push({
        id: `T${pad(i + 1)}`,
        matricula: `${r.int(1000, 9999)} ${letters[r.int(0, 19)]}${letters[r.int(0, 19)]}${letters[r.int(0, 19)]}`,
        transportista: r.pick(TRANSPORTISTAS),
        proveedor: r.pick(PROVEEDORES),
        eta,
        llegada: eta + r.normal(4, 16),
        pales,
        estado: 'en_ruta',
        dock: null,
        descargados: 0,
        acc: 0,
        bloqueo: 0,
      });
    }
  }

  _setupForklifts() {
    const n = this.site.carretillas;
    const P = this.L.parking;
    this.forklifts = Array.from({ length: n }, (_, i) => {
      const x = P.x + (i - (n - 1) / 2) * 2.4;
      return {
        id: `C-${pad(i + 1)}`,
        idx: i,
        x, z: P.z, aisle: null,
        home: { x, z: P.z },
        task: null, track: null, endT: 0,
        lineas: 0, pedidos: 0, pales: 0, metros: 0,
        ocupado: 0, disponible: 0,
        taller: null, tallerPend: false, enTaller: false,
      };
    });
    const windows = [];
    if (this.day === 0) {
      for (const inc of this.site.incidenciasHoy) {
        if (inc.tipo !== 'taller') continue;
        for (let k = 0; k < inc.unidades; k++) {
          windows.push({ f: this.forklifts[n - 1 - k], desde: hm(inc.desde) + k * 6, hasta: hm(inc.hasta) - k * 10, motivo: inc.motivo });
        }
      }
    } else if (this.rInc() < 0.15) {
      const desde = this.rInc.range(8 * 60, 16 * 60);
      windows.push({ f: this.forklifts[this.rInc.int(0, n - 1)], desde, hasta: desde + this.rInc.range(60, 180), motivo: 'avería puntual' });
    }
    windows.sort((a, b) => a.f.idx - b.f.idx);
    for (const w of windows) w.f.taller = w;
    this.incidencias = windows;
  }

  // ---------------------------------------------------------------- bucle

  // Los pasos caen siempre en la misma rejilla de 15 s, así el resultado no depende de cómo se
  // trocee el avance (la escena avanza a saltos irregulares, el análisis de golpe).
  // `clock` es la hora mostrada, que puede ir hasta un paso por delante de `t`.
  advance(minutes) {
    this.clock = Math.min((this.clock ?? this.t) + minutes, SHIFT_END);
    while (this.t + STEP <= this.clock + 1e-9) this._step(STEP);
  }

  get terminado() { return this.t >= SHIFT_END - 1e-9; }

  _step(dt) {
    const t0 = this.t;
    this.t += dt;
    const t = this.t;
    this._incidents(t);
    this._inbound(t, dt);
    this._outbound(t);
    this._forkliftsStep(t);
    this._accumulate(dt);
    if (Math.floor(t0 / 60) !== Math.floor(t / 60) || t >= SHIFT_END - 1e-9) this._snapshot();
    if (this.leaving.length && this.leaving[0].t < t - 10) this.leaving = this.leaving.filter((x) => x.t >= t - 10);
  }

  log(tipo, texto, nivel = 'info') {
    this.events.push({ t: this.t, tipo, texto, nivel });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  _incidents(t) {
    for (const w of this.incidencias) {
      const f = w.f;
      if (!w.empezo && t >= w.desde) {
        w.empezo = true;
        f.tallerPend = true;
        this.log('taller', `${f.id} sale de servicio: ${w.motivo} (vuelve hacia las ${fmt(w.hasta)})`, 'alerta');
      }
      if (w.empezo && !w.acabo && t >= w.hasta) {
        w.acabo = true;
        f.tallerPend = false;
        if (f.enTaller) {
          f.enTaller = false;
          this.log('taller', `${f.id} vuelve a estar operativa`, 'ok');
        }
      }
    }
  }

  _inbound(t, dt) {
    for (const tr of this.trucks) {
      if (tr.estado === 'en_ruta' && t >= tr.llegada) {
        tr.estado = 'patio';
        tr.tPatio = t;
        this.yard.push(tr);
        const ret = tr.llegada - tr.eta;
        this.log('llegada', `${tr.matricula} (${tr.transportista}) llega al patio con ${tr.pales.length} palés${ret > 15 ? `, ${Math.round(ret)} min tarde` : ''}`);
      }
    }
    for (const d of this.L.inDocks) {
      if (!d.truck && this.yard.length) {
        const tr = this.yard.shift();
        d.truck = tr;
        tr.dock = d;
        tr.estado = 'muelle';
        tr.tMuelle = t;
        tr.espera = t - tr.tPatio;
        this.esperas.push(tr.espera);
        this.log('muelle', `${tr.matricula} atraca en ${d.id}${tr.espera > 20 ? ` tras ${Math.round(tr.espera)} min de espera` : ''}`, tr.espera > 45 ? 'alerta' : 'info');
      }
      const tr = d.truck;
      if (!tr) continue;
      const lane = this.lanes[d.id];
      if (lane.length >= this.site.capCalle) {
        tr.bloqueo += dt;
        this.c.minutosBloqueoCalle += dt;
      } else {
        tr.acc += dt;
        while (tr.acc >= UNLOAD_MIN && tr.descargados < tr.pales.length && lane.length < this.site.capCalle) {
          tr.acc -= UNLOAD_MIN;
          const p = tr.pales[tr.descargados++];
          lane.push({ ...p, dock: d, tMuelle: tr.tMuelle, tDescarga: t, camion: tr.matricula });
          this.c.palesRecibidos++;
        }
      }
      if (tr.descargados >= tr.pales.length) {
        tr.estado = 'fuera';
        tr.tFin = t;
        d.truck = null;
        this.c.camionesDescargados++;
        this.leaving.push({ truck: tr, dock: d, t });
        this.log('salida', `${tr.matricula} termina en ${d.id}: ${Math.round(t - tr.tMuelle)} min en muelle${tr.bloqueo > 5 ? `, ${Math.round(tr.bloqueo)} parado con la calle llena` : ''}`, tr.bloqueo > 20 ? 'alerta' : 'info');
      }
    }
  }

  _outbound(t) {
    for (const ro of this.routes) {
      if (!ro.camion && t >= ro.llegaCamion) {
        ro.camion = true;
        this.log('ruta', `Atraca el camión de la ruta ${ro.destino} en ${ro.dock.id} (sale a las ${fmt(ro.salida)})`);
      }
      if (!ro.salio && t >= ro.salida) {
        ro.salio = true;
        let ok = 0;
        for (const o of ro.pedidos) {
          this.c.pedidosVencidos++;
          if (o.estado === 'preparado') {
            o.estado = 'expedido';
            o.aTiempo = true;
            o.completo = o.cortas === 0;
            ok++;
            this.c.aTiempo++;
            if (o.completo) { this.c.completos++; this.c.otifOk++; }
          } else {
            o.retrasado = true;
            this.c.retrasados++;
          }
        }
        ro.expedidos = ok;
        const late = ro.pedidos.length - ok;
        this.log('ruta', `Sale la ruta ${ro.destino}: ${ok}/${ro.pedidos.length} pedidos${late ? `, ${late} se quedan en tierra` : ''}`, late > 0 ? 'alerta' : 'ok');
      }
    }
  }

  _forkliftsStep(t) {
    for (const f of this.forklifts) {
      if (f.task && t >= f.endT) this._complete(f, t);
      if (f.task) continue;
      if (f.enTaller) continue;
      if (f.tallerPend) { this._goTaller(f, t); continue; }
      this._dispatch(f, t);
    }
  }

  _dispatch(f, t) {
    let urgent = null;
    let any = null;
    for (const o of this.queue) {
      // Liberación por olas: solo se prepara lo que sale en las próximas horas.
      if (o.estado !== 'pendiente' || o.release > t || o.route.salida - t > WAVE_HORIZON) continue;
      if (!any) any = o;
      if (o.route.salida - t <= PRIORITY_WINDOW) { urgent = o; break; }
      if (any) break;
    }
    if (urgent) return this._startPick(f, urgent, t);
    const pal = this._nextPallet();
    if (pal) return this._startPutaway(f, pal.pal, pal.dest, t);
    if (any) return this._startPick(f, any, t);
    if (Math.abs(f.x - f.home.x) + Math.abs(f.z - f.home.z) > 0.5) this._move(f, t, f.home, 'aparcar');
  }

  _nextPallet() {
    let best = null;
    for (const d of this.L.inDocks) {
      for (const p of this.lanes[d.id]) {
        if (p.bloqueado && p.bloqueado > this.t - 5) continue;
        if (!best || p.tDescarga < best.tDescarga) best = p;
        break;
      }
    }
    if (!best) return null;
    const dest = this._findSlot(best);
    if (!dest) {
      if (!best.bloqueado) {
        this.c.sinHueco++;
        this.log('hueco', `Sin hueco libre para un palé de ${this.skus[best.sku].code} en ${best.dock.id}`, 'alerta');
      }
      best.bloqueado = this.t;
      return null;
    }
    return { pal: best, dest };
  }

  _findSlot(p) {
    const L = this.L;
    const face = L.locations[this.skus[p.sku].face];
    if (face.units === 0 && !face.reserved) return face;
    let best = null;
    let bd = Infinity;
    for (const loc of L.locations) {
      if (loc.sku !== -1 || loc.reserved) continue;
      const d = travel(L, p.dock.lane, loc.pick) + LEVEL_PENALTY[loc.level] * 0.5;
      if (d < bd) { bd = d; best = loc; }
    }
    return best;
  }

  _track(f, t, waypoints, dwells = new Map()) {
    const track = [{ x: f.x, z: f.z, t }];
    let tt = t;
    let dist = 0;
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      const d = Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
      dist += d;
      tt += d / DIM.SPEED;
      track.push({ x: b.x, z: b.z, t: tt, aisle: b.aisle });
      const w = dwells.get(b);
      if (w) { tt += w; track.push({ x: b.x, z: b.z, t: tt, aisle: b.aisle, stop: true }); }
    }
    return { track, end: tt, dist };
  }

  _here(f) { return { x: f.x, z: f.z, aisle: f.aisle }; }

  _move(f, t, dest, tipo) {
    const wp = routeWaypoints(this.L, this._here(f), [], dest);
    const { track, end } = this._track(f, t, wp);
    f.task = { tipo, dest };
    f.track = track;
    f.endT = end;
  }

  _goTaller(f, t) {
    f.tallerPend = false;
    this._move(f, t, this.L.taller, 'taller');
  }

  _startPick(f, o, t) {
    o.estado = 'en_curso';
    o.equipo = f.id;
    o.tInicio = t;
    const locs = this.L.locations;
    const stopsByLoc = new Map();
    for (const line of o.lines) {
      const sku = this.skus[line.sku];
      sku.lineas++;
      let need = line.qty;
      // Si el hueco de picking no basta, se tira primero del palé de reserva más vacío (libera huecos antes).
      const faceLoc = locs[sku.face];
      const reserves = [...sku.locs].filter((i) => i !== sku.face).sort((a, b) => locs[a].units - locs[b].units);
      const order = faceLoc.units >= need ? [sku.face] : [...reserves, sku.face];
      for (const li of order) {
        if (need <= 0) break;
        const loc = locs[li];
        if (loc.units <= 0) continue;
        const take = Math.min(need, loc.units);
        loc.units -= take;
        need -= take;
        line.served += take;
        loc.picks++;
        const s = stopsByLoc.get(li) || { loc, cajas: 0 };
        s.cajas += take;
        stopsByLoc.set(li, s);
        if (loc.units === 0 && loc.role === 'reserva') {
          loc.sku = -1;
          loc.role = null;
          sku.locs.delete(li);
        }
      }
      if (line.served < line.qty) {
        o.cortas++;
        sku.cortas++;
        this.c.cortas++;
        // ¿Había palés de esa referencia esperando en la calle de recepción sin ubicar?
        line.enCalle = Object.values(this.lanes).some((lane) => lane.some((p) => p.sku === line.sku));
        if (line.enCalle) this.c.cortasEnCalle++;
      }
    }
    const stops = [...stopsByLoc.values()];
    const end = { ...o.route.dock.lane };
    const pts = stops.map((s) => s.loc.pick);
    const route = (this.routeMode === 'lista' ? routeAsListed : routeNearest)(this.L, this._here(f), pts, end);
    const wp = routeWaypoints(this.L, this._here(f), route.seq, end);
    const dwells = new Map();
    for (const s of stops) dwells.set(s.loc.pick, 0.6 + 0.14 * s.cajas + 0.15 * s.loc.level);
    dwells.set(wp[wp.length - 1], 2.2); // flejar, etiquetar y dejar en la calle de su ruta
    const { track, end: endT, dist } = this._track(f, t, wp, dwells);
    f.task = { tipo: 'picking', pedido: o, paradas: stops.map((s) => s.loc.id), inicio: t };
    this.c.minutosPicking += endT - t;
    f.track = track;
    f.endT = endT;
    f.metros += dist;
    this.c.metrosPicking += dist;
    this.queue.splice(this.queue.indexOf(o), 1);
  }

  _startPutaway(f, p, dest, t) {
    const lane = this.lanes[p.dock.id];
    lane.splice(lane.indexOf(p), 1);
    dest.reserved = true;
    if (dest.sku === -1) { dest.sku = p.sku; dest.role = 'reserva'; }
    const lanePt = { ...p.dock.lane };
    const wp = routeWaypoints(this.L, this._here(f), [lanePt], dest.pick);
    const dwells = new Map([[lanePt, 0.5], [wp[wp.length - 1], 0.4 + 0.35 * dest.level]]);
    const { track, end, dist } = this._track(f, t, wp, dwells);
    f.task = { tipo: 'ubicacion', pal: p, dest };
    f.track = track;
    f.endT = end;
    f.metros += dist;
  }

  _complete(f, t) {
    const task = f.task;
    const last = f.track[f.track.length - 1];
    f.x = last.x;
    f.z = last.z;
    f.aisle = last.aisle ?? null;
    if (task.tipo === 'picking') {
      const o = task.pedido;
      const lines = o.lines.length;
      const full = o.lines.filter((l) => l.served >= l.qty).length;
      this.c.lineasPick += lines;
      this.c.lineasCompletas += full;
      this.c.cajas += o.lines.reduce((s, l) => s + l.served, 0);
      this.c.pedidosPreparados++;
      this._h.lineas += lines;
      f.lineas += lines;
      f.pedidos++;
      o.listo = t;
      if (o.route.salio) {
        o.estado = 'expedido';
        o.aTiempo = false;
        o.completo = o.cortas === 0;
      } else {
        o.estado = 'preparado';
      }
    } else if (task.tipo === 'ubicacion') {
      const { pal, dest } = task;
      dest.units += pal.units;
      dest.reserved = false;
      dest.sku = pal.sku;
      this.skus[pal.sku].locs.add(dest.idx);
      this.c.palesUbicados++;
      this._h.pales++;
      f.pales++;
      this.dockToStock.push(t - pal.tMuelle);
    } else if (task.tipo === 'taller') {
      f.enTaller = true;
    }
    f.task = null;
    f.track = null;
  }

  _accumulate(dt) {
    let disp = 0;
    for (const f of this.forklifts) {
      const fuera = f.enTaller || f.task?.tipo === 'taller';
      if (fuera) continue;
      disp++;
      f.disponible += dt;
      if (f.task && (f.task.tipo === 'picking' || f.task.tipo === 'ubicacion')) f.ocupado += dt;
    }
    const h = this._h;
    h.min += dt;
    h.equipos += disp * dt;
    h.patio += this.yard.length * dt;
    h.calle += this.lanePallets() * dt;
  }

  _newHour() { return { lineas: 0, pales: 0, min: 0, equipos: 0, patio: 0, calle: 0 }; }

  _snapshot() {
    const h = this._h;
    if (h.min <= 0) return;
    const k = this.kpis();
    this.hourly.push({
      hora: Math.floor((this.t - 1e-6) / 60),
      lineas: h.lineas,
      pales: h.pales,
      equipos: h.equipos / h.min,
      patio: h.patio / h.min,
      calle: h.calle / h.min,
      otif: k.otif,
      fill: k.fill,
      dts: k.dts,
      ocupacion: k.ocupacion,
      aTiempo: k.aTiempo,
      productividad: k.productividad,
      utilizacion: k.utilizacion,
      metrosLinea: k.metrosLinea,
      retrasados: this.c.retrasados,
      vencidos: this.c.pedidosVencidos,
      bloqueo: this.c.minutosBloqueoCalle,
    });
    this._h = this._newHour();
  }

  // ---------------------------------------------------------------- lectura

  lanePallets() {
    let n = 0;
    for (const id in this.lanes) n += this.lanes[id].length;
    return n;
  }

  freeLocations() {
    let n = 0;
    for (const l of this.L.locations) if (l.sku === -1 && !l.reserved) n++;
    return n;
  }

  kpis() {
    const c = this.c;
    const disp = this.forklifts.reduce((s, f) => s + f.disponible, 0);
    const ocup = this.forklifts.reduce((s, f) => s + f.ocupado, 0);
    const operativas = this.forklifts.filter((f) => !f.enTaller && f.task?.tipo !== 'taller').length;
    const pending = this.orders.filter((o) => o.estado === 'pendiente' && o.release <= this.t).length;
    return {
      t: this.t,
      otif: c.pedidosVencidos ? c.otifOk / c.pedidosVencidos : null,
      aTiempo: c.pedidosVencidos ? c.aTiempo / c.pedidosVencidos : null,
      fill: c.lineasPick ? c.lineasCompletas / c.lineasPick : null,
      dts: mean(this.dockToStock),
      ocupacion: 1 - this.freeLocations() / this.L.locations.length,
      productividad: disp > 0 ? c.lineasPick / (disp / 60) : null,
      utilizacion: disp > 0 ? ocup / disp : null,
      metrosLinea: c.lineasPick ? c.metrosPicking / c.lineasPick : null,
      patio: this.yard.length,
      esperaMedia: mean(this.esperas),
      calle: this.lanePallets(),
      operativas,
      totalCarretillas: this.forklifts.length,
      pendientes: pending,
      preparados: c.pedidosPreparados,
      pedidosVencidos: c.pedidosVencidos,
      retrasados: c.retrasados,
      lineas: c.lineasPick,
      palesUbicados: c.palesUbicados,
      palesRecibidos: c.palesRecibidos,
      sinHueco: c.sinHueco,
      bloqueoCalle: c.minutosBloqueoCalle,
    };
  }
}

// Posición interpolada de una carretilla en el instante t (para la escena 3D).
export function trackPos(track, t) {
  if (!track || !track.length) return null;
  if (t <= track[0].t) return { ...track[0], heading: null };
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    if (t <= b.t) {
      const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      const moving = a.x !== b.x || a.z !== b.z;
      return {
        x: a.x + (b.x - a.x) * k,
        z: a.z + (b.z - a.z) * k,
        heading: moving ? Math.atan2(b.x - a.x, b.z - a.z) : null,
        stop: !moving,
      };
    }
  }
  const last = track[track.length - 1];
  return { ...last, heading: null };
}

export function runDay(site, day, opts = {}) {
  const sim = new Simulation(site, { ...opts, day });
  sim.advance(SHIFT_END - SHIFT_START);
  return sim;
}
