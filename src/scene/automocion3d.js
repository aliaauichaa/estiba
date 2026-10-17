// Contenido 3D de la operativa de automoción: la pirámide de proveedores vista como un embudo.
// Al fondo, en la franja más ancha, los Tier 3 (materias primas); delante, los Tier 2 y los Tier 1; en
// primer plano, la planta del fabricante con la línea de montaje, el banco de pruebas y la campa.
// Los camiones van por las carreteras que unen cada proveedor con su cliente.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { std, disposeTree, progressLabel } from './stage.js';
import { TAKT, ESTACIONES, MODULOS, INSUMOS } from '../data/automocion.js';
import { fmt } from '../sim/engine.js';
import { textoCuota } from '../sim/automocion.js';
import { tx, num, pct } from '../i18n.js';

const TIER_Z = { 3: 150, 2: 100, 1: 52 };
const TIER_SIZE = { 3: [22, 14, 8], 2: [18, 12, 6.5], 1: [14, 10, 5.5] };
const TIER_COL = { 3: 0x0e7490, 2: 0x0891b2, 1: 0x22d3ee };
const BANDA = { 3: [-132, 132], 2: [-98, 98], 1: [-72, 72] };
const X0 = -33;        // estación S01
const PASO = 6;        // metros entre estaciones
const Z_LINEA = 0;
const Z_MUELLE = 14;   // pared trasera de la planta: aquí descargan las lanzaderas
const CAMPA = { x0: 48.5, z0: -11, dx: 3.4, dz: 5.6, cols: 6 };

export const MODES_AUTO = [
  { id: 'flujo', get nombre() { return tx('Flujo', 'Flow'); } },
  { id: 'cobertura', get nombre() { return tx('Cobertura', 'Coverage'); } },
];

const T = {
  t3: () => tx('TIER 3 · MATERIAS PRIMAS', 'TIER 3 · RAW MATERIALS'),
  t2: () => tx('TIER 2 · COMPONENTES', 'TIER 2 · COMPONENTS'),
  t1: () => tx('TIER 1 · MÓDULOS EN SECUENCIA', 'TIER 1 · MODULES IN SEQUENCE'),
  oem: () => tx('MONTAJE FINAL · FABRICANTE (OEM)', 'FINAL ASSEMBLY · CARMAKER (OEM)'),
  campa: () => tx('CAMPA', 'CAR PARK'),
  carroceria: () => tx('← CARROCERÍA PINTADA', '← PAINTED BODIES'),
  pruebas: () => tx('BANCO DE PRUEBAS', 'END-OF-LINE TEST'),
  retrabajo: () => tx('RETRABAJO', 'REWORK'),
};

