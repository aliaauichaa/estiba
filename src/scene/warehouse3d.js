// Contenido 3D de la operativa de almacén (va montado sobre el escenario de stage.js): estanterías,
// palés por hueco, calles de muelle, carretillas que siguen las rutas calculadas por el motor y
// camiones en patio y muelle.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { DIM } from '../sim/layout.js';
import { trackPos, fmt } from '../sim/engine.js';
import { tx, pct, placeName } from '../i18n.js';
import { std, disposeTree, progressLabel } from './stage.js';
import { routeStatus } from '../analysis/assistant.js';

const COL = {
  bg: 0x0d1117,
  ground: 0x10151c,
  yard: 0x161c24,
  floor: 0x1d2530,
  wall: 0x2b3542,
  upright: 0x4a5b70,
  beam: 0xd9822b,
  wood: 0x8a6a48,
  amber: 0xf5a524,
  teal: 0x2ec4b6,
  blue: 0x6c9cf0,
  red: 0xff6b5e,
  slate: 0x56627a,
  dark: 0x262c34,
};
const CARTON = [0xc9a36b, 0xb8925c, 0xd4b37f, 0xa8875a, 0xc29a62];
const HEAT = [new THREE.Color(0x1f2a38), new THREE.Color(0x3f6fc4), new THREE.Color(0xf5a524), new THREE.Color(0xff6b5e)];

export const MODES = [
  { id: 'operativa', get nombre() { return tx('Operativa', 'Operations'); } },
  { id: 'ocupacion', get nombre() { return 'Stock'; } },
  { id: 'abc', get nombre() { return 'ABC'; } },
  { id: 'calor', get nombre() { return tx('Calor de picking', 'Picking heatmap'); } },
];

const ZONAS = {
  rec: () => tx('RECEPCIÓN', 'RECEIVING'),
  exp: () => tx('EXPEDICIÓN', 'DISPATCH'),
  patio: () => tx('PATIO', 'YARD'),
  taller: () => tx('TALLER', 'WORKSHOP'),
};

const FORK_SCALE = 1.3;

