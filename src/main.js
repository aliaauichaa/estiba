import './style.css';
import { SHIFT_START, SHIFT_END, fmt } from './sim/engine.js';
import { Stage } from './scene/stage.js';
import { mediaEn } from './analysis/history.js';
import { API_URL, answerRemote } from './analysis/remote.js';
import { esPreguntaSobreAli } from '../lambda/asistente/ruta.mjs';
import { ShiftChart } from './ui/chart.js';
import { tx, lang, setLang, onLang, num, ppUnit } from './i18n.js';
import { md, esc } from './ui/md.js';
import { OPERATIVAS } from './ops/index.js';

// Modo «en vivo»: el reloj es la hora real de España, minuto a minuto. El turno es de 06:00 a 22:00;
// de noche se reproduce el turno de día en diferido (22:00 → 10:00, 06:00 → 18:00) para que siempre
// haya actividad, con su aviso. Vale para las tres operativas.
const NIGHT_REPLAY_FROM = 10 * 60;

function madridNow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return get('hour') * 60 + get('minute') + get('second') / 60;
}

function liveTarget() {
  const real = madridNow();
  if (real >= SHIFT_START && real < SHIFT_END) return { t: real, replay: false, real };
  const intoNight = (real - SHIFT_END + 1440) % 1440;
  return { t: NIGHT_REPLAY_FROM + intoNight, replay: true, real };
}

// Textos fijos de index.html: [selector, propiedad, es, en].
const STATIC = [
  ['.brand-text small', 'textContent', 'Gemelo digital de operaciones', 'Operations digital twin'],
  ['#ops', 'aria-label', 'Operativas', 'Operations'],
  ['#modes', 'aria-label', 'Vista', 'View'],
  ['#cams', 'aria-label', 'Cámara', 'Camera'],
  ['#loading', 'textContent', 'Montando la escena…', 'Building the scene…'],
  ['#tracker', 'aria-label', 'Seguimiento', 'Tracking'],
  ['[data-tr="min"]', 'aria-label', 'Plegar', 'Collapse'],
  ['#kpis', 'aria-label', 'Indicadores', 'Indicators'],
  ['[data-tr="prev"]', 'aria-label', 'Anterior', 'Previous'],
  ['[data-tr="next"]', 'aria-label', 'Siguiente', 'Next'],
  ['.chart-card h3', 'textContent', 'Ritmo del turno', 'Shift pace'],
  ['.feed-card h3', 'textContent', 'Lo que está pasando', 'What is happening'],
  ['.foot span:first-child', 'textContent', 'Datos simulados: pedidos, proveedores, volúmenes e incidencias son ficticios. Las marcas de última milla se citan solo como ejemplo de cliente.', 'Simulated data: orders, suppliers, volumes and incidents are fictitious. Last-mile brands are named only as example customers.'],
  ['.foot span:last-child', 'innerHTML', 'Proyecto de <a href="https://www.linkedin.com/in/ali-aauicha/" target="_blank" rel="noopener">Ali Aauicha</a> · Three.js + simulación propia', 'A project by <a href="https://www.linkedin.com/in/ali-aauicha/" target="_blank" rel="noopener">Ali Aauicha</a> · Three.js + custom simulation'],
  ['#ai-teaser b', 'textContent', 'Pregunta a la IA', 'Ask the AI'],
  ['.ai-fab-tag', 'textContent', 'IA', 'AI'],
  ['#ai-teaser .teaser-x', 'aria-label', 'Cerrar aviso', 'Close'],
  ['#ai-fab', 'aria-label', 'Abrir el asistente de operaciones con IA', 'Open the AI operations assistant'],
  ['#ai-panel', 'aria-label', 'Asistente de operaciones', 'Operations assistant'],
  ['.ai-top-info b', 'textContent', 'Asistente de operaciones', 'Operations assistant'],
  ['#ai-close', 'aria-label', 'Cerrar el asistente', 'Close the assistant'],
  ['#ai-input', 'aria-label', 'Tu pregunta', 'Your question'],
  ['#ai-send', 'aria-label', 'Enviar', 'Send'],
];

const $ = (s) => document.querySelector(s);
const state = {
  op: null,
  sim: null,
  variant: null,
  tab: null,
  sel: null,
  mode: null,
  history: new Map(),
  chats: new Map(),
  dots: new Map(),
  track: { modo: null, key: null, min: false },
  toastFrom: 0,
  alertLast: new Map(),
  lastEvents: null,
};