function label(text, cls) {
  const el = document.createElement('div');
  el.className = `label3d ${cls}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

const xEst = (s) => X0 + s * PASO;
const nomInsumo = (c) => tx(INSUMOS[c].es, INSUMOS[c].en);
const nomModulo = (id) => { const m = MODULOS.find((x) => x.id === id); return tx(m.es, m.en); };

export class AutoScene {
  constructor() {
    this.mode = 'flujo';
    this.selected = null;
    this._v = new THREE.Vector3();
    this._mats = new Map();
  }

  get modes() { return MODES_AUTO; }

  get viewDir() { return new THREE.Vector3(0.07, 1.25, -1); }

  mount(stage) {
    this.stage = stage;
    this.root = new THREE.Group();
    // Mirando de frente (hacia +z), la x del mundo crece hacia la izquierda de la pantalla. Se refleja el
    // contenido para que la línea avance de izquierda a derecha y los niveles se lean como en un esquema.
    this.root.scale.x = -1;
    stage.scene.add(this.root);
  }

  // Posición en el mundo de algo que está dentro del contenido reflejado.
  _mundo(p, y = p.y ?? 0) {
    return { x: -p.x, y, z: p.z };
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
    this._mats.clear();
    this._geos = null;
    this.plantas = new Map();
    this.trucks = new Map();
    this.cars = new Map();
    this.portas = new Map();
    this.textos = [];
    this.rotulosTier = [];
    this._cerca = undefined;
    this._suelo();
    this._carreteras();
    for (const p of sim.plantas) this._planta(p);
    // Las etiquetas de las plantas de un mismo tier se tapaban con nombres largos: la escena las separa.
    this.sinSolape = [...[...this.plantas.values()].map((o) => o.lab), ...this.rotulosTier];
    this._fabrica();
    this.update(0);
  }

  bounds() {
    return { min: { x: -136, y: 0, z: -20 }, max: { x: 136, y: 9, z: 162 } };
  }

  views() {
    return [
      { id: 'general', nombre: tx('General', 'Overview'), box: this.bounds() },
      { id: 'tiers', nombre: tx('Proveedores', 'Suppliers'), box: { min: { x: -136, y: 0, z: 40 }, max: { x: 136, y: 9, z: 162 } } },
      { id: 't1', nombre: 'Tier 1', box: { min: { x: -74, y: 0, z: 10 }, max: { x: 74, y: 6, z: 62 } } },
      { id: 'linea', nombre: tx('Línea de montaje', 'Assembly line'), box: { min: { x: -42, y: 0, z: -16 }, max: { x: 42, y: 6, z: 16 } } },
      { id: 'campa', nombre: tx('Campa', 'Car park'), box: { min: { x: -78, y: 0, z: -20 }, max: { x: -34, y: 4, z: 16 } } },
    ];
  }

  // ------------------------------------------------------------------ montaje

  _texto(fn, cls, x, y, z) {
    const o = label(fn(), cls);
    if (cls.includes('izq')) {
      const txt = fn;
      fn = () => txt();
      o.element.innerHTML = '<span></span>';
      o.element.firstChild.textContent = fn();
      o.userData.inner = true;
    }
    o.position.set(x, y, z);
    o.userData.fn = fn;
    this.root.add(o);
    this.textos.push(o);
    return o;
  }

  relabel() {
    for (const o of this.textos) (o.userData.inner ? o.element.firstChild : o.element).textContent = o.userData.fn();
  }

  _suelo() {
    const g = this.root;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(320, 230), std(0x10151c, { roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.08, 72);
    ground.receiveShadow = true;
    g.add(ground);
    // Franjas de cada nivel: más anchas cuanto más abajo en la pirámide (más proveedores).
    for (const tier of [3, 2, 1]) {
      const [x0, x1] = BANDA[tier];
      const z = TIER_Z[tier];
      const band = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.1, TIER_SIZE[tier][1] + 14), std(TIER_COL[tier], { roughness: 1, transparent: true, opacity: 0.16 }));
      band.position.set((x0 + x1) / 2, -0.03, z);
      band.receiveShadow = true;
      g.add(band);
      const rot = this._texto(T[`t${tier}`], 'zone tier izq', x0 + 3, 0.2, z - TIER_SIZE[tier][1] / 2 - 5.5);
      rot.element.style.color = `#${new THREE.Color(TIER_COL[tier]).getHexString()}`;
      // El rótulo del tier no se mueve ni se esconde (en móvil la leyenda no se ve y es lo único que nombra la
      // franja): son las etiquetas de planta las que se apartan para no pisarlo.
      Object.assign(rot.userData, { prioSolape: 1, cajaSolape: rot.element.firstChild });
      this.rotulosTier.push(rot);
    }
    const oem = new THREE.Mesh(new THREE.BoxGeometry(124, 0.1, 40), std(0xf5a524, { roughness: 1, transparent: true, opacity: 0.07 }));
    oem.position.set(18, -0.03, -1);
    g.add(oem);
    this._texto(T.oem, 'zone tier oem izq', -42, 0.2, -19);
  }

  _carreteras() {
    const sim = this.sim;
    const mat = std(0x232b36, { roughness: 1 });
    this.rutas = new Map();
    const add = (key, a, b) => {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      const road = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, len), mat);
      road.position.set((a.x + b.x) / 2, 0.01, (a.z + b.z) / 2);
      road.rotation.y = Math.atan2(dx, dz);
      road.receiveShadow = true;
      this.root.add(road);
      this.rutas.set(key, { a, b, len, heading: Math.atan2(dx, dz) });
    };
    for (const q of sim.plantas) {
      for (const c of q.usa || []) {
        const sup = sim.proveedorDe.get(c);
        add(`${sup.id}>${q.id}`, this._frente(sup), this._detras(q));
      }
    }
    for (const m of MODULOS) add(`${m.t1}>oem`, this._frente(sim.planta.get(m.t1)), { x: xEst(m.estacion), z: Z_MUELLE + 1 });
    // Salida de la campa hacia los concesionarios.
    add('campa>fuera', { x: 72, z: 14 }, { x: 72, z: -70 });
  }

  _frente(p) { return { x: p.x, z: TIER_Z[p.tier] - TIER_SIZE[p.tier][1] / 2 - 1 }; }
  _detras(p) { return { x: p.x, z: TIER_Z[p.tier] + TIER_SIZE[p.tier][1] / 2 + 1 }; }

  _planta(p) {
    const [w, d, h] = TIER_SIZE[p.tier];
    const g = new THREE.Group();
    g.position.set(p.x, 0, TIER_Z[p.tier]);
    const bodyMat = std(0x2a3442, { roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
    body.position.y = h / 2;
    body.castShadow = body.receiveShadow = true;
    const roofMat = std(TIER_COL[p.tier], { roughness: 0.6 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.5, d + 0.4), roofMat);
    roof.position.y = h + 0.25;
    roof.castShadow = true;
    g.add(body, roof);
    // Dientes de sierra en Tier 2 y chimenea en las de materia prima pesada: se distinguen de un vistazo.
    if (p.tier === 2) {
      for (let i = -1; i <= 1; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(w * 0.28, 1.4, d * 0.9), roofMat);
        s.position.set(i * w * 0.32, h + 1, 0);
        s.rotation.z = 0.35;
        g.add(s);
      }
    }
    if (p.tier === 3 && (p.produce === 'acero' || p.produce === 'granza')) {
      const ch = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 9, 12), std(0x4a5563));
      ch.position.set(w * 0.32, h + 4.5, -d * 0.2);
      ch.castShadow = true;
      g.add(ch);
    }
    // Muelle de salida hacia el cliente.
    const dock = new THREE.Mesh(new THREE.BoxGeometry(4, 3.4, 0.3), std(0x0f1318));
    dock.position.set(0, 1.7, -d / 2 - 0.05);
    g.add(dock);
    const luz = new THREE.Mesh(new THREE.SphereGeometry(0.7, 14, 10), new THREE.MeshBasicMaterial({ color: 0x46c46f }));
    luz.position.set(-w / 2 + 1.4, h + 1.2, -d / 2 + 1.4);
    g.add(luz);
    const lab = label('', 'planta');
    lab.position.set(0, h + 4.5, 0);
    g.add(lab);
    g.userData = { kind: 'planta', id: p.id };
    this.root.add(g);
    this.plantas.set(p.id, { g, body, roof, luz, lab, set: progressLabel(lab.element), w, d, h });
  }

  _fabrica() {
    const g = this.root;
    const W = 80;
    const D = 28;
    const H = 8;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.3, D), std(0x1d2530, { roughness: 0.92 }));
    floor.position.set(0, -0.15, 0);
    floor.receiveShadow = true;
    g.add(floor);
    const wallMat = std(0x2b3542, { transparent: true, opacity: 0.32, depthWrite: false });
    const back = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.25), wallMat);
    back.position.set(0, H / 2, Z_MUELLE);
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.25, H, D), wallMat);
    left.position.set(-W / 2, H / 2, 0);
    const right = left.clone();
    right.position.x = W / 2;
    g.add(back, left, right);
    // Transportador de la línea y marcas de estación.
    const conv = new THREE.Mesh(new THREE.BoxGeometry(xEst(ESTACIONES - 1) - xEst(0) + 8, 0.18, 3.4), std(0x30394a, { metalness: 0.3, roughness: 0.5 }));
    conv.position.set(0, 0.09, Z_LINEA);
    conv.receiveShadow = true;
    g.add(conv);
    const bordes = [];
    const xa = xEst(0) - 4;
    const xb = xEst(ESTACIONES - 1) + 4;
    for (const z of [Z_LINEA - 1.8, Z_LINEA + 1.8]) bordes.push(new THREE.Vector3(xa, 0.2, z), new THREE.Vector3(xb, 0.2, z));
    for (let s = 0; s <= ESTACIONES; s++) {
      const x = xEst(s) - PASO / 2;
      bordes.push(new THREE.Vector3(x, 0.2, Z_LINEA - 1.8), new THREE.Vector3(x, 0.2, Z_LINEA + 1.8));
    }
    this.bordes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(bordes), new THREE.LineBasicMaterial({ color: 0xf5a524, transparent: true, opacity: 0.55 }));
    g.add(this.bordes);
    for (let s = 0; s < ESTACIONES; s++) {
      const m = MODULOS.find((x) => x.estacion === s);
      const o = label(m ? `S${String(s + 1).padStart(2, '0')} · ${tx(m.es, m.en).toUpperCase()}` : `S${String(s + 1).padStart(2, '0')}`, m ? 'aisle est' : 'aisle est dim');
      o.position.set(xEst(s), 0.2, Z_LINEA - 3.2);
      o.userData.detalle = true;
      if (m) o.userData.fn = () => `S${String(s + 1).padStart(2, '0')} · ${tx(m.es, m.en).toUpperCase()}`;
      g.add(o);
      if (m) this.textos.push(o);
    }
    // Estanterías a pie de línea con las cajas de cada módulo (instancias) y su andon.
    const cajas = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, 0.8, 1.1), std(0xffffff, { roughness: 0.85 }), MODULOS.length * 24);
    cajas.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MODULOS.length * 24 * 3), 3);
    cajas.castShadow = true;
    this.cajas = cajas;
    g.add(cajas);
    this.andon = new Map();
    for (const m of MODULOS) {
      const x = xEst(m.estacion);
      const rack = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.12, 2.8), std(0xd9822b, { metalness: 0.2 }));
      rack.position.set(x, 0.06, 5);
      g.add(rack);
      const poste = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.2, 8), std(0x4a5b70));
      poste.position.set(x + 2.6, 2.1, 3.2);
      const luz = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), new THREE.MeshBasicMaterial({ color: 0x46c46f }));
      luz.position.set(x + 2.6, 4.4, 3.2);
      g.add(poste, luz);
      const lab = label('', 'dock buf');
      lab.position.set(x, 4.2, 5);
      lab.userData.detalle = true;
      g.add(lab);
      this.andon.set(m.id, { luz, set: progressLabel(lab.element) });
    }
    for (const o of [this._texto(T.carroceria, 'zone small', xEst(0) - 1, 0.2, Z_LINEA + 4.2), this._texto(T.pruebas, 'zone small', 37, 0.2, 5.2), this._texto(T.retrabajo, 'zone small', 37, 0.2, -12.5)]) o.userData.detalle = true;
    this._texto(T.campa, 'zone', 60, 0.2, -16.5);
    const campa = new THREE.Mesh(new THREE.BoxGeometry(26, 0.06, 30), std(0x161c24, { roughness: 1 }));
    campa.position.set(57, 0, -1);
    campa.receiveShadow = true;
    g.add(campa);
    const lineas = [];
    for (let c = 0; c <= CAMPA.cols; c++) {
      const x = CAMPA.x0 - CAMPA.dx / 2 + c * CAMPA.dx;
      lineas.push(new THREE.Vector3(x, 0.05, -14), new THREE.Vector3(x, 0.05, 13));
    }
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lineas), new THREE.LineBasicMaterial({ color: 0x8d99ab, transparent: true, opacity: 0.3 })));
    // Estado de la línea, encima del transportador.
    const st = label('', 'dock linea');
    st.position.set(0, 7.5, Z_LINEA);
    g.add(st);
    this.estadoLinea = progressLabel(st.element);
    this.estadoEl = st.element;
  }

  // ------------------------------------------------------------------ modelos

  _mat(hex, extra = {}) {
    const key = `${hex}-${extra.roughness ?? ''}`;
    if (!this._mats.has(key)) this._mats.set(key, std(hex, { roughness: 0.4, metalness: 0.25, ...extra }));
    return this._mats.get(key);
  }

  _coche(car) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this._geo('body', () => new THREE.BoxGeometry(1.9, 0.55, 4.3)), this._mat(car.color.hex));
    body.position.y = 0.55;
    const cab = new THREE.Mesh(this._geo('cab', () => new THREE.BoxGeometry(1.6, 0.5, 2.2)), this._mat(0x1a2230, { roughness: 0.15 }));
    cab.position.set(0, 1.05, -0.2);
    body.castShadow = cab.castShadow = true;
    g.add(body, cab);
    const rueda = this._geo('rueda', () => new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12));
    for (const [x, z] of [[-0.95, 1.35], [0.95, 1.35], [-0.95, -1.35], [0.95, -1.35]]) {
      const w = new THREE.Mesh(rueda, this._mat(0x14181e));
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.34, z);
      g.add(w);
    }
    g.userData = { kind: 'coche', id: car.id };
    this.root.add(g);
    return { g };
  }

  _geo(key, make) {
    this._geos ??= new Map();
    if (!this._geos.has(key)) this._geos.set(key, make());
    return this._geos.get(key);
  }

  _camion(k) {
    const g = new THREE.Group();
    const color = k.tipo === 't1' ? 0xf5a524 : k.tipo === 't2' ? 0x22d3ee : 0x0e7490;
    const trailer = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.5, 8.5), std(k.tipo === 't3' ? 0x5a6472 : 0xd9dee6, { roughness: 0.6 }));
    trailer.position.set(0, 1.75, -1.2);
    const franja = new THREE.Mesh(new THREE.BoxGeometry(2.32, 0.25, 8.2), new THREE.MeshBasicMaterial({ color }));
    franja.position.set(0, 0.9, -1.2);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.3, 2), std(0x3d4a5c, { roughness: 0.45 }));
    cab.position.set(0, 1.45, 4.1);
    trailer.castShadow = cab.castShadow = true;
    g.add(trailer, franja, cab);
    const lab = label('', 'dock truck-in');
    lab.position.set(0, 4, 0);
    g.add(lab);
    g.userData = { kind: 'camion', id: k.id };
    this.root.add(g);
    // Con la vista alejada solo llevan etiqueta las lanzaderas JIT (las que paran la línea si fallan).
    return { g, lab, set: progressLabel(lab.element), principal: k.tipo === 't1' };
  }

  _porta() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.3, 12), std(0x3a4350, { metalness: 0.4 }));
    base.position.y = 1;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.4, 2), std(0xe7ebf1, { roughness: 0.45 }));
    cab.position.set(0, 1.5, 6.6);
    g.add(base, cab);
    for (let i = 0; i < 3; i++) {
      for (const y of [1.6, 3]) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.9, 3.4), std([0xe8eaed, 0x7b828c, 0x2f5fa8][(i + (y > 2 ? 1 : 0)) % 3]));
        c.position.set(0, y, -4 + i * 3.8);
        g.add(c);
      }
    }
    this.root.add(g);
    return { g };
  }

  // ------------------------------------------------------------------ actualización

  setMode(mode) {
    this.mode = mode;
    if (this.sim) this.refresh();
  }

  // Colores y etiquetas que no hace falta tocar en cada fotograma.
  refresh() {
    const sim = this.sim;
    if (!sim) return;
    const cob = this.mode === 'cobertura';
    // En pantallas estrechas las etiquetas llevan solo el nombre (la barra ya dice la cobertura).
    const corto = this.stage.el.clientWidth < 600;
    for (const p of sim.plantas) {
      const o = this.plantas.get(p.id);
      let estado = 'ok';
      if (p.averia || p.falta) estado = 'bad';
      else if (p.cuota != null) estado = 'warn';
      o.luz.material.color.setHex(estado === 'bad' ? 0xff6b5e : estado === 'warn' ? 0xf5a524 : 0x46c46f);
      // Cobertura del insumo más justo (minutos de consumo), o la cuota si es Tier 3.
      let peor = Infinity;
      for (const c of p.usa || []) peor = Math.min(peor, sim.coberturaInsumo(p, c));
      let tone = '';
      if (cob) {
        const hex = p.tier === 3 ? (p.cuota != null ? 0xff6b5e : 0x46c46f) : peor < 60 ? 0xff6b5e : peor < 150 ? 0xf5a524 : 0x46c46f;
        o.roof.material.color.setHex(hex);
      } else {
        o.roof.material.color.setHex(TIER_COL[p.tier]);
      }
      let texto;
      let frac;
      if (p.tier === 3) {
        texto = `${p.nombre}${p.cuota != null ? ` · ${tx('cuota', 'allocation')} ${textoCuota(p)}` : ''}`;
        frac = p.fg / p.capFg;
        tone = p.cuota != null ? 'bad' : 'teal';
      } else {
        const falta = p.averia ? tx('avería', 'breakdown') : p.falta ? `${tx('sin', 'no')} ${nomInsumo(p.falta)}` : `${num(peor)} min`;
        texto = `${p.nombre} · ${falta}`;
        frac = Math.min(1, peor / 240);
        tone = peor < 60 || p.falta || p.averia ? 'bad' : peor < 150 ? 'warn' : 'teal';
      }
      o.set(corto ? p.nombre : texto, frac, tone);
      o.lab.element.classList.toggle('sel', this.selected?.kind === 'planta' && this.selected.id === p.id);
    }
    // Cajas a pie de línea: una por módulo en estantería (hasta 24 por estación).
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    let i = 0;
    for (const m of MODULOS) {
      const s = sim.seq[m.id];
      const n = Math.max(0, Math.min(24, s.llegado - s.montado));
      const x = xEst(m.estacion);
      const t1 = sim.planta.get(m.t1);
      col.setHex(TIER_COL[1]);
      for (let k = 0; k < 24; k++) {
        if (k < n) {
          const cx = (k % 3) - 1;
          const cz = Math.floor(k / 3) % 2;
          const cy = Math.floor(k / 6);
          m4.makeTranslation(x + cx * 1.25, 0.52 + cy * 0.85, 4.4 + cz * 1.2);
        } else {
          m4.makeScale(0, 0, 0);
        }
        this.cajas.setMatrixAt(i, m4);
        this.cajas.setColorAt(i, col);
        i++;
      }
      const minutos = (s.llegado - s.montado) * TAKT;
      const falta = sim.parada?.faltan.includes(m.id);
      const a = this.andon.get(m.id);
      a.luz.material.color.setHex(falta ? 0xff6b5e : minutos < 20 ? 0xf5a524 : 0x46c46f);
      a.set(`${tx(m.es, m.en)} · ${minutos} min${t1.falta ? ' ⚠' : ''}`, Math.min(1, minutos / 60), falta || minutos < 20 ? 'bad' : minutos < 40 ? 'warn' : 'teal');
    }
    this.cajas.instanceMatrix.needsUpdate = true;
    if (this.cajas.instanceColor) this.cajas.instanceColor.needsUpdate = true;
    this.cajas.computeBoundingSphere();
    const k = sim.kpis();
    if (sim.parada) {
      const mins = Math.round(sim.t - sim.parada.desde);
      this.estadoLinea(`${tx('LÍNEA PARADA', 'LINE STOPPED')} · ${tx('falta', 'missing')} ${sim.parada.faltan.map(nomModulo).join(', ').toLowerCase()} · ${mins} min`, null, 'bad');
    } else {
      this.estadoLinea(`${tx('LÍNEA EN MARCHA', 'LINE RUNNING')} · ${k.montados}/${k.planificados} ${tx('coches', 'cars')}`, k.plan ?? 1, 'teal');
    }
    this.estadoEl.classList.toggle('bad', !!sim.parada);
    this.bordes.material.color.setHex(sim.parada ? 0xff6b5e : 0xf5a524);
  }

  update(dt) {
    const sim = this.sim;
    if (!sim) return;
    const t = sim.clock ?? sim.t;
    this._pulso = ((this._pulso || 0) + dt * 3) % (Math.PI * 2);
    // El andón del módulo que falta late; los demás (y todos al arrancar) vuelven a su tamaño.
    const latido = 1 + 0.35 * Math.sin(this._pulso);
    for (const [id, a] of this.andon) a.luz.scale.setScalar(sim.parada?.faltan.includes(id) ? latido : 1);
    this._updateTrucks(t);
    this._updateCars(t);
    // Con la vista alejada solo se ven las etiquetas principales; al acercarse aparecen las demás.
    const cerca = this.stage.camera.zoom > 2.1;
    if (cerca !== this._cerca) {
      this._cerca = cerca;
      this.root.traverse((o) => { if (o.isCSS2DObject && o.userData.detalle) o.visible = cerca; });
    }
    for (const [id, o] of this.trucks) o.lab.visible = cerca || o.principal || (this.selected?.kind === 'camion' && this.selected.id === id);
  }

  _updateTrucks(t) {
    const sim = this.sim;
    const vivos = new Set();
    for (const k of sim.camiones) {
      const entregado = k.estado === 'entregado';
      if (entregado && t - k.tEntrega > 2) continue;
      vivos.add(k.id);
      let o = this.trucks.get(k.id);
      if (!o) { o = this._camion(k); this.trucks.set(k.id, o); }
      const key = k.tipo === 't1' ? `${k.origen.id}>oem` : `${k.origen.id}>${k.destino.id}`;
      const r = this.rutas.get(key);
      const f = entregado ? 1 : Math.max(0, Math.min(1, (t - k.salida) / Math.max(1, k.llegada - k.salida)));
      o.g.position.set(r.a.x + (r.b.x - r.a.x) * f, 0, r.a.z + (r.b.z - r.a.z) * f);
      o.g.rotation.y = r.heading;
      const que = k.tipo === 't1' ? nomModulo(k.modulo) : nomInsumo(k.insumo);
      const tarde = k.llegada - k.prevista > 10;
      const sel = this.selected?.kind === 'camion' && this.selected.id === k.id;
      o.set(sel ? `${que} ×${k.n} · ETA ${fmt(k.llegada)}` : `${que} ×${k.n}`, entregado ? null : f, tarde ? 'bad' : k.tipo === 't1' ? 'warn' : 'teal');
      o.lab.element.classList.toggle('sel', sel);
    }
    for (const [id, o] of this.trucks) {
      if (vivos.has(id)) continue;
      disposeTree(o.g);
      this.root.remove(o.g);
      this.trucks.delete(id);
    }
    // Portavehículos que salen de la campa.
    const portas = new Set();
    for (const p of sim.portas) {
      const since = t - p.t;
      if (since > 10) continue;
      portas.add(p.t);
      let o = this.portas.get(p.t);
      if (!o) { o = this._porta(); this.portas.set(p.t, o); }
      const r = this.rutas.get('campa>fuera');
      const f = Math.min(1, since / 10);
      o.g.position.set(r.a.x, 0, r.a.z + (r.b.z - r.a.z) * f);
      o.g.rotation.y = Math.PI;
    }
    for (const [key, o] of this.portas) {
      if (portas.has(key)) continue;
      disposeTree(o.g);
      this.root.remove(o.g);
      this.portas.delete(key);
    }
  }

  // Dónde está cada coche: en la línea (avanza al indexar), en pruebas o retrabajo, o en la campa.
  posCoche(car, t = this.sim.clock ?? this.sim.t) {
    const sim = this.sim;
    const s = sim.head - 1 - car.n;
    if (s >= 0 && s < ESTACIONES && car.tSalida == null) {
      const avance = sim.parada ? 1 : Math.min(1, sim.timer / 0.6);
      return { x: xEst(s - 1 + avance), z: Z_LINEA, rot: Math.PI / 2, donde: 'linea' };
    }
    const iE = sim.eol.indexOf(car);
    if (iE >= 0) {
      if (car.ok === false) {
        const rw = sim.eol.filter((c) => c.ok === false).indexOf(car);
        return { x: 34.5 + (rw % 2) * 3.2, z: -5 - Math.floor(rw / 2) * 5, rot: 0, donde: 'retrabajo' };
      }
      const pr = sim.eol.filter((c) => c.ok !== false).indexOf(car);
      return { x: 37.5, z: Z_LINEA + pr * 2.6 - 1, rot: Math.PI / 2, donde: 'pruebas' };
    }
    const iC = sim.campa.indexOf(car);
    if (iC >= 0) {
      return { x: CAMPA.x0 + (iC % CAMPA.cols) * CAMPA.dx, z: CAMPA.z0 + Math.floor(iC / CAMPA.cols) * CAMPA.dz, rot: 0, donde: 'campa' };
    }
    return null;
  }

  _updateCars() {
    const sim = this.sim;
    const vivos = new Set();
    const lista = [];
    for (let s = 0; s < ESTACIONES; s++) { const c = sim.cocheEn(s); if (c && c.tSalida == null) lista.push(c); }
    lista.push(...sim.eol, ...sim.campa);
    for (const car of lista) {
      const p = this.posCoche(car);
      if (!p) continue;
      vivos.add(car.id);
      let o = this.cars.get(car.id);
      if (!o) { o = this._coche(car); this.cars.set(car.id, o); o.g.position.set(p.x, 0, p.z); }
      o.g.position.x += (p.x - o.g.position.x) * 0.25;
      o.g.position.z += (p.z - o.g.position.z) * 0.25;
      o.g.rotation.y = p.rot;
    }
    for (const [id, o] of this.cars) {
      if (vivos.has(id)) continue;
      // Solo se quita el grupo: geometrías y materiales son compartidos.
      this.root.remove(o.g);
      this.cars.delete(id);
    }
  }

  select(sel) {
    this.selected = sel;
    if (this.sim) this.refresh();
  }

  focusOf(sel) {
    if (!this.sim || !sel) return null;
    if (sel.kind === 'planta') {
      const o = this.plantas.get(sel.id);
      return o ? { pos: this._mundo(o.g.position), radius: Math.max(o.w, o.d) * 0.62, zoom: 2.6 } : null;
    }
    if (sel.kind === 'camion') {
      const o = this.trucks.get(sel.id);
      return o ? { pos: this._mundo(o.g.position), radius: 5.5, zoom: 3.2, follow: true } : null;
    }
    if (sel.kind === 'coche') {
      const o = this.cars.get(sel.id);
      return o ? { pos: this._mundo(o.g.position), radius: 3.2, zoom: 4.5, follow: true } : null;
    }
    return null;
  }

  pick(raycaster) {
    if (!this.sim) return null;
    const targets = [...[...this.plantas.values()].map((o) => o.g), ...[...this.trucks.values()].map((o) => o.g), ...[...this.cars.values()].map((o) => o.g)];
    for (const h of raycaster.intersectObjects(targets, true)) {
      let o = h.object;
      while (o && !o.userData?.kind) o = o.parent;
      if (o) return { kind: o.userData.kind, id: o.userData.id };
    }
    return null;
  }
}