function label(text, cls) {
  const el = document.createElement('div');
  el.className = `label3d ${cls}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

function heat(v, out) {
  const x = Math.max(0, Math.min(1, v)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(x));
  return out.copy(HEAT[i]).lerp(HEAT[i + 1], x - i);
}

export class WarehouseScene {
  constructor() {
    this.mode = 'operativa';
    this.selected = null;
    this._tmpM = new THREE.Matrix4();
    this._tmpC = new THREE.Color();
    this._tmpV = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  get modes() { return MODES; }

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

  // ------------------------------------------------------------------ montaje

  load(sim) {
    this.sim = sim;
    const L = sim.L;
    this.L = L;
    for (const ch of [...this.root.children]) disposeTree(ch);
    this.root.clear();
    this.forks = new Map();
    this.trucks = new Map();
    this.selected = null;
    this.pathLine = null;

    this._buildGround(L);
    this._buildRacks(L);
    this._buildPallets(L);
    this._buildLanes();
    this._buildLabels(L);
    for (const f of sim.forklifts) this._addForklift(f);
    this.refreshPallets();
  }

  // Caja que tiene que entrar en pantalla en la vista general: nave y patio.
  bounds() {
    const L = this.L;
    return { min: { x: 0, y: 0, z: -15 }, max: { x: L.W, y: 7, z: L.D } };
  }

  // Encuadres de la barra «Cámara».
  views() {
    const L = this.L;
    const span = (docks) => [Math.min(...docks.map((d) => d.x)) - 6, Math.max(...docks.map((d) => d.x)) + 6];
    const [ix0, ix1] = span(L.inDocks);
    const [ox0, ox1] = span(L.outDocks);
    return [
      { id: 'general', nombre: tx('General', 'Overview'), box: this.bounds() },
      { id: 'rec', nombre: tx('Recepción', 'Receiving'), box: { min: { x: ix0, y: 0, z: -22 }, max: { x: ix1, y: 5, z: 14 } } },
      { id: 'racks', nombre: tx('Estanterías', 'Racking'), box: { min: { x: 2, y: 0, z: DIM.Z_RACK0 - 2 }, max: { x: L.W - 2, y: 7, z: L.D - 2 } } },
      { id: 'exp', nombre: tx('Expedición', 'Dispatch'), box: { min: { x: ox0, y: 0, z: -22 }, max: { x: ox1, y: 5, z: 14 } } },
      { id: 'patio', nombre: tx('Patio', 'Yard'), box: { min: { x: 0, y: 0, z: -40 }, max: { x: L.W, y: 4, z: 0 } } },
    ];
  }

  _buildGround(L) {
    const g = this.root;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(L.W + 160, L.D + 180), std(COL.ground, { roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(L.W / 2, -0.06, L.D / 2 - 20);
    ground.receiveShadow = true;
    g.add(ground);

    const yard = new THREE.Mesh(new THREE.BoxGeometry(L.W + 20, 0.08, 40), std(COL.yard, { roughness: 1 }));
    yard.position.set(L.W / 2, -0.04, -20);
    yard.receiveShadow = true;
    g.add(yard);

    const floor = new THREE.Mesh(new THREE.BoxGeometry(L.W, 0.3, L.D), std(COL.floor, { roughness: 0.92 }));
    floor.position.set(L.W / 2, -0.15, L.D / 2);
    floor.receiveShadow = true;
    g.add(floor);

    const H = 7.5;
    const wallMat = std(COL.wall, { transparent: true, opacity: 0.38, depthWrite: false });
    const back = new THREE.Mesh(new THREE.BoxGeometry(L.W, H, 0.25), wallMat);
    back.position.set(L.W / 2, H / 2, L.D);
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.25, H, L.D), wallMat);
    left.position.set(0, H / 2, L.D / 2);
    const right = left.clone();
    right.position.x = L.W;
    g.add(back, left, right);

    // Fachada de muelles: murete bajo + marco de cada puerta + rampa niveladora.
    const curbMat = std(0x303a47);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(L.W, 1.1, 0.3), curbMat);
    curb.position.set(L.W / 2, 0.55, 0);
    curb.castShadow = true;
    g.add(curb);
    const frameMat = std(0x0f1318);
    for (const d of L.docks) {
      const accent = d.tipo === 'entrada' ? COL.blue : COL.teal;
      const top = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.35, 0.4), frameMat);
      top.position.set(d.x, 4.3, 0);
      const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 4.3, 0.4), frameMat);
      p1.position.set(d.x - 1.9, 2.15, 0);
      const p2 = p1.clone();
      p2.position.x = d.x + 1.9;
      const plate = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.08, 2.2), std(0x3a4350, { metalness: 0.4 }));
      plate.position.set(d.x, 0.02, 1.1);
      const light = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.1), new THREE.MeshBasicMaterial({ color: accent }));
      light.position.set(d.x, 4.65, -0.2);
      g.add(top, p1, p2, plate, light);
    }

    // Marcas en el suelo.
    const lines = (pts, color, opacity = 0.55) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const m = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
      g.add(m);
    };
    const y = 0.02;
    const V = (x, z) => new THREE.Vector3(x, y, z);
    const amber = [];
    for (const z of [L.zFront - 1.7, L.zFront + 1.7, L.zRear - 1.7, L.zRear + 1.7]) amber.push(V(2, z), V(L.W - 2, z));
    lines(amber, COL.amber, 0.45);
    const lanesIn = [];
    const lanesOut = [];
    for (const d of L.docks) {
      const arr = d.tipo === 'entrada' ? lanesIn : lanesOut;
      const x0 = d.x - 1.9;
      const x1 = d.x + 1.9;
      arr.push(V(x0, 0.4), V(x0, 10), V(x1, 0.4), V(x1, 10), V(x0, 10), V(x1, 10));
    }
    lines(lanesIn, COL.blue, 0.6);
    lines(lanesOut, COL.teal, 0.6);
    const yardLines = [];
    for (const d of L.docks) yardLines.push(V(d.x - 1.8, -1), V(d.x - 1.8, -16), V(d.x + 1.8, -1), V(d.x + 1.8, -16));
    for (let k = 0; k <= 12; k++) { const x = 4 + k * 3.8; if (x < L.W - 2) yardLines.push(V(x, -20), V(x, -34)); }
    lines(yardLines, 0x8d99ab, 0.25);

    // Taller de carretillas.
    const shop = new THREE.Mesh(new THREE.BoxGeometry(6, 0.04, 6), std(0x3a1f1f, { roughness: 1 }));
    shop.position.set(L.taller.x - 1.2, 0.01, L.taller.z - 1.2);
    g.add(shop);
  }

  _buildRacks(L) {
    const H = L.niveles * DIM.LEVEL_H + 0.25;
    const upGeo = new THREE.BoxGeometry(0.09, H, 0.09);
    const beamGeo = new THREE.BoxGeometry(0.07, 0.13, DIM.BAY_L);
    const nUp = L.aisles.length * 2 * (this.sim.site.huecos + 1) * 2;
    const nBeam = L.aisles.length * 2 * this.sim.site.huecos * L.niveles * 2;
    const ups = new THREE.InstancedMesh(upGeo, std(COL.upright, { metalness: 0.3, roughness: 0.6 }), nUp);
    const beams = new THREE.InstancedMesh(beamGeo, std(COL.beam, { metalness: 0.2, roughness: 0.55 }), nBeam);
    let iu = 0;
    let ib = 0;
    const m = this._tmpM;
    for (const a of L.aisles) {
      for (const rx of a.rackX) {
        for (const off of [-DIM.RACK_D / 2 + 0.05, DIM.RACK_D / 2 - 0.05]) {
          for (let b = 0; b <= this.sim.site.huecos; b++) {
            m.makeTranslation(rx + off, H / 2, DIM.Z_RACK0 + b * DIM.BAY_L);
            ups.setMatrixAt(iu++, m);
          }
          for (let b = 0; b < this.sim.site.huecos; b++) {
            for (let l = 1; l <= L.niveles; l++) {
              m.makeTranslation(rx + off, l * DIM.LEVEL_H + 0.06, DIM.Z_RACK0 + (b + 0.5) * DIM.BAY_L);
              beams.setMatrixAt(ib++, m);
            }
          }
        }
      }
    }
    ups.count = iu;
    beams.count = ib;
    ups.castShadow = beams.castShadow = true;
    ups.receiveShadow = beams.receiveShadow = true;
    this.root.add(ups, beams);
  }

  _buildPallets(L) {
    const n = L.locations.length;
    const base = new THREE.InstancedMesh(new THREE.BoxGeometry(DIM.RACK_D * 0.9, 0.14, DIM.BAY_L * 0.82), std(COL.wood, { roughness: 1 }), n);
    const load = new THREE.InstancedMesh(new THREE.BoxGeometry(DIM.RACK_D * 0.84, 1, DIM.BAY_L * 0.76), std(0xffffff, { roughness: 0.85 }), n);
    load.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    base.castShadow = load.castShadow = true;
    base.receiveShadow = load.receiveShadow = true;
    load.userData.kind = 'pallet';
    base.userData.kind = 'pallet';
    this.palletBase = base;
    this.palletLoad = load;
    this.root.add(base, load);
  }

  _buildLanes() {
    const cap = 600;
    const geo = new THREE.BoxGeometry(1.05, 1, 1.05);
    const lane = new THREE.InstancedMesh(geo, std(0xffffff, { roughness: 0.7 }), cap);
    lane.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    lane.castShadow = true;
    lane.count = 0;
    this.lanePallets = lane;
    this.root.add(lane);
  }

  _buildLabels(L) {
    for (const a of L.aisles) {
      const o = label(a.letra, 'aisle');
      o.position.set(a.x, 0.2, L.zFront + 2.4);
      this.root.add(o);
    }
    for (const d of L.docks) {
      const o = label(d.id, 'dock');
      o.position.set(d.x, 5.2, 0);
      this.root.add(o);
    }
    const inX = L.inDocks.reduce((s, d) => s + d.x, 0) / L.inDocks.length;
    const outX = L.outDocks.reduce((s, d) => s + d.x, 0) / L.outDocks.length;
    const a = label(ZONAS.rec(), 'zone');
    a.userData.zona = 'rec';
    a.position.set(inX, 0.1, 11.2);
    const b = label(ZONAS.exp(), 'zone');
    b.userData.zona = 'exp';
    b.position.set(outX, 0.1, 11.2);
    const c = label(ZONAS.patio(), 'zone');
    c.userData.zona = 'patio';
    c.position.set(L.W / 2, 0.1, -36);
    const t = label(ZONAS.taller(), 'zone');
    t.userData.zona = 'taller';
    t.position.set(L.taller.x - 1.2, 0.1, L.taller.z - 4.5);
    this.root.add(a, b, c, t);
  }

  // ------------------------------------------------------------------ modelos

  _addForklift(f) {
    const g = new THREE.Group();
    const body = std(COL.amber, { roughness: 0.5 });
    const dark = std(COL.dark, { roughness: 0.7 });
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    add(new THREE.BoxGeometry(1.0, 0.55, 1.35), body, 0, 0.5, 0);
    add(new THREE.BoxGeometry(1.0, 0.55, 0.38), dark, 0, 0.55, -0.82);
    for (const [x, z] of [[-0.5, 0.45], [0.5, 0.45], [-0.5, -0.5], [0.5, -0.5]]) {
      const w = add(new THREE.CylinderGeometry(0.22, 0.22, 0.18, 14), dark, x, 0.22, z);
      w.rotation.z = Math.PI / 2;
    }
    for (const [x, z] of [[-0.45, 0.35], [0.45, 0.35], [-0.45, -0.55], [0.45, -0.55]]) add(new THREE.BoxGeometry(0.06, 1.05, 0.06), dark, x, 1.3, z);
    add(new THREE.BoxGeometry(1.0, 0.06, 1.0), dark, 0, 1.84, -0.1);
    add(new THREE.BoxGeometry(0.5, 0.35, 0.45), dark, 0, 0.95, -0.25);
    add(new THREE.BoxGeometry(0.08, 2.1, 0.08), dark, -0.36, 1.05, 0.78);
    add(new THREE.BoxGeometry(0.08, 2.1, 0.08), dark, 0.36, 1.05, 0.78);
    const carriage = new THREE.Group();
    const cm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.45, 0.06), dark);
    cm.position.set(0, 0.25, 0.86);
    const f1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 1.0), dark);
    f1.position.set(-0.25, 0.05, 1.38);
    const f2 = f1.clone();
    f2.position.x = 0.25;
    const loadBox = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.8, 1.0), std(0xc9a36b, { roughness: 0.9 }));
    loadBox.position.set(0, 0.5, 1.38);
    loadBox.castShadow = true;
    loadBox.visible = false;
    carriage.add(cm, f1, f2, loadBox);
    g.add(carriage);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: COL.amber }));
    beacon.position.set(0, 1.95, -0.1);
    g.add(beacon);
    const lab = label('', 'fork');
    lab.position.set(0, 2.5, 0);
    g.add(lab);

    g.scale.setScalar(FORK_SCALE);
    g.position.set(f.x, 0, f.z);
    g.userData = { kind: 'forklift', id: f.id };
    this.root.add(g);
    this.forks.set(f.id, { g, carriage, loadBox, beacon, lab, setLab: progressLabel(lab.element), heading: 0 });
  }

  _makeTruck(kind) {
    const g = new THREE.Group();
    const inbound = kind === 'entrada';
    const trailerMat = std(inbound ? 0xd9dee6 : 0x2c3540, { roughness: 0.6 });
    const stripeMat = new THREE.MeshBasicMaterial({ color: inbound ? COL.blue : COL.teal });
    const dark = std(0x1a1f26);
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    add(new THREE.BoxGeometry(2.5, 2.9, 12), trailerMat, 0, 2.0, -6.2);
    add(new THREE.BoxGeometry(2.52, 0.22, 11.6), stripeMat, 0, 1.0, -6.2);
    add(new THREE.BoxGeometry(2.2, 0.3, 13.4), dark, 0, 0.45, -7.0);
    add(new THREE.BoxGeometry(2.45, 2.7, 2.2), std(inbound ? 0x3d4a5c : 0xe7ebf1, { roughness: 0.45 }), 0, 1.75, -13.9);
    add(new THREE.BoxGeometry(2.3, 0.9, 0.05), std(0x0b0e12, { roughness: 0.2, metalness: 0.4 }), 0, 2.4, -15.02);
    for (const z of [-2.0, -3.3, -11.2, -14.2]) {
      for (const x of [-1.05, 1.05]) {
        const w = add(new THREE.CylinderGeometry(0.48, 0.48, 0.4, 16), dark, x, 0.48, z);
        w.rotation.z = Math.PI / 2;
      }
    }
    return g;
  }

  // ------------------------------------------------------------------ actualización

  relabel() {
    this.root.traverse((o) => {
      if (o.isCSS2DObject && o.userData.zona) o.element.textContent = ZONAS[o.userData.zona]();
    });
  }

  setMode(mode) {
    this.mode = mode;
    this.refreshPallets();
  }

  refreshPallets() {
    const sim = this.sim;
    if (!sim) return;
    const L = sim.L;
    const m = this._tmpM;
    const c = this._tmpC;
    const mode = this.mode;
    let maxPicks = 1;
    if (mode === 'calor') for (const loc of L.locations) maxPicks = Math.max(maxPicks, loc.picks);
    const pos = this._tmpV;
    const scl = new THREE.Vector3();
    const q = this._q;
    for (const loc of L.locations) {
      const i = loc.idx;
      const sku = loc.sku >= 0 ? sim.skus[loc.sku] : null;
      const yBase = loc.level === 0 ? 0 : loc.level * DIM.LEVEL_H + 0.13;
      const hasLoad = loc.units > 0;
      const showGhost = !hasLoad && loc.role === 'pick' && mode === 'ocupacion';
      const showHeatEmpty = mode === 'calor' && loc.picks > 0 && !hasLoad;
      if (!hasLoad && !showGhost && !showHeatEmpty) {
        m.makeScale(0, 0, 0);
        this.palletBase.setMatrixAt(i, m);
        this.palletLoad.setMatrixAt(i, m);
        continue;
      }
      pos.set(loc.rx, yBase + 0.07, loc.z);
      m.makeTranslation(pos.x, pos.y, pos.z);
      this.palletBase.setMatrixAt(i, m);
      const fill = sku ? Math.min(1, loc.units / sku.upp) : 0;
      const h = hasLoad ? 0.3 + 0.95 * fill : 0.12;
      pos.set(loc.rx, yBase + 0.14 + h / 2, loc.z);
      scl.set(1, h, 1);
      m.compose(pos, q, scl);
      this.palletLoad.setMatrixAt(i, m);

      if (mode === 'operativa') {
        c.setHex(CARTON[(loc.sku * 7 + 3) % CARTON.length]);
      } else if (mode === 'ocupacion') {
        if (!hasLoad) c.setHex(COL.red);
        else if (fill < 0.3) c.setHex(COL.amber);
        else c.setHex(COL.teal);
        if (hasLoad && loc.role === 'reserva') c.lerp(this._tmpV2 || (this._tmpV2 = new THREE.Color(0x56627a)), 0.45);
      } else if (mode === 'abc') {
        if (loc.role !== 'pick') c.setHex(0x343c49);
        else c.setHex(sku.cls === 'A' ? COL.teal : sku.cls === 'B' ? COL.amber : COL.slate);
      } else {
        heat(Math.sqrt(loc.picks / maxPicks), c);
      }
      this.palletLoad.setColorAt(i, c);
    }
    this.palletBase.instanceMatrix.needsUpdate = true;
    this.palletLoad.instanceMatrix.needsUpdate = true;
    if (this.palletLoad.instanceColor) this.palletLoad.instanceColor.needsUpdate = true;
    this.palletLoad.computeBoundingSphere();

    // Calles de muelle: palés esperando ubicación (recepción) y pedidos preparados (expedición).
    const lane = this.lanePallets;
    let k = 0;
    const put = (x, z, h, hex) => {
      if (k >= 600) return;
      pos.set(x, h / 2, z);
      scl.set(1, h, 1);
      m.compose(pos, q, scl);
      lane.setMatrixAt(k, m);
      lane.setColorAt(k, c.setHex(hex));
      k++;
    };
    for (const d of L.inDocks) {
      const arr = sim.lanes[d.id];
      arr.forEach((p, j) => {
        const col = j % 2;
        const row = Math.floor(j / 2);
        const blocked = p.bloqueado != null;
        put(d.x + (col ? 0.75 : -0.75), 1.4 + row * 1.25, 1.15, blocked ? COL.red : CARTON[p.sku % CARTON.length]);
      });
    }
    for (const ro of sim.routes) {
      if (!ro.camion || ro.salio) continue;
      let pallets = 0;
      for (const o of ro.pedidos) if (o.estado === 'preparado') pallets += Math.max(1, Math.round(o.lines.reduce((s, l) => s + l.served, 0) / 40));
      pallets = Math.min(pallets, 16);
      for (let j = 0; j < pallets; j++) {
        const col = j % 2;
        const row = Math.floor(j / 2);
        put(ro.dock.x + (col ? 0.75 : -0.75), 1.4 + row * 1.05, 1.2, 0xcfe7e3);
      }
    }
    lane.count = k;
    lane.instanceMatrix.needsUpdate = true;
    if (lane.instanceColor) lane.instanceColor.needsUpdate = true;
    lane.computeBoundingSphere();
  }

  update(dtReal) {
    const sim = this.sim;
    if (!sim) return;
    const t = sim.clock ?? sim.t;
    const lerpK = 1 - Math.exp(-dtReal * 10);
    for (const f of sim.forklifts) {
      const o = this.forks.get(f.id);
      const p = f.track ? trackPos(f.track, t) : { x: f.x, z: f.z, heading: null };
      o.g.position.x = p.x;
      o.g.position.z = p.z;
      if (p.heading != null) {
        let d = p.heading - o.heading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        o.heading += d * Math.min(1, lerpK * 1.6);
      }
      o.g.rotation.y = o.heading;
      const tipo = f.task?.tipo;
      const firstStop = f.track ? f.track.find((pt) => pt.stop) : null;
      o.loadBox.visible = (tipo === 'ubicacion' || tipo === 'picking') && firstStop && t >= firstStop.t;
      const taller = f.enTaller || tipo === 'taller';
      o.beacon.material.color.setHex(taller ? COL.red : tipo === 'picking' ? COL.teal : tipo === 'ubicacion' ? COL.blue : 0x7a6a40);
      o.carriage.position.y = p.stop && tipo === 'ubicacion' && f.task.dest && f.track && t > (firstStop?.t ?? Infinity) + 0.2
        ? Math.min(f.task.dest.level * DIM.LEVEL_H, 4.5) / FORK_SCALE * 0.9 : 0;
      const sel = this.selected?.kind === 'forklift' && this.selected.id === f.id;
      o.lab.element.classList.toggle('taller', !!taller);
      o.lab.element.classList.toggle('sel', sel);
      // Etiqueta con el avance de la tarea; seleccionada, dice además qué está haciendo.
      const frac = f.track && (tipo === 'picking' || tipo === 'ubicacion') ? Math.min(1, (t - f.track[0].t) / Math.max(0.01, f.endT - f.track[0].t)) : null;
      let txt = f.id;
      if (sel && tipo === 'picking') txt = `${f.id} · ${f.task.pedido.id} · ${pct(frac ?? 0, 0)}`;
      else if (sel && tipo === 'ubicacion') txt = `${f.id} · ${tx('a', 'to')} ${f.task.dest.id} · ${pct(frac ?? 0, 0)}`;
      else if (sel && taller) txt = `${f.id} · ${tx('taller', 'workshop')}`;
      o.setLab(txt, frac, tipo === 'picking' ? 'teal' : 'blue');
    }
    this._updateTrucks(t, dtReal);
    this._updatePath(t);
  }

  _truckObj(key, kind, initial) {
    let o = this.trucks.get(key);
    if (!o) {
      const g = this._makeTruck(kind);
      g.position.copy(initial);
      g.userData = { kind: 'truck', id: key };
      this.root.add(g);
      o = { g, seen: true };
      o.lab = label('', kind === 'salida' ? 'dock truck-out' : 'dock truck-in');
      o.lab.position.set(0, 4.2, kind === 'salida' ? -13.9 : -6.2);
      g.add(o.lab);
      o.setLab = progressLabel(o.lab.element);
      this.trucks.set(key, o);
    }
    o.seen = true;
    return o;
  }

  _updateTrucks(t, dtReal) {
    const sim = this.sim;
    const L = sim.L;
    for (const o of this.trucks.values()) o.seen = false;
    const k = 1 - Math.exp(-dtReal * 2.5);
    const target = new THREE.Vector3();
    const place = (o, x, z) => {
      target.set(x, 0, z);
      o.g.position.lerp(target, k);
    };
    sim.yard.forEach((tr, i) => {
      const x = 5.9 + (i % 12) * 3.8;
      const z = -20 - Math.floor(i / 12) * 15;
      const o = this._truckObj(`in-${tr.id}`, 'entrada', new THREE.Vector3(x, 0, z - 40));
      place(o, x, z);
      const espera = t - tr.tPatio;
      o.setLab(`${tr.matricula} · ${Math.round(espera)} min`, Math.min(1, espera / 45), espera > 45 ? 'bad' : 'warn');
    });
    for (const d of L.inDocks) {
      if (!d.truck) continue;
      const tr = d.truck;
      const o = this._truckObj(`in-${tr.id}`, 'entrada', new THREE.Vector3(d.x, 0, -40));
      place(o, d.x, -0.45);
      o.setLab(`${tr.matricula} · ${tr.descargados}/${tr.pales.length}`, tr.descargados / tr.pales.length, sim.lanes[d.id].length >= sim.site.capCalle ? 'bad' : 'blue');
    }
    for (const lv of sim.leaving) {
      const o = this.trucks.get(`in-${lv.truck.id}`);
      if (!o) continue;
      o.seen = true;
      place(o, lv.dock.x, -0.45 - (t - lv.t) * 9);
      o.setLab(lv.truck.matricula, null);
    }
    const estados = new Map(routeStatus(sim).map((r) => [r.ro, r.estado]));
    for (const ro of sim.routes) {
      if (!ro.camion) continue;
      const since = ro.salio ? t - ro.salida : -1;
      if (since > 9) continue;
      const o = this._truckObj(`out-${ro.id}`, 'salida', new THREE.Vector3(ro.dock.x, 0, -45));
      place(o, ro.dock.x, since < 0 ? -0.45 : -0.45 - since * 9);
      const ready = ro.pedidos.filter((p) => p.estado === 'preparado' || (p.estado === 'expedido' && p.aTiempo)).length;
      const est = estados.get(ro);
      const tone = est === 'riesgo' || est === 'salio-tarde' ? 'bad' : est === 'justa' ? 'warn' : 'teal';
      o.setLab(`${placeName(ro.destino)} · ${fmt(ro.salida)} · ${ready}/${ro.pedidos.length}`, ro.pedidos.length ? ready / ro.pedidos.length : 0, tone);
    }
    for (const [key, o] of this.trucks) o.lab?.element.classList.toggle('sel', this.selected?.kind === 'truck' && this.selected.id === key);
    for (const [key, o] of this.trucks) {
      if (!o.seen) {
        disposeTree(o.g);
        this.root.remove(o.g);
        this.trucks.delete(key);
      }
    }
  }

  _updatePath(t) {
    const sel = this.selected;
    let track = null;
    if (sel?.kind === 'forklift') {
      const f = this.sim.forklifts.find((x) => x.id === sel.id);
      track = f?.track || null;
    }
    if (this.pathLine && this.pathLine.userData.track !== track) {
      disposeTree(this.pathLine);
      this.root.remove(this.pathLine);
      this.pathLine = null;
    }
    if (!track || this.pathLine) return;
    const pts = track.map((p) => new THREE.Vector3(p.x, 0.12, p.z));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: COL.amber, dashSize: 0.9, gapSize: 0.5 }));
    line.computeLineDistances();
    const stops = new THREE.Group();
    for (const p of track) {
      if (!p.stop) continue;
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.06, 16), new THREE.MeshBasicMaterial({ color: COL.amber }));
      s.position.set(p.x, 0.1, p.z);
      stops.add(s);
    }
    const grp = new THREE.Group();
    grp.add(line, stops);
    grp.userData.track = track;
    this.pathLine = grp;
    this.root.add(grp);
  }

  refresh() {
    this.refreshPallets();
  }

  select(sel) {
    this.selected = sel;
  }

  // Dónde está lo seleccionado, para el anillo, el vuelo de la cámara y el seguimiento.
  focusOf(sel) {
    const sim = this.sim;
    if (!sim || !sel) return null;
    if (sel.kind === 'forklift') {
      const o = this.forks.get(sel.id);
      return o ? { pos: o.g.position, radius: 2.2, follow: true, zoom: 3 } : null;
    }
    if (sel.kind === 'truck') {
      const o = this.trucks.get(sel.id);
      return o ? { pos: { x: o.g.position.x, y: 2, z: o.g.position.z - 7 }, radius: 8, zoom: 2.2 } : null;
    }
    if (sel.kind === 'location') {
      const loc = sim.L.locations[sel.id];
      if (!loc) return null;
      const y = loc.level === 0 ? 0 : loc.level * DIM.LEVEL_H + 0.13;
      return { pos: { x: loc.rx, y: y + DIM.LEVEL_H / 2, z: loc.z }, radius: 1.7, zoom: 3.2, box: { x: DIM.RACK_D + 0.2, y: DIM.LEVEL_H, z: DIM.BAY_L } };
    }
    return null;
  }

  pick(raycaster) {
    if (!this.sim) return null;
    const targets = [...[...this.forks.values()].map((o) => o.g), ...[...this.trucks.values()].map((o) => o.g), this.palletLoad];
    const hits = raycaster.intersectObjects(targets, true);
    for (const h of hits) {
      let o = h.object;
      if (o === this.palletLoad && h.instanceId != null) {
        const loc = this.sim.L.locations[h.instanceId];
        if (loc.units > 0 || loc.role === 'pick') return { kind: 'location', id: loc.idx };
        continue;
      }
      while (o && !o.userData?.kind) o = o.parent;
      if (o?.userData.kind === 'forklift' || o?.userData.kind === 'truck') return { kind: o.userData.kind, id: o.userData.id };
    }
    return null;
  }
}