const stage = new Stage($('#viewport'), { onSelect: (sel) => select(sel) });
stage.onFollow = () => paintCams();
const chart = new ShiftChart($('#chart'));

// Lo que una operativa puede pedirle a la página desde sus paneles (onAct).
const ui = {
  get sel() { return state.sel; },
  get variant() { return state.variant; },
  setMode: (m) => setMode(m),
  setTab: (t) => setTab(t),
  setVariant(v) { state.variant = v; resetDay(state.sim.t); },
  select: (sel, opts) => select(sel, opts),
  ask: (q) => ask(q),
};

// ---------------------------------------------------------------------------- montaje de la página

function buildChrome() {
  $('#ops').innerHTML = OPERATIVAS.map((o) => `<button class="site-btn" data-op="${o.id}"><span class="dot" id="dot-${o.id}"></span><span class="op-name"></span> <small></small></button>`).join('');
  $('#ops').addEventListener('click', (e) => {
    const b = e.target.closest('[data-op]');
    if (b && b.dataset.op !== state.op?.id) loadOp(b.dataset.op);
  });
  $('#modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('#cams').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { stage.setView(v.dataset.view); paintCams(v.dataset.view); return; }
    if (e.target.closest('[data-follow]')) { stage.follow(!stage.following); paintCams(); }
  });
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  $('#tab-body').addEventListener('click', onPanelClick);
  $('#tracker').addEventListener('click', onTrackerClick);
  $('#toasts').addEventListener('click', onToastClick);
  $('#lang').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLang(b.dataset.lang);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'Escape') select(null);
  });
  new ResizeObserver(() => syncTrackerHeight()).observe($('#tracker'));
}

// Todo lo que depende del idioma o de la operativa y no se repinta solo en cada refresco.
function paintLabels() {
  const op = state.op;
  document.documentElement.lang = lang;
  document.title = tx('Estiba · Gemelo digital de operaciones logísticas', 'Estiba · Logistics operations digital twin');
  for (const [sel, prop, es, en] of STATIC) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (prop === 'textContent' || prop === 'innerHTML') el[prop] = tx(es, en);
    else el.setAttribute(prop, tx(es, en));
  }
  for (const b of document.querySelectorAll('#ops [data-op]')) {
    const o = OPERATIVAS.find((x) => x.id === b.dataset.op);
    b.querySelector('.op-name').textContent = o.nombre();
    b.querySelector('small').textContent = o.sub();
    b.classList.toggle('on', o === op);
  }
  if (!op) return;
  const modes = op.content.modes;
  $('#modes').hidden = modes.length < 2;
  $('#modes').innerHTML = modes.map((m) => `<button data-mode="${m.id}" class="${m.id === state.mode ? 'on' : ''}">${esc(m.nombre)}</button>`).join('');
  $('#tabs').innerHTML = op.tabs.map((t) => `<button class="tab ${t.id === state.tab ? 'on' : ''}" role="tab" data-tab="${t.id}"><span class="tab-name">${esc(t.nombre())}</span><span class="badge" id="badge-${t.id}" hidden></span></button>`).join('');
  $('#kpis').innerHTML = op.kpis.map((k) => `<div class="kpi" id="kpi-${k.id}"><div class="k-label"><abbr title="${esc(k.tip())}">${esc(k.label())}</abbr></div><div class="k-value">—</div><div class="k-delta flat">&nbsp;</div><svg class="spark" viewBox="0 0 64 22" preserveAspectRatio="none"></svg></div>`).join('');
  $('#hint').textContent = op.hint();
  $('#chart-legend').innerHTML = op.chart.legend().map((l) => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join('');
  $('#ai-quick').innerHTML = op.asistente.sugerencias().map((q) => `<button type="button" class="chip" data-ask="${esc(q)}">${esc(q)}</button>`).join('');
  $('#ai-teaser span').textContent = op.asistente.teaser();
  $('#ai-input').placeholder = op.asistente.placeholder();
  $('#tr-modes').innerHTML = op.tracker.modos.map((m) => `<button type="button" data-tr-modo="${m.id}">${esc(m.nombre())}</button>`).join('');
  for (const b of document.querySelectorAll('#lang [data-lang]')) {
    b.classList.toggle('on', b.dataset.lang === lang);
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  }
  setMode(state.mode);
  paintCams();
}

