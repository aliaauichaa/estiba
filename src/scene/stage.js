// Escenario 3D compartido por las tres operativas: un solo renderizador WebGL, la cámara isométrica,
// las luces, los clics y las etiquetas CSS2D. Cada operativa monta encima su «contenido» (almacén,
// cadena de automoción o red de última milla) con la misma interfaz:
//   mount(stage) · load(sim) · unmount() · update(dt) · refresh() · setMode(m) · relabel()
//   bounds() · views() · pick(raycaster) · focusOf(sel) · select(sel)
// El escenario se encarga además de los encuadres animados, de seguir lo seleccionado y del anillo
// que late bajo la selección.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

const DIR = new THREE.Vector3(0.5, 0.95, -1.0).normalize();
const DIST = 400;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

export class Stage {
  constructor(el, { onSelect } = {}) {
    this.el = el;
    this.onSelect = onSelect || (() => {});
    this.content = null;
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
    // Contexto de apilado propio: el renderizador ordena las etiquetas con z-index y, sin esto, alguna
    // quedaba por encima de los paneles flotantes de la escena.
    lr.domElement.style.zIndex = '1';
    el.appendChild(lr.domElement);
    this.labelRenderer = lr;

    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1500, 3000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.25;
    this.controls.minZoom = 0.5;
    this.controls.maxZoom = 14;
    this.controls.zoomToCursor = true;
    // Si el usuario mueve la cámara, se para cualquier encuadre animado y deja de seguir.
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
      this.tween = null;
      if (this.following) { this.following = false; this.onFollow?.(false); }
    });

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1f26, 1.25));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    this.raycaster = new THREE.Raycaster();
    this.target = new THREE.Vector3();
    this.baseSize = 40;
    // Píxeles que tapan los paneles flotantes arriba y abajo (barras de vista, seguimiento): el encuadre
    // centra lo importante en la parte que se ve.
    this.pad = { top: 0, bottom: 0 };
    this._buildPulse();
    this._bindPointer();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(el);
  }

  // ------------------------------------------------------------------ contenido

  setContent(content, sim) {
    if (this.content !== content) {
      this.content?.unmount();
      this.content = content;
      content.mount(this);
      this.userMoved = false;
    }
    this.selected = null;
    this.following = false;
    this.tween = null;
    content.load(sim);
    const b = content.bounds();
    const span = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    this.baseSize = span * 0.5;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    this.sun.position.set(cx - span * 0.4, span * 0.9, cz - span * 0.6);
    this.sun.target.position.set(cx, 0, cz);
    const sc = this.sun.shadow.camera;
    sc.left = -span * 0.75; sc.right = span * 0.75; sc.top = span * 0.75; sc.bottom = -span * 0.75;
    sc.near = 1; sc.far = span * 3;
    sc.updateProjectionMatrix();
    if (!this.userMoved) this.resetView();
    else this._frustum();
  }

  // ------------------------------------------------------------------ encuadres

  _frustum() {
    const w = this.el.clientWidth || 1;
    const h = this.el.clientHeight || 1;
    const a = w / h;
    const s = this.baseSize;
    this.camera.left = -s * a;
    this.camera.right = s * a;
    this.camera.top = s;
    this.camera.bottom = -s;
    this.camera.updateProjectionMatrix();
  }

  // Pose (centro, dirección y zoom) en la que la caja entra entera en pantalla.
  _poseFor(box, dir) {
    const target = new THREE.Vector3((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2);
    const cam = this.camera.clone();
    let mx = 0;
    let my = 0;
    cam.zoom = 1;
    cam.position.copy(target).addScaledVector(dir, DIST);
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const p = new THREE.Vector3();
    for (const x of [box.min.x, box.max.x]) {
      for (const z of [box.min.z, box.max.z]) {
        for (const y of [box.min.y, box.max.y]) {
          p.set(x, y, z).project(cam);
          mx = Math.max(mx, Math.abs(p.x));
          my = Math.max(my, Math.abs(p.y));
        }
      }
    }
    const h = this.el.clientHeight || 1;
    const libre = Math.max(0.35, 1 - (this.pad.top + this.pad.bottom) / h);
    const zoom = Math.min(this.controls.maxZoom, 0.97 * Math.min(1 / (mx || 1), libre / (my || 1)));
    // Se desplaza el centro para que la caja quede en la franja libre, no tras los paneles.
    const d = (this.pad.bottom - this.pad.top) / h;
    if (d) {
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      target.addScaledVector(up, -d * this.baseSize / zoom);
      target.y = 0;
    }
    return { target, dir: dir.clone(), zoom };
  }

  // Cada contenido puede pedir su orientación de la vista general (la nave se ve mejor en diagonal;
  // la pirámide de proveedores, casi de frente).
  _dirGeneral() {
    return (this.content?.viewDir || DIR).clone().normalize();
  }

  _currentDir() {
    return this.camera.position.clone().sub(this.controls.target).normalize();
  }

  _apply(pose) {
    this.camera.position.copy(pose.target).addScaledVector(pose.dir, DIST);
    this.camera.up.set(0, 1, 0);
    this.controls.target.copy(pose.target);
    this.camera.zoom = pose.zoom;
    this.camera.lookAt(pose.target);
    this.camera.updateProjectionMatrix();
  }

  resetView(animate = false) {
    if (!this.content) return;
    this._frustum();
    this.frame(this.content.bounds(), { animate, dir: this._dirGeneral() });
    if (!animate) this.userMoved = false;
  }

  // Encuadra una caja { min:{x,y,z}, max:{x,y,z} }, con animación o de golpe. Un encuadre animado lo
  // ha pedido el usuario (barra de cámara): a partir de ahí, cambiar de tamaño no lo deshace.
  frame(box, { animate = true, dir = null } = {}) {
    if (this.following) { this.following = false; this.onFollow?.(false); }
    if (animate) this.userMoved = true;
    const pose = this._poseFor(box, (dir || (this.content ? this._currentDir() : DIR)).clone().normalize());
    if (!animate) {
      this.tween = null;
      this._apply(pose);
      this.controls.update();
      return;
    }
    this.tween = {
      from: { target: this.controls.target.clone(), dir: this._currentDir(), zoom: this.camera.zoom },
      to: pose,
      t: 0,
      dur: 0.9,
    };
  }

  // Acerca la cámara a un punto sin cambiar la orientación.
  flyTo(pos, zoom = null) {
    this.userMoved = true;
    const to = { target: new THREE.Vector3(pos.x, 0, pos.z), dir: this._currentDir(), zoom: zoom ?? this.camera.zoom };
    this.tween = { from: { target: this.controls.target.clone(), dir: to.dir.clone(), zoom: this.camera.zoom }, to, t: 0, dur: 0.8 };
  }

  setView(id) {
    const v = this.content?.views().find((x) => x.id === id);
    if (!v) return;
    if (v.id === 'general') this.frame(v.box, { dir: this._dirGeneral() });
    else this.frame(v.box);
  }

  // ------------------------------------------------------------------ selección

  select(sel, { fly = false } = {}) {
    this.selected = sel;
    this.content?.select(sel);
    const f = sel ? this.content?.focusOf(sel) : null;
    this.following = !!(f && f.follow);
    this.onFollow?.(this.following);
    // Desde fuera de la escena (avisos, seguimiento, tablas) se vuela hasta el objeto; con un clic en la
    // escena no se mueve la cámara, salvo para seguir a lo que se desplaza.
    if (f && fly) this.flyTo(f.pos, Math.max(this.camera.zoom, f.zoom ?? 2.4));
  }

  follow(on) {
    const f = this.selected ? this.content?.focusOf(this.selected) : null;
    this.following = !!(on && f);
    this.onFollow?.(this.following);
  }

  _buildPulse() {
    const g = new THREE.Group();
    const mat = () => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 48), mat());
    const wave = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), mat());
    ring.material.color.setHex(0xf5a524);
    for (const m of [ring, wave]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 5; }
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true }));
    g.add(ring, wave, box);
    g.visible = false;
    this.pulse = { g, ring, wave, box, t: 0 };
    this.scene.add(g);
  }

  _updatePulse(dt) {
    const p = this.pulse;
    const f = this.selected && this.content ? this.content.focusOf(this.selected) : null;
    p.g.visible = !!f;
    if (!f) return;
    p.t = (p.t + dt / 1.4) % 1;
    const r = f.radius || 2;
    p.ring.position.set(f.pos.x, (f.ground ?? 0) + 0.06, f.pos.z);
    p.ring.scale.setScalar(r);
    p.wave.position.copy(p.ring.position);
    p.wave.scale.setScalar(r * (1 + p.t * 0.9));
    p.wave.material.opacity = 0.75 * (1 - p.t);
    if (f.box) {
      p.box.visible = true;
      p.box.position.set(f.pos.x, f.pos.y, f.pos.z);
      p.box.scale.set(f.box.x, f.box.y, f.box.z);
      p.box.material.opacity = 0.55 + 0.45 * Math.sin(p.t * Math.PI * 2);
    } else {
      p.box.visible = false;
    }
    if (this.following) {
      const k = 1 - Math.exp(-dt * 4);
      const dx = (f.pos.x - this.controls.target.x) * k;
      const dz = (f.pos.z - this.controls.target.z) * k;
      this.controls.target.x += dx;
      this.controls.target.z += dz;
      this.camera.position.x += dx;
      this.camera.position.z += dz;
    }
  }

  // ------------------------------------------------------------------ bucle

  resize() {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.labelRenderer.setSize(w, h);
    if (!this.content) return;
    // Mientras el usuario no haya movido la cámara, se reencuadra al cambiar el tamaño.
    if (this.userMoved) this._frustum();
    else this.resetView();
  }

  update(dt) {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const k = ease(tw.t);
      const target = tw.from.target.clone().lerp(tw.to.target, k);
      const dir = tw.from.dir.clone().lerp(tw.to.dir, k).normalize();
      const zoom = Math.exp(Math.log(tw.from.zoom) + (Math.log(tw.to.zoom) - Math.log(tw.from.zoom)) * k);
      this._apply({ target, dir, zoom });
      if (tw.t >= 1) this.tween = null;
    }
    this.content?.update(dt);
    this._updatePulse(dt);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      this.onSelect(this._pick(e));
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
    if (!this.content) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.content.pick(this.raycaster);
  }
}

// Utilidades comunes a los contenidos.

export function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...extra });
}

export function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
  });
}

// Etiqueta 3D con barra de progreso opcional («E-02 · 82 %» con su barrita, como en un panel de planta).
// set(texto, fraccion|null, clase) solo toca el DOM si algo cambia.
export function progressLabel(el) {
  el.innerHTML = '<span class="t"></span><i class="pb"><b></b></i>';
  const t = el.firstChild;
  const bar = el.lastChild;
  const fill = bar.firstChild;
  let last = '';
  return (texto, frac = null, tone = '') => {
    const key = `${texto}|${frac == null ? '' : Math.round(frac * 100)}|${tone}`;
    if (key === last) return;
    last = key;
    t.textContent = texto;
    bar.hidden = frac == null;
    if (frac != null) fill.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
    bar.className = `pb ${tone}`;
  };
}
