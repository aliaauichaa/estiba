// Contenido 3D de la operativa de última milla: el cross-dock en el centro (muelles de entrada con los
// camiones de los clientes, el sorter y las rampas por delegación) y, alrededor, las delegaciones en
// un esquema por rumbo y distancia (no a escala), con sus furgonetas repartiendo y los puntos de
// entrega que se van marcando.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { std, disposeTree, progressLabel } from './stage.js';
import { CLIENTES } from '../data/ultimamilla.js';
import { fmt } from '../sim/engine.js';
import { tx, num } from '../i18n.js';

const W = 64;
const D = 30;
const COL = { teal: 0x2ec4b6, amber: 0xf5a524, red: 0xff6b5e, blue: 0x6c9cf0, green: 0x46c46f, gris: 0x3a4350 };
const PUNTOS = 46;           // puntos de entrega dibujados por delegación
const ANCHO = 1.4;           // el esquema se estira en horizontal y se achata en vertical para llenar la pantalla
const ALTO = 0.8;
const CAP = 1800;

export const MODES_MILLA = [
  { id: 'operativa', get nombre() { return tx('Operativa', 'Operations'); } },
  { id: 'clientes', get nombre() { return tx('Por cliente', 'By customer'); } },
];

function label(text, cls) {
  const el = document.createElement('div');
  el.className = `label3d ${cls}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

// Recorrido por una polilínea: posición y rumbo para una fracción 0…1 de su longitud.
function sobre(path, f) {
  const total = path.len;
  let d = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < path.pts.length; i++) {
    const a = path.pts[i - 1];
    const b = path.pts[i];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    if (d <= l || i === path.pts.length - 1) {
      const k = l ? Math.min(1, d / l) : 0;
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, rot: Math.atan2(b.x - a.x, b.z - a.z) };
    }
    d -= l;
  }
  return { x: path.pts[0].x, z: path.pts[0].z, rot: 0 };
}

function camino(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return { pts, len };
}

export class MillaScene {
  constructor() {
    this.mode = 'operativa';
    this.selected = null;
    this._m4 = new THREE.Matrix4();
    this._c = new THREE.Color();
  }

  get modes() { return MODES_MILLA; }

  get viewDir() { return new THREE.Vector3(0.05, 1.45, -1); }

  mount(stage) {
    this.stage = stage;
    this.root = new THREE.Group();
    stage.scene.add(this.root);
  }

  unmount() {
    for (const ch of [...this.root.children]) disposeTree(ch);
    this.root.clear();
    this.stage.scene.remove(this.root);
    this.sim = null;
  }

  load(sim) {
    this.sim = sim;
    this.selected = null;
    for (const ch of [...this.root.children]) disposeTree(ch);
    this.root.clear();
    this.hubs = new Map();
    this.camiones = new Map();
    this.lineas = new Map();
    this.textos = [];
    this.muellesSalida = new Map();
    this._cerca = undefined;
    // Posición de cada delegación: norte hacia el fondo; el este, a la derecha de la pantalla (x negativa).
    for (const d of sim.delegaciones) {
      const a = (d.rumbo * Math.PI) / 180;
      d.x = -Math.sin(a) * d.r * ANCHO;
      d.z = Math.cos(a) * d.r * ALTO;
    }
    this._suelo();
    this._crossdock();
    for (const d of sim.delegaciones) this._delegacion(d);
    this._furgonetas();
    this.update(0);
    this.refresh();
  }

  bounds() {
    let x0 = -W / 2; let x1 = W / 2; let z0 = -D / 2; let z1 = D / 2;
    for (const d of this.sim.delegaciones) { x0 = Math.min(x0, d.x - 18); x1 = Math.max(x1, d.x + 18); z0 = Math.min(z0, d.z - 18); z1 = Math.max(z1, d.z + 18); }
    return { min: { x: x0, y: 0, z: z0 }, max: { x: x1, y: 8, z: z1 } };
  }

  views() {
    const views = [
      { id: 'general', nombre: tx('General', 'Overview'), box: this.bounds() },
      { id: 'crossdock', nombre: 'Cross-dock', box: { min: { x: -W / 2 - 4, y: 0, z: -D / 2 - 14 }, max: { x: W / 2 + 4, y: 8, z: D / 2 + 28 } } },
      { id: 'entrada', nombre: tx('Patio de entrada', 'Inbound yard'), box: { min: { x: -W / 2, y: 0, z: D / 2 - 6 }, max: { x: W / 2, y: 5, z: D / 2 + 30 } } },
    ];
    const peor = this._peorDelegacion();
    if (peor) views.push({ id: `hub-${peor.id}`, nombre: peor.nombre, box: { min: { x: peor.x - 26, y: 0, z: peor.z - 26 }, max: { x: peor.x + 26, y: 4, z: peor.z + 26 } } });
    return views;
  }

  // La delegación que más preocupa (bajas o más sin repartir) tiene su propio encuadre.
  _peorDelegacion() {
    const sim = this.sim;
    if (!sim) return null;
    return sim.delegaciones.slice().sort((a, b) => (b.bajas - b.refuerzo) - (a.bajas - a.refuerzo) || sim.sinRepartir(b) - sim.sinRepartir(a))[0];
  }

  // ------------------------------------------------------------------ montaje

  _texto(fn, cls, x, y, z, detalle = false) {
    const o = label(fn(), cls);
    o.position.set(x, y, z);
    o.userData.fn = fn;
    o.userData.detalle = detalle;
    this.root.add(o);
    this.textos.push(o);
    return o;
  }

  relabel() {
    for (const o of this.textos) o.element.textContent = o.userData.fn();
  }

  _suelo() {
    const b = this.bounds();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(b.max.x - b.min.x + 60, b.max.z - b.min.z + 60), std(0x10151c, { roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((b.min.x + b.max.x) / 2, -0.08, (b.min.z + b.max.z) / 2);
    ground.receiveShadow = true;
    this.root.add(ground);
    // Anillos de distancia, muy tenues, para que se lea como un mapa esquemático.
    for (const r of [72, 92, 112]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.3, r + 0.3, 96), new THREE.MeshBasicMaterial({ color: 0x334052, transparent: true, opacity: 0.7 }));
      ring.rotation.x = -Math.PI / 2;
      ring.scale.set(ANCHO, ALTO, 1);
      ring.position.y = 0.01;
      this.root.add(ring);
    }
    this._texto(() => tx('N ↑ · esquema, no a escala', 'N ↑ · schematic, not to scale'), 'zone small', b.max.x - 34, 0.2, b.max.z - 8);
  }

  _crossdock() {
    const g = this.root;
    const sim = this.sim;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.3, D), std(0x1d2530, { roughness: 0.92 }));
    floor.position.y = -0.15;
    floor.receiveShadow = true;
    g.add(floor);
    const wallMat = std(0x2b3542, { transparent: true, opacity: 0.3, depthWrite: false });
    for (const [w, d, x, z] of [[W, 0.25, 0, D / 2], [W, 0.25, 0, -D / 2], [0.25, D, W / 2, 0], [0.25, D, -W / 2, 0]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 7, d), wallMat);
      m.position.set(x, 3.5, z);
      g.add(m);
    }
    this._texto(() => tx('CROSS-DOCK', 'CROSS-DOCK'), 'zone', 0, 0.2, D / 2 - 3);
    // Sorter: lazo ovalado con los bultos circulando (instancias).
    this.lazo = [];
    const R = 5;
    const L = 19;
    for (let i = 0; i <= 40; i++) this.lazo.push(new THREE.Vector3(-L + (2 * L * i) / 40, 0.6, R));
    for (let i = 1; i < 20; i++) { const a = Math.PI / 2 - (Math.PI * i) / 20; this.lazo.push(new THREE.Vector3(L + R * Math.cos(a), 0.6, R * Math.sin(a))); }
    for (let i = 0; i <= 40; i++) this.lazo.push(new THREE.Vector3(L - (2 * L * i) / 40, 0.6, -R));
    for (let i = 1; i < 20; i++) { const a = -Math.PI / 2 - (Math.PI * i) / 20; this.lazo.push(new THREE.Vector3(-L + R * Math.cos(a), 0.6, R * Math.sin(a))); }
    const cinta = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(this.lazo.map((p) => p.clone().setY(0.3)), true), 160, 0.8, 6, true), std(0x30394a, { metalness: 0.3, roughness: 0.5 }));
    g.add(cinta);
    this.cajas = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.6, 0.9), std(0xffffff, { roughness: 0.8 }), 70);
    this.cajas.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(70 * 3), 3);
    this.cajas.castShadow = true;
    g.add(this.cajas);
    this._fase = 0;
    this.luzSorter = new THREE.Mesh(new THREE.SphereGeometry(0.7, 14, 10), new THREE.MeshBasicMaterial({ color: COL.green }));
    this.luzSorter.position.set(0, 4.6, 0);
    g.add(this.luzSorter);
    const lab = label('', 'dock linea');
    lab.position.set(0, 6.5, 0);
    g.add(lab);
    this.labSorter = progressLabel(lab.element);
    this.labSorterEl = lab.element;
    // Bultos esperando a la inducción (pila que crece con la cola).
    this.pila = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.8, 1), std(0xc9a36b, { roughness: 0.9 }), 60);
    this.pila.castShadow = true;
    g.add(this.pila);
    // Muelles de entrada (lado norte, al fondo) y de salida por delegación (lado sur, delante).
    const frameMat = std(0x0f1318);
    for (let i = 0; i < 6; i++) {
      const x = -20 + i * 8;
      const top = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.35, 0.4), frameMat);
      top.position.set(x, 4.2, D / 2);
      g.add(top);
      this._texto(() => `M${i + 1}`, 'dock', x, 5, D / 2, true);
    }
    const n = sim.delegaciones.length;
    // Cada delegación sale por el muelle sur más cercano a su lado (oeste a la izquierda, este a la derecha).
    const orden = sim.delegaciones.slice().sort((a, b) => b.x - a.x);
    orden.forEach((d, i) => {
      const x = (W / 2 - 5) - (i * (W - 10)) / (n - 1);
      const top = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.35, 0.4), frameMat);
      top.position.set(x, 4.2, -D / 2);
      g.add(top);
      const jaulas = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1, 2.2), std(0xcfe7e3, { roughness: 0.8 }));
      jaulas.position.set(x, 0.5, -D / 2 + 3);
      jaulas.castShadow = true;
      g.add(jaulas);
      // Escalonadas en dos filas para que no se pisen.
      const lab = this._texto(() => d.nombre, 'dock mini', x, 0.2, -D / 2 + (i % 2 ? 9.5 : 6), true);
      this.muellesSalida.set(d.id, { x, jaulas, lab });
      // Camino del camión de la ola: sale al sur y rodea la nave si su delegación queda al norte.
      const pts = [{ x, z: -D / 2 - 7 }];
      if (d.z > -D / 2) {
        const lado = d.x >= 0 ? W / 2 + 12 : -W / 2 - 12;
        pts.push({ x: lado, z: -D / 2 - 7 }, { x: lado, z: Math.min(d.z, D / 2 + 12) });
      }
      pts.push({ x: d.x, z: d.z - 6 });
      d.path = camino(pts);
      const lineas = [];
      for (let k = 1; k < pts.length; k++) lineas.push(new THREE.Vector3(pts[k - 1].x, 0.02, pts[k - 1].z), new THREE.Vector3(pts[k].x, 0.02, pts[k].z));
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lineas), new THREE.LineBasicMaterial({ color: 0x7b8798, transparent: true, opacity: 0.8 })));
    });
    // Llegada de los clientes por el norte.
    const via = [new THREE.Vector3(0, 0.02, D / 2 + 40), new THREE.Vector3(0, 0.02, 160)];
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(via), new THREE.LineBasicMaterial({ color: 0x4a5563, transparent: true, opacity: 0.7 })));
    const patio = new THREE.Mesh(new THREE.BoxGeometry(W, 0.06, 26), std(0x161c24, { roughness: 1 }));
    patio.position.set(0, 0, D / 2 + 15);
    patio.receiveShadow = true;
    g.add(patio);
    this._texto(() => tx('PATIO DE ENTRADA · CLIENTES', 'INBOUND YARD · CUSTOMERS'), 'zone small', 0, 0.2, D / 2 + 27);
  }

  _delegacion(d) {
    const g = new THREE.Group();
    g.position.set(d.x, 0, d.z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(13, 5, 9), std(0x4a5768));
    body.position.y = 2.5;
    body.castShadow = body.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(13.4, 0.5, 9.4), std(COL.teal, { roughness: 0.6 }));
    roof.position.y = 5.25;
    g.add(body, roof);
    const lab = label('', 'hub');
    lab.position.set(0, 8.5, 0);
    g.add(lab);
    g.userData = { kind: 'hub', id: d.id };
    this.root.add(g);
    // Puntos de entrega alrededor: posiciones fijas por delegación.
    const pts = [];
    let s = d.id.split('').reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < PUNTOS; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 10 + rnd() * 9;
      pts.push({ x: d.x + Math.cos(a) * r, z: d.z + Math.sin(a) * r, orden: rnd() });
    }
    const orden = pts.slice().sort((a, b) => a.orden - b.orden);
    const casas = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, 0.9, 1.1), std(0xffffff, { roughness: 0.9 }), PUNTOS);
    casas.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PUNTOS * 3), 3);
    orden.forEach((p, i) => { this._m4.makeTranslation(p.x, 0.45, p.z); casas.setMatrixAt(i, this._m4); });
    casas.receiveShadow = true;
    this.root.add(casas);
    this.hubs.set(d.id, { g, roof, lab, set: progressLabel(lab.element), casas, pts: orden });
  }

  _furgonetas() {
    const max = 120;
    this.vans = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 1.4, 3), std(0xe7ebf1, { roughness: 0.5 }), max);
    this.vansTop = new THREE.InstancedMesh(new THREE.BoxGeometry(1.62, 0.2, 3.02), new THREE.MeshBasicMaterial({ color: COL.teal }), max);
    this.vans.castShadow = true;
    this.vans.count = 0;
    this.vansTop.count = 0;
    this.root.add(this.vans, this.vansTop);
    this.vanIds = [];
  }

  _camion(color, cls) {
    const g = new THREE.Group();
    const trailer = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.5, 8.5), std(0xd9dee6, { roughness: 0.6 }));
    trailer.position.set(0, 1.75, -1.2);
    const franja = new THREE.Mesh(new THREE.BoxGeometry(2.32, 0.4, 8.2), new THREE.MeshBasicMaterial({ color }));
    franja.position.set(0, 0.95, -1.2);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.3, 2), std(0x3d4a5c, { roughness: 0.45 }));
    cab.position.set(0, 1.45, 4.1);
    trailer.castShadow = cab.castShadow = true;
    g.add(trailer, franja, cab);
    const lab = label('', `dock ${cls}`);
    lab.position.set(0, 4, 0);
    g.add(lab);
    this.root.add(g);
    return { g, franja, lab, set: progressLabel(lab.element) };
  }

  // ------------------------------------------------------------------ actualización

  setMode(mode) {
    this.mode = mode;
    if (this.sim) this.refresh();
  }

  refresh() {
    const sim = this.sim;
    if (!sim) return;
    const t = sim.clock ?? sim.t;
    const porCliente = this.mode === 'clientes';
    // Delegaciones: etiqueta, color del tejado y puntos de entrega.
    const previsto = (d) => Math.max(1, Math.round(sim.total * d.cuota));
    for (const d of sim.delegaciones) {
      const o = this.hubs.get(d.id);
      const e = sim.delegacion(d, t);
      const sin = sim.sinRepartir(d, t);
      const faltan = d.bajas - d.refuerzo;
      const tone = faltan > 0 || (t >= sim.fin && sin > 40) ? 'bad' : 'teal';
      o.roof.material.color.setHex(tone === 'bad' ? COL.red : COL.teal);
      const conductores = `${e.enRuta}/${e.conductores} ${tx('en ruta', 'on route')}`;
      const corto = this.stage.el.clientWidth < 600;
      o.set(corto ? d.nombre : `${d.nombre} · ${conductores}${faltan > 0 ? ` · ${faltan} ${tx('de baja', 'off sick')}` : ''}`, e.entregados / previsto(d), tone);
      o.lab.element.classList.toggle('sel', this.selected?.kind === 'hub' && this.selected.id === d.id);
      const tot = previsto(d);
      const verdes = Math.round((e.entregados / tot) * PUNTOS);
      const rojos = Math.round(((e.fallos + (t >= sim.fin ? sin : 0)) / tot) * PUNTOS);
      for (let i = 0; i < PUNTOS; i++) {
        this._c.setHex(i < verdes ? COL.green : i < verdes + rojos ? COL.red : 0x5d6a7d);
        o.casas.setColorAt(i, this._c);
      }
      o.casas.instanceColor.needsUpdate = true;
      // Jaulas en la rampa de salida: su altura es lo que espera a la próxima ola.
      const m = this.muellesSalida.get(d.id);
      const rampa = sim.enRampa(d.id);
      m.jaulas.scale.y = 0.15 + Math.min(4, rampa / 120);
      m.jaulas.position.y = m.jaulas.scale.y / 2;
    }
    // Sorter.
    const pend = sim.pendientes();
    if (sim.sorterParado) {
      this.labSorter(`${tx('SORTER PARADO', 'SORTER DOWN')} · ${tx(sim.sorterParado.es, sim.sorterParado.en)} · ${pend} ${tx('en cola', 'queued')}`, null, 'bad');
    } else {
      this.labSorter(`SORTER · ${num(sim.c.clasificados)} ${tx('clasificados', 'sorted')}${pend ? ` · ${pend} ${tx('en cola', 'queued')}` : ''}`, Math.min(1, pend / 1500), pend > 600 ? 'warn' : 'teal');
    }
    this.labSorterEl.classList.toggle('bad', !!sim.sorterParado);
    this.luzSorter.material.color.setHex(sim.sorterParado ? COL.red : pend > 600 ? COL.amber : COL.green);
    const nPila = Math.min(60, Math.round(pend / 30));
    for (let i = 0; i < 60; i++) {
      if (i < nPila) this._m4.makeTranslation(-14 + (i % 10) * 1.15, 0.4 + Math.floor(i / 30) * 0.85, 9.5 + (Math.floor(i / 10) % 3) * 1.15);
      else this._m4.makeScale(0, 0, 0);
      this.pila.setMatrixAt(i, this._m4);
    }
    this.pila.instanceMatrix.needsUpdate = true;
    this.pila.computeBoundingSphere();
    this._porCliente = porCliente;
  }

  update(dt) {
    const sim = this.sim;
    if (!sim) return;
    const t = sim.clock ?? sim.t;
    this._sorter(dt);
    this._entrada(t);
    this._olas(t);
    this._reparto(t);
    const cerca = this.stage.camera.zoom > 2.2;
    if (cerca !== this._cerca) {
      this._cerca = cerca;
      this.root.traverse((o) => { if (o.isCSS2DObject && o.userData.detalle) o.visible = cerca; });
    }
  }

  // Los bultos del lazo avanzan si el sorter clasifica; su número sigue a la cola.
  _sorter(dt) {
    const sim = this.sim;
    const parado = !!sim.sorterParado;
    if (!parado) this._fase = (this._fase + dt * 0.035) % 1;
    const activos = sim.pendientes() > 0 || !parado ? 54 : 0;
    const n = this.lazo.length;
    const col = this._c;
    // Colores de los clientes en proporción a su volumen (modo «Por cliente»).
    const total = CLIENTES.reduce((s, c) => s + c.bultos, 0);
    for (let i = 0; i < 70; i++) {
      if (i >= activos) { this._m4.makeScale(0, 0, 0); this.cajas.setMatrixAt(i, this._m4); continue; }
      const f = (i / activos + this._fase) % 1;
      const p = this.lazo[Math.floor(f * n) % n];
      this._m4.makeTranslation(p.x, p.y + 0.35, p.z);
      this.cajas.setMatrixAt(i, this._m4);
      if (this._porCliente) {
        let u = ((i * 0.618) % 1) * total;
        let cli = CLIENTES[0];
        for (const c of CLIENTES) { u -= c.bultos; if (u <= 0) { cli = c; break; } }
        col.setHex(cli.color);
      } else col.setHex(parado ? 0x8a6a48 : 0xc9a36b);
      this.cajas.setColorAt(i, col);
    }
    this.cajas.instanceMatrix.needsUpdate = true;
    this.cajas.instanceColor.needsUpdate = true;
    this.cajas.computeBoundingSphere();
  }

  _entrada(t) {
    const sim = this.sim;
    const vivos = new Set();
    let enPatio = 0;
    for (const cam of sim.camiones) {
      let pos = null;
      if (cam.estado === 'ruta' && cam.llegada - t < 12) {
        const f = 1 - Math.max(0, cam.llegada - t) / 12;
        pos = { x: 4, z: 160 - (160 - (D / 2 + 30)) * f, rot: Math.PI };
      } else if (cam.estado === 'patio') {
        const i = enPatio++;
        pos = { x: 26 - (i % 6) * 6.5, z: D / 2 + 22 - Math.floor(i / 6) * 0 + (i >= 6 ? 6 : 0), rot: Math.PI };
      } else if (cam.estado === 'muelle') {
        pos = { x: -20 + cam.muelle.i * 8, z: D / 2 + 6.4, rot: Math.PI };
      } else if (cam.estado === 'fuera' && t - cam.tFin < 6) {
        const f = (t - cam.tFin) / 6;
        pos = { x: -1, z: D / 2 + 7 + f * 120, rot: 0 };
      }
      if (!pos) continue;
      vivos.add(cam.id);
      let o = this.camiones.get(cam.id);
      if (!o) {
        o = this._camion(cam.cliente.color, 'truck-in');
        o.g.userData = { kind: 'camion', id: cam.id };
        o.g.position.set(pos.x, 0, pos.z);
        this.camiones.set(cam.id, o);
      }
      o.g.position.x += (pos.x - o.g.position.x) * 0.2;
      o.g.position.z += (pos.z - o.g.position.z) * 0.2;
      o.g.rotation.y = pos.rot;
      const tarde = cam.llegada - cam.eta > 15;
      const sel = this.selected?.kind === 'camion' && this.selected.id === cam.id;
      o.set(cam.estado === 'muelle' ? `${cam.nombre} · ${cam.descargados}/${cam.n}` : `${cam.nombre}${tarde ? ` · +${Math.round(cam.llegada - cam.eta)}′` : ''}`, cam.estado === 'muelle' ? cam.descargados / cam.n : null, tarde ? 'bad' : 'blue');
      o.lab.element.classList.toggle('sel', sel);
    }
    for (const [id, o] of this.camiones) {
      if (vivos.has(id)) continue;
      disposeTree(o.g);
      this.root.remove(o.g);
      this.camiones.delete(id);
    }
  }

  // Camiones de ola: esperan en su muelle mientras se llena la rampa, viajan a la delegación y descargan.
  _olas(t) {
    const sim = this.sim;
    const vivos = new Set();
    const proxima = sim.olas.find((o) => !o.salio);
    for (const d of sim.delegaciones) {
      const m = this.muellesSalida.get(d.id);
      if (proxima && proxima.salida - t < 90) {
        const id = `espera-${d.id}`;
        vivos.add(id);
        let o = this.lineas.get(id);
        if (!o) { o = this._camion(COL.teal, 'truck-out'); o.g.userData = { kind: 'hub', id: d.id }; this.lineas.set(id, o); }
        o.g.position.set(m.x, 0, -D / 2 - 6.4);
        o.g.rotation.y = 0;
        const rampa = sim.enRampa(d.id);
        o.set(`${d.nombre} · ${tx('ola', 'wave')} ${proxima.i + 1} · ${fmt(proxima.salida)}`, Math.min(1, rampa / CAP), 'teal');
        o.lab.visible = this._cerca;
      }
    }
    for (const lin of sim.lineas) {
      let f = null;
      if (lin.estado === 'ruta') f = (t - lin.salida) / Math.max(1, lin.llegada - lin.salida);
      else if (t - lin.tDeleg < 25) f = 1;
      if (f == null) continue;
      vivos.add(lin.id);
      let o = this.lineas.get(lin.id);
      if (!o) { o = this._camion(COL.amber, 'truck-out'); o.g.userData = { kind: 'linea', id: lin.id }; this.lineas.set(lin.id, o); }
      const p = sobre(lin.hub.path, f);
      o.g.position.set(p.x, 0, p.z);
      o.g.rotation.y = p.rot;
      const sel = this.selected?.kind === 'linea' && this.selected.id === lin.id;
      o.set(`${lin.hub.nombre} · ${lin.n}`, lin.estado === 'ruta' ? f : null, lin.tarde > 150 ? 'warn' : 'teal');
      o.lab.element.classList.toggle('sel', sel);
    }
    for (const [id, o] of this.lineas) {
      if (vivos.has(id)) continue;
      disposeTree(o.g);
      this.root.remove(o.g);
      this.lineas.delete(id);
    }
  }

  // Furgonetas en ruta: dan vueltas por los puntos de entrega de su delegación.
  _reparto(t) {
    const sim = this.sim;
    let k = 0;
    this.vanIds = [];
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3(1, 1, 1);
    const v = new THREE.Vector3();
    for (const r of sim.rutas) {
      if (t < r.salida || t >= r.fin || k >= this.vans.instanceMatrix.count) continue;
      const o = this.hubs.get(r.hub.id);
      const pts = o.pts;
      const sem = r.id.charCodeAt(r.id.length - 1) + r.id.charCodeAt(r.id.length - 2) * 7;
      // Recorre los puntos en su orden, empezando por uno distinto cada furgoneta.
      const avance = (t - r.salida) / 9 + sem;
      const i = Math.floor(avance) % pts.length;
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const f = avance - Math.floor(avance);
      v.set(a.x + (b.x - a.x) * f, 0.7, a.z + (b.z - a.z) * f);
      e.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0);
      q.setFromEuler(e);
      this._m4.compose(v, q, s);
      this.vans.setMatrixAt(k, this._m4);
      v.y = 1.5;
      this._m4.compose(v, q, s);
      this.vansTop.setMatrixAt(k, this._m4);
      this.vanIds.push(r.id);
      k++;
    }
    this.vans.count = k;
    this.vansTop.count = k;
    this.vans.instanceMatrix.needsUpdate = true;
    this.vansTop.instanceMatrix.needsUpdate = true;
    this.vans.computeBoundingSphere();
    this.vansTop.computeBoundingSphere();
    this._vanPos = (id) => {
      const i = this.vanIds.indexOf(id);
      if (i < 0) return null;
      const m = new THREE.Matrix4();
      this.vans.getMatrixAt(i, m);
      return new THREE.Vector3().setFromMatrixPosition(m);
    };
  }

  select(sel) {
    this.selected = sel;
    if (this.sim) this.refresh();
  }

  focusOf(sel) {
    const sim = this.sim;
    if (!sim || !sel) return null;
    if (sel.kind === 'hub') {
      const o = this.hubs.get(sel.id);
      return o ? { pos: o.g.position, radius: 8, zoom: 3 } : null;
    }
    if (sel.kind === 'camion') {
      const o = this.camiones.get(sel.id);
      return o ? { pos: o.g.position, radius: 5.5, zoom: 3.4, follow: true } : null;
    }
    if (sel.kind === 'linea') {
      const o = this.lineas.get(sel.id);
      return o ? { pos: o.g.position, radius: 5.5, zoom: 3.2, follow: true } : null;
    }
    if (sel.kind === 'ruta') {
      const p = this._vanPos?.(sel.id);
      return p ? { pos: p, radius: 2.4, zoom: 4.5, follow: true } : null;
    }
    return null;
  }

  pick(raycaster) {
    if (!this.sim) return null;
    const grupos = [...[...this.hubs.values()].map((o) => o.g), ...[...this.camiones.values()].map((o) => o.g), ...[...this.lineas.values()].map((o) => o.g)];
    const hits = raycaster.intersectObjects([...grupos, this.vans], true);
    for (const h of hits) {
      if (h.object === this.vans && h.instanceId != null) return { kind: 'ruta', id: this.vanIds[h.instanceId] };
      let o = h.object;
      while (o && !o.userData?.kind) o = o.parent;
      if (o) return { kind: o.userData.kind, id: o.userData.id };
    }
    return null;
  }
}