onLang(() => {
  // Si se entró con ?lang=, la URL se actualiza para que al recargar o compartir salga el idioma elegido.
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has('lang')) { u.searchParams.set('lang', lang); window.history.replaceState(null, '', u); }
  } catch { /* sin history */ }
  paintLabels();
  hideToasts();
  state.op?.content.relabel();
  panelSig = '';
  state.lastEvents = null;
  trackSig = '';
  if (state.sim) {
    refreshAll();
    renderPanel(true);
    lastDots = -1;
  }
  if (state.chatOpen) renderChat();
});

function setMode(mode) {
  const op = state.op;
  if (!op) return;
  const modes = op.content.modes;
  state.mode = modes.some((m) => m.id === mode) ? mode : modes[0].id;
  op.content.setMode(state.mode);
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === state.mode);
  $('#legend').innerHTML = op.legend(state.mode);
}

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('on', b.dataset.tab === tab);
  renderPanel(true);
}

// Barra de cámara: encuadres de la operativa y, si lo seleccionado se mueve, «seguir».
function paintCams(activa = null) {
  const op = state.op;
  if (!op?.content.sim) return;
  const views = op.content.views();
  const f = state.sel ? op.content.focusOf(state.sel) : null;
  const seguir = f?.follow
    ? `<button type="button" class="follow ${stage.following ? 'on' : ''}" data-follow>${stage.following ? tx('Siguiendo', 'Following') : tx('Seguir', 'Follow')} ${esc(String(state.sel.id))}</button>`
    : '';
  $('#cams').innerHTML = `<span class="cams-l">${tx('Cámara', 'Camera')}</span>${views.map((v) => `<button type="button" data-view="${v.id}" class="${v.id === activa ? 'on' : ''}">${esc(v.nombre)}</button>`).join('')}${seguir}`;
}

// ---------------------------------------------------------------------------- operativas

function loadOp(id, at = liveTarget().t) {
  const op = OPERATIVAS.find((o) => o.id === id) || OPERATIVAS[0];
  state.op = op;
  state.variant = null;
  state.tab = op.tabs[0].id;
  state.mode = op.content.modes[0].id;
  state.track = { modo: op.tracker.modos[0].id, key: null, min: state.track.min };
  try {
    const u = new URL(window.location.href);
    u.searchParams.set('op', op.id);
    window.history.replaceState(null, '', u);
  } catch { /* sin history */ }
  hideToasts();
  paintLabels();
  resetDay(at, true);
  paintCams();
  renderPanel(true);
  if (state.chatOpen) renderChat();
  if (!state.history.has(op.id)) {
    state.history.set(op.id, null);
    op.historia().then((h) => {
      state.history.set(op.id, h);
      if (state.op === op) refreshAll();
      lastDots = -1;
    });
  }
}

function resetDay(at = SHIFT_START, nueva = false) {
  const op = state.op;
  const sim = op.crearSim(state.variant);
  if (at > SHIFT_START) sim.advance(at - SHIFT_START);
  state.sim = sim;
  state.lastEvents = null;
  state.sel = null;
  // Lo que ya ha pasado al cargar no salta como aviso; solo lo nuevo.
  state.toastFrom = sim.t;
  state.alertLast = new Map([...op.alertas(sim).keys()].map((k) => [k, sim.t]));
  stage.setContent(op.content, sim);
  if (nueva) stage.resetView();
  op.content.setMode(state.mode);
  $('#feed').innerHTML = '';
  refreshAll();
  paintCams();
  const ld = $('#loading');
  if (!ld.hidden) { ld.classList.add('done'); setTimeout(() => { ld.hidden = true; }, 450); }
}

function currentHistory() {
  return state.history.get(state.op.id) || null;
}

// Punto de estado de cada operativa en el selector: la misma hora del día en las tres.
var lastDots = -1; // var: onLang() la reinicia y se registra antes de esta línea
function paintDots() {
  const t = state.sim.t;
  for (const op of OPERATIVAS) {
    const sim = op === state.op ? state.sim : op.simA(t);
    const e = op.asistente.estado(sim, state.history.get(op.id) || null);
    const el = document.getElementById(`dot-${op.id}`);
    if (!el) continue;
    el.className = `dot ${e.nivel}`;
    el.title = e.titulo;
  }
}

// ---------------------------------------------------------------------------- selección y paneles

