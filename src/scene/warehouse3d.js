// Escena 3D de la nave con Three.js: estanterías, palés por hueco, calles de muelle,
// carretillas que siguen las rutas calculadas por el motor y camiones en patio y muelle.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { DIM } from '../sim/layout.js';
import { trackPos } from '../sim/engine.js';

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
  { id: 'operativa', nombre: 'Operativa' },
  { id: 'ocupacion', nombre: 'Stock' },
  { id: 'abc', nombre: 'ABC' },
  { id: 'calor', nombre: 'Calor de picking' },
];

const FORK_SCALE = 1.3;

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...extra });
}

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
  constructor(el, { onSelect } = {}) {
    this.el = el;
    this.onSelect = onSelect || (() => {});
    this.mode = 'operativa';
    this.selected = null;

    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(r.domElement);
    this.renderer = r;

    const lr = new CSS2DRenderer();
    lr.domElement.style.position = 'absolute';
    lr.domElement.style.inset = '0';
    lr.domElement.style.pointerEvents = 'none';
    el.appendChild(lr.domElement);
    this.labelRenderer = lr;

    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.25;
    this.controls.minZoom = 0.5;
    this.controls.maxZoom = 6;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('start', () => { this.userMoved = true; });

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1f26, 1.25));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.raycaster = new THREE.Raycaster();
    this._tmpM = new THREE.Matrix4();
    this._tmpC = new THREE.Color();
    this._tmpV = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    this._bindPointer();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(el);
  }

  // ------------------------------------------------------------------ montaje

  load(sim) {
    this.sim = sim;
    const L = sim.L;
    this.L = L;
    for (const ch of [...this.root.children]) this._disposeTree(ch);
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

    const cx = L.W / 2;
    const cz = (L.D - 16) / 2;
    this.target = new THREE.Vector3(cx, 0, cz);
    const span = Math.max(L.W, L.D + 30);
    this.sun.position.set(cx - span * 0.4, span * 0.9, cz - span * 0.6);
    this.sun.target.position.copy(this.target);
    const sc = this.sun.shadow.camera;
    sc.left = -span * 0.75; sc.right = span * 0.75; sc.top = span * 0.75; sc.bottom = -span * 0.75;
    sc.near = 1; sc.far = span * 3;
    sc.updateProjectionMatrix();

    this.resetView();
    this.refreshPallets();
  }

  resetView() {
    const L = this.L;
    if (!L) return;
    this.userMoved = false;
    const dir = (this.viewDir || new THREE.Vector3(0.5, 0.95, -1.0)).clone().normalize();
    this.camera.position.copy(this.target).addScaledVector(dir, 200);
    this.camera.up.set(0, 1, 0);
    this.controls.target.copy(this.target);
    this.camera.zoom = 1;
    this._frustum(1);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    // Ajusta el zoom para que entren la nave y el patio.
    const pts = [];
    for (const x of [0, L.W]) for (const z of [-15, L.D]) for (const y of [0, 7]) pts.push(new THREE.Vector3(x, y, z));
    let m = 0;
    for (const p of pts) {
      p.project(this.camera);
      m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
    }
    this.camera.zoom = 0.97 / m;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  _frustum(h) {
    const w = this.el.clientWidth || 1;
    const hh = this.el.clientHeight || 1;
    const a = w / hh;
    const size = Math.max(this.L ? this.L.W : 60, this.L ? this.L.D + 30 : 60) * 0.5 * h;
    this.camera.left = -size * a;
    this.camera.right = size * a;
    this.camera.top = size;
    this.camera.bottom = -size;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.labelRenderer.setSize(w, h);
    if (this.L) {
      // Mientras el usuario no haya movido la cámara, se reencuadra al cambiar el tamaño.
      if (this.userMoved) this._frustum(1);
      else this.resetView();
    }
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
    const a = label('RECEPCIÓN', 'zone');
    a.position.set(inX, 0.1, 11.2);
    const b = label('EXPEDICIÓN', 'zone');
    b.position.set(outX, 0.1, 11.2);
    const c = label('PATIO', 'zone');
    c.position.set(L.W / 2, 0.1, -36);
    const t = label('TALLER', 'zone');
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
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.5, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    ring.visible = false;
    g.add(ring);
    const lab = label(f.id, 'fork');
    lab.position.set(0, 2.5, 0);
    g.add(lab);

    g.scale.setScalar(FORK_SCALE);
    g.position.set(f.x, 0, f.z);
    g.userData = { kind: 'forklift', id: f.id };
    this.root.add(g);
    this.forks.set(f.id, { g, carriage, loadBox, beacon, ring, lab, heading: 0 });
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
      o.lab.element.classList.toggle('taller', !!taller);
      o.lab.element.classList.toggle('sel', this.selected?.kind === 'forklift' && this.selected.id === f.id);
      o.ring.visible = this.selected?.kind === 'forklift' && this.selected.id === f.id;
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
      if (kind === 'salida') {
        o.lab = label('', 'dock');
        o.lab.position.set(0, 4.2, -13.9);
        g.add(o.lab);
      }
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
    });
    for (const d of L.inDocks) {
      if (!d.truck) continue;
      const o = this._truckObj(`in-${d.truck.id}`, 'entrada', new THREE.Vector3(d.x, 0, -40));
      place(o, d.x, -0.45);
    }
    for (const lv of sim.leaving) {
      const o = this.trucks.get(`in-${lv.truck.id}`);
      if (!o) continue;
      o.seen = true;
      place(o, lv.dock.x, -0.45 - (t - lv.t) * 9);
    }
    for (const ro of sim.routes) {
      if (!ro.camion) continue;
      const since = ro.salio ? t - ro.salida : -1;
      if (since > 9) continue;
      const o = this._truckObj(`out-${ro.id}`, 'salida', new THREE.Vector3(ro.dock.x, 0, -45));
      place(o, ro.dock.x, since < 0 ? -0.45 : -0.45 - since * 9);
      if (o.lab) {
        const ready = ro.pedidos.filter((p) => p.estado === 'preparado' || p.estado === 'expedido').length;
        o.lab.element.textContent = `${ro.destino} · ${ready}/${ro.pedidos.length}`;
      }
    }
    for (const [key, o] of this.trucks) {
      if (!o.seen) {
        this._disposeTree(o.g);
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
      this._disposeTree(this.pathLine);
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

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  select(sel) {
    this.selected = sel;
  }

  // ------------------------------------------------------------------ interacción

  _bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const hit = this._pick(e);
      this.onSelect(hit);
    });
    let last = 0;
    el.addEventListener('pointermove', (e) => {
      const now = performance.now();
      if (now - last < 90 || e.buttons) return;
      last = now;
      el.style.cursor = this._pick(e) ? 'pointer' : 'grab';
    });
  }

  _pick(e) {
    if (!this.sim) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = [...[...this.forks.values()].map((o) => o.g), ...[...this.trucks.values()].map((o) => o.g), this.palletLoad];
    const hits = this.raycaster.intersectObjects(targets, true);
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

  _disposeTree(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
    });
  }
}