// keepTrack: el «Ver» del propio seguimiento no cambia lo que se está siguiendo.
function select(sel, { fly = false, keepTrack = false } = {}) {
  state.sel = sel;
  stage.select(sel, { fly });
  const t = sel && !keepTrack ? state.op.tracker.desdeSel(state.sim, sel) : null;
  if (t) { state.track.modo = t.modo; state.track.key = t.key; trackSig = ''; paintTracker(); }
  paintCams();
  if (sel && state.tab !== state.op.tabs[0].id) setTab(state.op.tabs[0].id);
  else renderPanel(true);
}

function onPanelClick(e) {
  const s = e.target.closest('[data-sel]');
  if (s) {
    const v = s.dataset.sel;
    if (v === 'none') return select(null);
    const i = v.indexOf(':');
    return select(state.op.parseSel(v.slice(0, i), v.slice(i + 1)), { fly: true });
  }
  const tr = e.target.closest('[data-track]');
  if (tr) {
    const [modo, key] = tr.dataset.track.split('|');
    state.track = { ...state.track, modo, key, min: false };
    trackSig = '';
    paintTracker();
    return;
  }
  const a = e.target.closest('[data-act]');
  if (a) return state.op.onAct(a.dataset.act, ui, a.dataset);
  const v = e.target.closest('[data-view]');
  if (v) { stage.setView(v.dataset.view); return paintCams(v.dataset.view); }
  const chip = e.target.closest('[data-ask]');
  if (chip) ask(chip.dataset.ask);
}

var panelSig = ''; // var: ídem
function renderPanel(force = false) {
  const body = $('#tab-body');
  if (!state.sim) return;
  const html = state.op.renderTab(state.tab, state.sim, ui);
  if (!force && html === panelSig) return;
  panelSig = html;
  const top = body.scrollTop;
  body.innerHTML = html;
  if (!force) body.scrollTop = top;
}

// ---------------------------------------------------------------------------- seguimiento por pasos

var trackSig = ''; // var: ídem
function paintTracker() {
  const op = state.op;
  const sim = state.sim;
  const tk = state.track;
  $('#tracker').classList.toggle('min', tk.min);
  const items = op.tracker.items(sim, tk.modo);
  if (!items.includes(tk.key)) tk.key = items[0] ?? null;
  const v = tk.key != null ? op.tracker.vista(sim, tk.modo, tk.key) : null;
  for (const b of document.querySelectorAll('#tr-modes [data-tr-modo]')) b.classList.toggle('on', b.dataset.trModo === tk.modo);
  // Los botones van fuera de la firma: la lista se reordena sin cambiar de tamaño (p. ej. al parar la línea).
  const pos = items.indexOf(tk.key);
  $('#tracker [data-tr="prev"]').disabled = pos <= 0;
  $('#tracker [data-tr="next"]').disabled = pos < 0 || pos >= items.length - 1;
  const sig = JSON.stringify([lang, tk, v && { ...v, lado: v.lado && { ...v.lado, pct: v.lado.pct == null ? null : Math.round(v.lado.pct * 100) } }, items.length]);
  if (sig === trackSig) return;
  trackSig = sig;
  $('#tr-title').textContent = op.tracker.titulo(tk.modo);
  $('#tr-id').textContent = v ? v.titulo : '';
  $('#tr-sub').textContent = v ? v.sub : tx('Nada que seguir ahora mismo', 'Nothing to track right now');
  $('#tr-steps').innerHTML = v ? v.pasos.map((p) => `<li class="${p.estado}"><i aria-hidden="true">${p.estado === 'done' ? '✓' : p.estado === 'bad' ? '!' : ''}</i><b>${esc(p.label)}</b><small>${esc(p.det)}</small></li>`).join('') : '';
  const l = v?.lado;
  $('#tr-side').hidden = !l;
  if (l) {
    $('#tr-side').innerHTML = `<small>${esc(l.etiqueta)}</small><b>${esc(l.titulo)}</b><span>${esc(l.sub || '')}</span>${l.pct != null ? `<div class="bar"><span style="width:${Math.round(l.pct * 100)}%"></span></div>` : ''}${l.sel ? `<button type="button" class="btn secondary sm" data-tr="ver">${tx('Ver', 'View')}</button>` : ''}`;
  }
}

function onTrackerClick(e) {
  const m = e.target.closest('[data-tr-modo]');
  const tk = state.track;
  if (m) { tk.modo = m.dataset.trModo; tk.key = null; tk.min = false; trackSig = ''; return paintTracker(); }
  const b = e.target.closest('[data-tr]');
  if (!b) return;
  const items = state.op.tracker.items(state.sim, tk.modo);
  const pos = items.indexOf(tk.key);
  if (b.dataset.tr === 'prev' && pos > 0) tk.key = items[pos - 1];
  if (b.dataset.tr === 'next' && pos < items.length - 1) tk.key = items[pos + 1];
  if (b.dataset.tr === 'min') tk.min = !tk.min;
  if (b.dataset.tr === 'ver') {
    const v = state.op.tracker.vista(state.sim, tk.modo, tk.key);
    if (v?.lado?.sel) select(v.lado.sel, { fly: true, keepTrack: true });
  }
  trackSig = '';
  paintTracker();
}

function syncTrackerHeight() {
  const h = $('#tracker').offsetHeight;
  $('#viewport').style.setProperty('--trh', `${h}px`);
  const top = window.innerWidth > 640 ? 64 : 0;
  const bottom = h + 14;
  if (stage.pad.bottom !== bottom || stage.pad.top !== top) {
    stage.pad = { top, bottom };
    if (!stage.userMoved && state.op) stage.resetView();
  }
}

// ---------------------------------------------------------------------------- avisos emergentes

const TOAST_MS = 9000;
const toasts = [];

function pushToast(t) {
  if (t.clave && toasts.some((x) => x.clave === t.clave)) return;
  const id = Math.random().toString(36).slice(2);
  toasts.unshift({ ...t, id, hora: fmt(state.sim.t) });
  while (toasts.length > 3) toasts.pop();
  paintToasts();
  setTimeout(() => dropToast(id), TOAST_MS);
}

function dropToast(id) {
  const i = toasts.findIndex((x) => x.id === id);
  if (i < 0) return;
  if (toasts[i].hover) { setTimeout(() => dropToast(id), 2500); return; }
  toasts.splice(i, 1);
  paintToasts();
}

function hideToasts() {
  toasts.length = 0;
  paintToasts();
}

function paintToasts() {
  $('#toasts').innerHTML = toasts.map((t) => `<div class="toast ${t.nivel || 'info'}" data-toast="${t.id}">
    <div class="toast-top"><b>${esc(t.titulo)}</b><time>${t.hora}</time><button type="button" class="toast-x" data-toast-x aria-label="${tx('Cerrar', 'Close')}">×</button></div>
    <p>${esc(t.texto)}</p>
    ${t.ver || t.vista || t.tab || t.ia ? `<div class="toast-acts">${t.ver || t.vista || t.tab ? `<button type="button" data-toast-ver>${tx('Ver', 'View')}</button>` : ''}${t.ia ? `<button type="button" data-toast-ia>${tx('Pregunta a la IA', 'Ask the AI')}</button>` : ''}</div>` : ''}
  </div>`).join('');
}

function onToastClick(e) {
  const el = e.target.closest('[data-toast]');
  if (!el) return;
  const t = toasts.find((x) => x.id === el.dataset.toast);
  if (!t) return;
  if (e.target.closest('[data-toast-x]')) return dropToast(t.id);
  if (e.target.closest('[data-toast-ver]')) {
    if (t.ver) select(t.ver, { fly: true });
    else if (t.vista) { stage.setView(t.vista); paintCams(t.vista); }
    if (t.tab && !t.ver) setTab(t.tab);
  }
  if (e.target.closest('[data-toast-ia]')) ask(t.ia);
}

$('#toasts').addEventListener('pointerover', (e) => { const el = e.target.closest('[data-toast]'); const t = el && toasts.find((x) => x.id === el.dataset.toast); if (t) t.hover = true; });
$('#toasts').addEventListener('pointerout', (e) => { const el = e.target.closest('[data-toast]'); const t = el && toasts.find((x) => x.id === el.dataset.toast); if (t) t.hover = false; });

function checkToasts() {
  const sim = state.sim;
  const op = state.op;
  const nuevos = sim.events.filter((e) => e.t > state.toastFrom);
  state.toastFrom = sim.t;
  // Si de golpe hay muchos (la pestaña estuvo en segundo plano), solo los tres últimos.
  for (const e of nuevos.slice(-3)) {
    const t = op.toast(e, sim);
    if (t) pushToast({ nivel: e.nivel, texto: e.texto, ...t });
  }
  // Una alerta solo vuelve a avisar si ha estado más de 15 min (simulados) sin cumplirse: si la condición
  // oscila alrededor del umbral no sale en ráfagas.
  for (const [k, t] of op.alertas(sim)) {
    const last = state.alertLast.get(k);
    if (last == null || sim.t - last > 15) pushToast(t);
    state.alertLast.set(k, sim.t);
  }
}

// ---------------------------------------------------------------------------- asistente

function chatLog() {
  const id = state.op.id;
  if (!state.chats.has(id)) state.chats.set(id, [{ who: 'bot', welcome: true }]);
  return state.chats.get(id);
}

// El asistente vive en una burbuja flotante (como en Mi Campo y Quillaflow), siempre a mano.
function renderChat() {
  const log = chatLog();
  const op = state.op;
  $('#ai-sub').textContent = `${op.nombre()} · ${API_URL ? tx('Claude en Amazon Bedrock', 'Claude on Amazon Bedrock') : tx('datos del turno en directo', 'live shift data')}`;
  const box = $('#ai-msgs');
  box.innerHTML = log.map((m) => `<div class="msg ${m.who}">${m.who === 'bot' ? md(m.welcome ? op.asistente.bienvenida() : m.text) : esc(m.text)}${m.src ? `<div class="src">${esc(m.src)}</div>` : ''}</div>`).join('')
    + (log.pending ? '<div class="msg bot"><span class="typing"><i></i><i></i><i></i></span></div>' : '');
  box.scrollTop = box.scrollHeight;
  $('#ai-send').disabled = !!log.pending;
}

function openChat(open = true) {
  state.chatOpen = open;
  $('#ai-panel').hidden = !open;
  $('#ai-fab').hidden = open;
  $('#ai-fab').setAttribute('aria-expanded', String(open));
  hideTeaser();
  document.documentElement.classList.toggle('ai-open', open);
  if (open) {
    fitChatToViewport();
    renderChat();
    // En móvil no se abre el teclado solo: taparía el mensaje de bienvenida y las sugerencias.
    if (!isTouch()) setTimeout(() => $('#ai-input').focus(), 50);
  } else {
    $('#ai-fab').focus({ preventScroll: true });
  }
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

// Safari de iPhone: un panel position:fixed no sigue al teclado (ni con dvh); al abrirlo, la
// cabecera y los mensajes se quedaban por encima de la zona visible. Se ajusta a mano al
// visualViewport, igual que el chat de Quillaflow.
function fitChatToViewport() {
  const panel = $('#ai-panel');
  const vv = window.visualViewport;
  if (!vv || !state.chatOpen || window.innerWidth > 640) {
    panel.style.top = '';
    panel.style.height = '';
    return;
  }
  panel.style.top = `${Math.round(vv.offsetTop + 8)}px`;
  panel.style.height = `${Math.round(vv.height - 16)}px`;
  const box = $('#ai-msgs');
  box.scrollTop = box.scrollHeight;
}

function hideTeaser() {
  $('#ai-teaser').hidden = true;
}

function buildChat() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitChatToViewport);
    window.visualViewport.addEventListener('scroll', fitChatToViewport);
  }
  window.addEventListener('resize', fitChatToViewport);
  $('#ai-fab').addEventListener('click', () => openChat(true));
  $('#ai-close').addEventListener('click', () => openChat(false));
  $('#ai-teaser').addEventListener('click', (e) => {
    if (e.target.closest('.teaser-x')) return hideTeaser();
    openChat(true);
  });
  $('#ai-teaser').addEventListener('keydown', (e) => { if (e.key === 'Enter') openChat(true); });
  $('#ai-panel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); openChat(false); } });
  $('#ai-quick').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ask]');
    if (chip) ask(chip.dataset.ask);
  });
  $('#ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#ai-input').value.trim();
    if (!v) return;
    $('#ai-input').value = '';
    ask(v);
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-open-ai]');
    if (a) { e.preventDefault(); openChat(true); }
  });
  // Aviso para que se vea que hay IA: aparece a los pocos segundos y se va solo.
  setTimeout(() => { if (!state.chatOpen) $('#ai-teaser').hidden = false; }, 2500);
  setTimeout(hideTeaser, 14000);
}

async function ask(q) {
  const log = chatLog();
  if (log.pending) return;
  if (!state.chatOpen) openChat(true);
  log.push({ who: 'user', text: q });
  log.pending = true;
  renderChat();
  const op = state.op;
  const A = op.asistente;
  const c = A.ctx(state.sim, currentHistory());
  const hora = fmt(c.sim.t);
  const hist = log.filter((m) => m.who && !m.welcome).slice(-7, -1).map((m) => ({ rol: m.who === 'user' ? 'usuario' : 'asistente', texto: m.text }));
  // Sin Lambda (o si falla), la respuesta local decide sola con el hilo y los nombres de la operativa.
  const local = A.answerLocal(q, c, { historial: hist });
  const localEsDeAli = esPreguntaSobreAli(q, hist, A.contextoDeRuta(c.sim));
  const calculado = tx(`Calculado con los datos del turno a las ${hora}`, `Computed from the shift data at ${hora}`);
  let text = local;
  // Las preguntas sobre Ali no salen de los datos del turno: sin etiqueta de «calculado con…».
  let src = localEsDeAli ? '' : calculado;
  if (API_URL) {
    try {
      const r = await answerRemote(q, { contexto: A.contexto(c), respuestaBase: A.answerLocal(q, c, { sinAcciones: true }) }, hist);
      // Manda el tema que decidió la Lambda. Si es del turno y descartó la redacción del modelo, llega la
      // respuesta base (calculada sin hilo): se enseña la local del turno, no la presentación de Ali.
      if (r.tema === 'ali') {
        text = r.texto;
        src = tx('Redactado por Claude (Amazon Bedrock) con la ficha de Ali', "Written by Claude (Amazon Bedrock) from Ali's profile");
      } else if (r.fuente === 'modelo') {
        text = r.texto;
        src = tx(`Redactado por Claude (Amazon Bedrock) con el diagnóstico de las ${hora}`, `Written by Claude (Amazon Bedrock) from the ${hora} diagnosis`);
      } else {
        text = localEsDeAli ? A.answerLocal(q, c) : local;
        src = calculado;
      }
    } catch {
      text = local;
    }
  } else {
    await new Promise((r) => setTimeout(r, 350));
  }
  log.pending = false;
  log.push({ who: 'bot', text, src });
  if (state.chatOpen && log === chatLog()) renderChat();
}

// ---------------------------------------------------------------------------- indicadores

function spark(svg, today, base, field) {
  const vals = today.map((h) => h[field]).filter((v) => v != null);
  if (vals.length < 2) { svg.innerHTML = ''; return; }
  const bvals = [];
  if (base) for (const h of today) bvals.push(base.hourly.get(h.hora)?.[field] ?? null);
  const all = [...vals, ...bvals.filter((v) => v != null)];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pts = (arr) => arr.map((v, i) => (v == null ? null : `${(i / (arr.length - 1)) * 62 + 1},${21 - ((v - lo) / (hi - lo)) * 20}`)).filter(Boolean).join(' ');
  const series = today.map((h) => h[field] ?? null);
  svg.innerHTML = `${bvals.length ? `<polyline points="${pts(bvals)}" fill="none" stroke="#5d6a7d" stroke-width="1" stroke-dasharray="2 2"/>` : ''}<polyline points="${pts(series)}" fill="none" stroke="#f5a524" stroke-width="1.5"/>`;
}

function paintKpis() {
  const sim = state.sim;
  const k = sim.kpis();
  const hist = currentHistory();
  const b = mediaEn(hist, sim.t);
  for (const def of state.op.kpis) {
    const el = document.getElementById(`kpi-${def.id}`);
    if (!el) continue;
    const v = k[def.id];
    el.querySelector('.k-value').innerHTML = def.f(v, k);
    // Con muy pocos datos (los primeros coches o entregas, el arranque del turno) no se compara.
    const pocos = (def.minN && !def.minN(k)) || (def.desde && sim.t < def.desde);
    const bv = pocos ? null : b?.[def.baseKey || def.id];
    const dEl = el.querySelector('.k-delta');
    let alert = false;
    if (v != null && bv != null) {
      const diff = v - bv;
      const isPct = def.unit === 'pp';
      const shown = isPct ? diff * 100 : diff;
      // «≈ media» si la diferencia es pequeña: en p. p., o un mínimo absoluto (minDiff) o un % de la media (tol).
      const small = isPct ? Math.abs(shown) < 0.5 : Math.abs(diff) < Math.max(def.minDiff ?? 1, Math.abs(bv) * (def.tol ?? 0.05));
      const good = def.up ? diff > 0 : diff < 0;
      const txt = `${shown > 0 ? '▲' : '▼'} ${num(Math.abs(shown), isPct ? 1 : 0)}${isPct ? ppUnit() : def.unit === 'min' ? ' min' : ''} ${tx('vs media', 'vs avg')}`;
      dEl.textContent = small ? tx('≈ media 14 días', '≈ 14-day average') : txt;
      dEl.className = `k-delta ${small ? 'flat' : good ? 'good' : 'bad'}`;
      const rel = Math.abs(diff) / (Math.abs(bv) || 1);
      alert = !small && !good && (isPct ? Math.abs(shown) > 4 : rel > 0.5);
    } else {
      dEl.textContent = !hist ? tx('calculando media…', 'computing average…') : v == null ? (def.vacio?.() || tx('aún sin datos', 'no data yet')) : pocos ? tx('aún pocos datos', 'not enough data yet') : ' ';
      dEl.className = 'k-delta flat';
    }
    el.classList.toggle('alert', alert);
    spark(el.querySelector('svg'), sim.hourly, hist, def.baseKey || def.id);
  }
  $('#clock').textContent = fmt(Math.floor(sim.clock ?? sim.t));
  const live = liveTarget();
  $('#live').classList.toggle('replay', live.replay);
  $('#live-label').textContent = live.replay ? tx('EN DIFERIDO', 'REPLAY') : tx('EN VIVO', 'LIVE');
  $('#live').title = live.replay
    ? tx(`En España son las ${fmt(Math.floor(live.real))}: de noche no se opera y se reproduce el turno de día.`, `It is ${fmt(Math.floor(live.real))} in Spain: there is no night shift, so the day shift is replayed.`)
    : tx('Hora real de España: la simulación avanza minuto a minuto.', 'Real time in Spain: the simulation runs minute by minute.');
  $('#shift').textContent = live.replay
    ? `${tx('Turno de día en diferido', 'Day shift replay')} · ${state.op.lugar()}`
    : `${tx('Hora de España', 'Spain time')} · ${state.op.lugar()}`;
}

function paintBanner() {
  const html = state.op.banner(state.sim);
  const el = $('#banner');
  el.hidden = !html;
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
}

function paintFeed() {
  const ev = state.sim.events;
  const last = ev[ev.length - 1] || null;
  if (last === state.lastEvents && state.lastEvents !== null) return;
  state.lastEvents = last;
  const items = ev.slice(-80).reverse().map((e) => `<li class="${e.nivel}"><time>${fmt(e.t)}</time><span>${esc(e.texto)}</span></li>`).join('');
  $('#feed').innerHTML = items;
  $('#feed-count').textContent = tx(`${ev.length} eventos`, `${ev.length} events`);
}

function paintBadges() {
  const b = state.op.badges(state.sim);
  for (const t of state.op.tabs) {
    const el = document.getElementById(`badge-${t.id}`);
    if (!el) continue;
    const n = b[t.id] || 0;
    el.hidden = !n;
    el.textContent = n;
  }
}

function refreshAll() {
  paintKpis();
  paintBanner();
  paintFeed();
  paintBadges();
  paintTracker();
  checkToasts();
  chart.render(state.sim, currentHistory(), state.op.chart);
  renderPanel(false);
  const slot = Math.floor(state.sim.t / 60);
  if (slot !== lastDots) {
    lastDots = slot;
    paintDots();
  }
}

// ---------------------------------------------------------------------------- bucle

let prev = performance.now();
let acc = 0;
let palAcc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (state.sim) {
    // La simulación sigue al reloj real. Si el objetivo queda por detrás (de día a diferido a las
    // 22:00, o de vuelta a las 06:00), se vuelve a simular el día hasta la hora que toca.
    const target = liveTarget().t;
    const cur = state.sim.clock ?? state.sim.t;
    if (target < cur - 1) resetDay(target);
    else if (target > cur) state.sim.advance(Math.min(target - cur, 30));
  }
  stage.update(dt);
  stage.render();
  acc += dt;
  palAcc += dt;
  if (palAcc > 0.35) { palAcc = 0; state.op?.content.refresh(); }
  if (acc > 0.5) { acc = 0; refreshAll(); }
  requestAnimationFrame(frame);
}

buildChrome();
buildChat();
let inicial = OPERATIVAS[0].id;
try {
  const q = new URLSearchParams(window.location.search).get('op');
  if (OPERATIVAS.some((o) => o.id === q)) inicial = q;
} catch { /* sin window */ }
loadOp(inicial);
// El histórico del resto de operativas se calcula en segundo plano (para los puntos de estado).
setTimeout(async () => {
  for (const op of OPERATIVAS) {
    if (state.history.has(op.id)) continue;
    state.history.set(op.id, null);
    state.history.set(op.id, await op.historia());
  }
  lastDots = -1;
}, 1500);
requestAnimationFrame(frame);

window.__estiba = state; // para depurar desde la consola
window.__stage = stage;
