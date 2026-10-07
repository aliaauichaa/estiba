import './style.css';
import { SITES } from './data/sites.js';
import { Simulation, SHIFT_START, SHIFT_END, fmt, runDay } from './sim/engine.js';
import { WarehouseScene, MODES } from './scene/warehouse3d.js';
import { computeHistory, baselineAt } from './analysis/history.js';
import { analyzeSlotting } from './analysis/optimize.js';
import { answerLocal, diagnose, sugerencias } from './analysis/assistant.js';
import { API_URL, answerRemote } from './analysis/remote.js';
import { ShiftChart, chartLegend } from './ui/chart.js';
import { tx, lang, setLang, onLang, pct, num, ppUnit } from './i18n.js';
import { renderOverview, renderSelection, renderRoutes, renderOpt, riskCount } from './ui/panels.js';
import { md, esc } from './ui/md.js';

// Modo «en vivo»: el reloj del almacén es la hora real de España, minuto a minuto. El turno es de
// 06:00 a 22:00; de noche se reproduce el turno de día en diferido (22:00 → 10:00, 06:00 → 18:00)
// para que siempre haya actividad, con su aviso.
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
const TABS = [
  { id: 'detalle', nombre: () => tx('Operativa', 'Operations') },
  { id: 'rutas', nombre: () => tx('Expediciones', 'Dispatch') },
  { id: 'opt', nombre: () => tx('Optimización', 'Optimisation') },
];
const KPIS = [
  { id: 'otif', label: () => 'OTIF', tip: () => tx('Pedidos que salen a tiempo y completos', 'Orders shipped on time and in full'), f: (v) => pct(v), up: true, unit: 'pp' },
  { id: 'fill', label: () => 'Fill rate', tip: () => tx('Líneas servidas completas', 'Lines shipped in full'), f: (v) => pct(v), up: true, unit: 'pp' },
  { id: 'dts', label: () => 'Dock-to-stock', tip: () => tx('Minutos desde que el camión atraca hasta que el palé está ubicado', 'Minutes from the truck docking to the pallet being put away'), f: (v) => (v == null ? '—' : `${num(v)}<small>min</small>`), up: false, unit: 'min' },
  { id: 'utilizacion', label: () => tx('Uso de equipos', 'Equipment use'), tip: () => tx('Tiempo trabajando sobre tiempo disponible de las carretillas', 'Forklift working time over available time'), f: (v) => pct(v, 0), up: false, unit: 'pp' },
  { id: 'productividad', label: () => tx('Líneas/h·equipo', 'Lines/h per truck'), tip: () => tx('Líneas preparadas por hora y carretilla disponible', 'Lines picked per hour per available forklift'), f: (v) => num(v), up: true, unit: '' },
  { id: 'ocupacion', label: () => tx('Ocupación', 'Occupancy'), tip: () => tx('Huecos de estantería ocupados o asignados', 'Rack locations occupied or assigned'), f: (v) => pct(v, 0), up: false, unit: 'pp' },
  { id: 'calle', label: () => tx('Palés en calles', 'Pallets in lanes'), tip: () => tx('Palés descargados esperando a ser ubicados', 'Unloaded pallets waiting for put-away'), f: (v) => num(v), up: false, unit: '', baseKey: 'calle' },
];

// Textos fijos de index.html: [selector, propiedad, es, en].
const STATIC = [
  ['.brand-text small', 'textContent', 'Gemelo digital de almacén', 'Warehouse digital twin'],
  ['#sites', 'aria-label', 'Almacenes', 'Warehouses'],
  ['#modes', 'aria-label', 'Vista de la nave', 'Warehouse view'],
  ['.hint', 'textContent', 'Arrastra para mover · rueda para acercar · clic en una carretilla, un camión o un hueco', 'Drag to pan · scroll to zoom · click a forklift, a truck or a location'],
  ['#loading', 'textContent', 'Montando la nave…', 'Building the warehouse…'],
  ['.chart-card h3', 'textContent', 'Ritmo del turno', 'Shift pace'],
  ['.feed-card h3', 'textContent', 'Lo que está pasando', 'What is happening'],
  ['.foot span:first-child', 'textContent', 'Datos simulados: almacenes, pedidos y transportistas son ficticios.', 'Simulated data: warehouses, orders and carriers are fictitious.'],
  ['.foot span:last-child', 'innerHTML', 'Proyecto de <a href="https://www.linkedin.com/in/ali-aauicha/" target="_blank" rel="noopener">Ali Aauicha</a> · Three.js + simulación propia', 'A project by <a href="https://www.linkedin.com/in/ali-aauicha/" target="_blank" rel="noopener">Ali Aauicha</a> · Three.js + custom simulation'],
  ['#ai-teaser b', 'textContent', 'Pregunta a la IA', 'Ask the AI'],
  ['#ai-teaser span', 'textContent', '«¿Por qué baja el OTIF hoy?»', '"Why is OTIF dropping today?"'],
  ['#ai-teaser .teaser-x', 'aria-label', 'Cerrar aviso', 'Close'],
  ['#ai-fab', 'aria-label', 'Abrir el asistente de operaciones con IA', 'Open the AI operations assistant'],
  ['#ai-panel', 'aria-label', 'Asistente de operaciones', 'Operations assistant'],
  ['.ai-top-info b', 'textContent', 'Asistente de operaciones', 'Operations assistant'],
  ['#ai-close', 'aria-label', 'Cerrar el asistente', 'Close the assistant'],
  ['#ai-input', 'placeholder', 'Pregunta sobre el turno…', 'Ask about the shift…'],
  ['#ai-input', 'aria-label', 'Tu pregunta', 'Your question'],
  ['#ai-send', 'aria-label', 'Enviar', 'Send'],
];

const $ = (s) => document.querySelector(s);
const state = {
  site: SITES[0],
  sim: null,
  tab: 'detalle',
  sel: null,
  mode: 'operativa',
  slotting: 'actual',
  history: new Map(),
  opt: null,
  dayCompare: null,
  chats: new Map(),
  network: null,
  lastEvents: 0,
};

const scene = new WarehouseScene($('#viewport'), { onSelect: (sel) => select(sel) });
const chart = new ShiftChart($('#chart'));

// ---------------------------------------------------------------------------- montaje de la página

function buildChrome() {
  $('#sites').innerHTML = SITES.map((s) => `<button class="site-btn" data-site="${s.id}"><span class="dot" id="dot-${s.id}"></span>${esc(s.nombre)} <small>${esc(s.zona)}</small></button>`).join('');
  $('#sites').addEventListener('click', (e) => {
    const b = e.target.closest('[data-site]');
    if (b) loadSite(b.dataset.site);
  });
  $('#modes').innerHTML = MODES.map((m) => `<button data-mode="${m.id}"></button>`).join('');
  $('#modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('#tabs').innerHTML = TABS.map((t) => `<button class="tab" role="tab" data-tab="${t.id}"><span class="tab-name"></span><span class="badge" id="badge-${t.id}" hidden></span></button>`).join('');
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  $('#tab-body').addEventListener('click', onPanelClick);
  $('#kpis').innerHTML = KPIS.map((k) => `<div class="kpi" id="kpi-${k.id}"><div class="k-label"><abbr></abbr></div><div class="k-value">—</div><div class="k-delta flat">&nbsp;</div><svg class="spark" viewBox="0 0 64 22" preserveAspectRatio="none"></svg></div>`).join('');
  $('#lang').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLang(b.dataset.lang);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'Escape') select(null);
  });
  paintLabels();
}

// Todo lo que depende del idioma y no se repinta solo en cada refresco.
function paintLabels() {
  document.documentElement.lang = lang;
  document.title = tx('Estiba · Gemelo digital de almacén', 'Estiba · Warehouse digital twin');
  for (const [sel, prop, es, en] of STATIC) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (prop === 'textContent' || prop === 'innerHTML') el[prop] = tx(es, en);
    else el.setAttribute(prop, tx(es, en));
  }
  for (const b of document.querySelectorAll('#modes button')) b.textContent = MODES.find((m) => m.id === b.dataset.mode).nombre;
  for (const b of document.querySelectorAll('#tabs .tab')) b.querySelector('.tab-name').textContent = TABS.find((t) => t.id === b.dataset.tab).nombre();
  for (const def of KPIS) {
    const ab = document.querySelector(`#kpi-${def.id} abbr`);
    ab.textContent = def.label();
    ab.title = def.tip();
  }
  $('#chart-legend').innerHTML = chartLegend().map((l) => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join('');
  $('#ai-quick').innerHTML = sugerencias().map((q) => `<button type="button" class="chip" data-ask="${esc(q)}">${esc(q)}</button>`).join('');
  for (const b of document.querySelectorAll('#lang [data-lang]')) {
    b.classList.toggle('on', b.dataset.lang === lang);
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  }
}

onLang(() => {
  // Si se entró con ?lang=, la URL se actualiza para que al recargar o compartir salga el idioma elegido.
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has('lang')) { u.searchParams.set('lang', lang); window.history.replaceState(null, '', u); }
  } catch { /* sin history */ }
  paintLabels();
  setMode(state.mode);
  scene.relabel();
  state.network = null;
  panelSig = '';
  state.lastEvents = -1;
  if (state.sim) {
    refreshAll();
    renderPanel(true);
    lastNetwork = -1;
    paintSiteDots();
  }
  if (state.chatOpen) renderChat();
});

function setMode(mode) {
  state.mode = mode;
  scene.setMode(mode);
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === mode);
  const legends = {
    operativa: tx(
      '<span><i style="background:#c9a36b"></i>Palé en estantería</span><span><i style="background:#ff6b5e"></i>Palé sin hueco</span><span><i style="background:#cfe7e3"></i>Pedido preparado</span><span><i style="background:#2ec4b6;border-radius:50%"></i>Carretilla preparando</span><span><i style="background:#6c9cf0;border-radius:50%"></i>Ubicando</span>',
      '<span><i style="background:#c9a36b"></i>Pallet in rack</span><span><i style="background:#ff6b5e"></i>Pallet with no location</span><span><i style="background:#cfe7e3"></i>Order ready</span><span><i style="background:#2ec4b6;border-radius:50%"></i>Forklift picking</span><span><i style="background:#6c9cf0;border-radius:50%"></i>Putting away</span>',
    ),
    ocupacion: tx(
      '<span><i style="background:#2ec4b6"></i>Hueco de picking con stock</span><span><i style="background:#f5a524"></i>Menos del 30 %</span><span><i style="background:#ff6b5e"></i>Picking vacío</span><span><i style="background:#3f7d79"></i>Reserva</span><span class="muted">La altura del palé indica las cajas que quedan</span>',
      '<span><i style="background:#2ec4b6"></i>Pick face with stock</span><span><i style="background:#f5a524"></i>Under 30%</span><span><i style="background:#ff6b5e"></i>Empty pick face</span><span><i style="background:#3f7d79"></i>Reserve</span><span class="muted">Pallet height shows the cases left</span>',
    ),
    abc: tx(
      '<span><i style="background:#2ec4b6"></i>A · 80 % de las líneas</span><span><i style="background:#f5a524"></i>B · 15 %</span><span><i style="background:#56627a"></i>C · 5 %</span><span><i style="background:#343c49"></i>Reserva</span>',
      '<span><i style="background:#2ec4b6"></i>A · 80% of lines</span><span><i style="background:#f5a524"></i>B · 15%</span><span><i style="background:#56627a"></i>C · 5%</span><span><i style="background:#343c49"></i>Reserve</span>',
    ),
    calor: tx(
      '<span>Visitas de picking hoy</span><span><span class="ramp" style="background:linear-gradient(90deg,#1f2a38,#3f6fc4,#f5a524,#ff6b5e)"></span></span>',
      '<span>Picking visits today</span><span><span class="ramp" style="background:linear-gradient(90deg,#1f2a38,#3f6fc4,#f5a524,#ff6b5e)"></span></span>',
    ),
  };
  $('#legend').innerHTML = legends[mode];
}

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('on', b.dataset.tab === tab);
  renderPanel(true);
}

// ---------------------------------------------------------------------------- almacenes

async function loadSite(id, at = liveTarget().t) {
  const site = SITES.find((s) => s.id === id) || SITES[0];
  state.site = site;
  state.slotting = 'actual';
  state.dayCompare = null;
  for (const b of document.querySelectorAll('.site-btn')) b.classList.toggle('on', b.dataset.site === site.id);
  resetDay(at, true);
  if (state.chatOpen) renderChat();
  if (!state.history.has(site.id)) {
    state.history.set(site.id, null);
    const h = await computeHistory(site, 14);
    state.history.set(site.id, h);
    if (state.site === site) { refreshAll(); }
  }
}

function resetDay(at = SHIFT_START, newSite = false) {
  const sim = new Simulation(state.site, { slotting: state.slotting });
  if (at > SHIFT_START) sim.advance(at - SHIFT_START);
  state.sim = sim;
  state.lastEvents = 0;
  state.sel = null;
  if (newSite || !state.opt || state.opt.site !== state.site.id) {
    const base = state.slotting === 'actual' ? sim : new Simulation(state.site);
    state.opt = { site: state.site.id, ...analyzeSlotting(base) };
  }
  scene.load(sim);
  scene.setMode(state.mode);
  $('#feed').innerHTML = '';
  refreshAll();
  const ld = $('#loading');
  if (!ld.hidden) { ld.classList.add('done'); setTimeout(() => { ld.hidden = true; }, 450); }
}

function currentHistory() {
  return state.history.get(state.site.id) || null;
}

function ctx() {
  return { sim: state.sim, history: currentHistory(), opt: state.opt, network: networkRows };
}

// Los otros almacenes se simulan hasta la misma hora para poder compararlos.
function networkRows() {
  const t = state.sim.t;
  const key = Math.floor(t / 15);
  if (state.network?.key === key) return state.network.rows;
  const rows = SITES.map((site) => {
    let sim;
    if (site.id === state.site.id) sim = state.sim;
    else {
      sim = new Simulation(site);
      sim.advance(t - SHIFT_START);
    }
    const d = diagnose(sim, state.history.get(site.id));
    return { site, k: d.k, top: d.hallazgos[0] || null };
  });
  state.network = { key, rows };
  return rows;
}

function paintSiteDots() {
  const rows = networkRows();
  for (const r of rows) {
    const el = document.getElementById(`dot-${r.site.id}`);
    if (!el) continue;
    const o = r.k.otif;
    const cls = r.top && r.top.peso >= 3 ? 'bad' : r.top ? 'warn' : 'ok';
    el.className = `dot ${o == null ? (r.top ? 'warn' : 'ok') : cls}`;
    el.title = r.top ? r.top.titulo : tx('Sin incidencias', 'No issues');
  }
}

// ---------------------------------------------------------------------------- selección y paneles

function select(sel) {
  state.sel = sel;
  scene.select(sel);
  if (sel && state.tab !== 'detalle') setTab('detalle');
  else renderPanel(true);
}

function onPanelClick(e) {
  const s = e.target.closest('[data-sel]');
  if (s) {
    const v = s.dataset.sel;
    if (v === 'none') return select(null);
    const i = v.indexOf(':');
    const kind = v.slice(0, i);
    const id = v.slice(i + 1);
    return select({ kind, id: kind === 'location' ? Number(id) : id });
  }
  const a = e.target.closest('[data-act]');
  if (a) {
    const act = a.dataset.act;
    if (act === 'mode-abc') setMode('abc');
    if (act === 'abc-toggle') toggleAbc();
    return;
  }
  const chip = e.target.closest('[data-ask]');
  if (chip) ask(chip.dataset.ask);
}

function toggleAbc() {
  const t = state.sim.t;
  state.slotting = state.slotting === 'abc' ? 'actual' : 'abc';
  resetDay(t);
  if (state.slotting === 'abc') setMode('abc');
  setTab('opt');
}

function computeDayCompare() {
  if (state.dayCompare?.site === state.site.id) return;
  const a = runDay(state.site, 0, { slotting: 'actual' }).kpis();
  const b = runDay(state.site, 0, { slotting: 'abc' }).kpis();
  state.dayCompare = { site: state.site.id, actual: a, abc: b };
}

var panelSig = ''; // var: onLang() la reinicia y se registra antes de esta línea
function renderPanel(force = false) {
  const body = $('#tab-body');
  const sim = state.sim;
  if (!sim) return;
  let html;
  if (state.tab === 'detalle') {
    html = (state.sel && renderSelection(sim, state.sel)) || renderOverview(sim);
  } else if (state.tab === 'rutas') {
    html = renderRoutes(sim);
  } else {
    computeDayCompare();
    html = renderOpt(state.opt, state);
  }
  if (!force && html === panelSig) return;
  panelSig = html;
  const top = body.scrollTop;
  body.innerHTML = html;
  if (!force) body.scrollTop = top;
}

// ---------------------------------------------------------------------------- asistente

function chatLog() {
  if (!state.chats.has(state.site.id)) {
    state.chats.set(state.site.id, [{ who: 'bot', welcome: true }]);
  }
  return state.chats.get(state.site.id);
}

// El asistente vive en una burbuja flotante (como en Mi Campo y Quillaflow), siempre a mano.
function renderChat() {
  const log = chatLog();
  $('#ai-sub').textContent = `${state.site.nombre} · ${API_URL ? tx('Claude en Amazon Bedrock', 'Claude on Amazon Bedrock') : tx('datos del turno en directo', 'live shift data')}`;
  const box = $('#ai-msgs');
  const welcome = () => tx(
    `Hola. Tengo delante el turno de **${state.site.nombre}** en tiempo real y los 14 días anteriores para comparar. Pregúntame lo que necesites.`,
    `Hi. I am looking at the **${state.site.nombre}** shift in real time, with the previous 14 days to compare against. Ask me anything.`,
  );
  box.innerHTML = log.map((m) => `<div class="msg ${m.who}">${m.who === 'bot' ? md(m.welcome ? welcome() : m.text) : esc(m.text)}${m.src ? `<div class="src">${esc(m.src)}</div>` : ''}</div>`).join('')
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
  const c = ctx();
  const hora = fmt(c.sim.t);
  const local = answerLocal(q, c);
  let text = local;
  let src = tx(`Calculado con los datos del turno a las ${hora}`, `Computed from the shift data at ${hora}`);
  if (API_URL) {
    try {
      const hist = log.filter((m) => m.who && !m.welcome).slice(-7, -1).map((m) => ({ rol: m.who === 'user' ? 'usuario' : 'asistente', texto: m.text }));
      const r = await answerRemote(q, c, local, hist);
      // Si la Lambda descartó la redacción del modelo, se enseña la respuesta local completa.
      text = r.fuente === 'modelo' ? r.texto : local;
      // Si la Lambda descartó la redacción del modelo (cifras que no estaban en los datos), llega la base.
      if (r.fuente === 'modelo') src = tx(`Redactado por Claude (Amazon Bedrock) con el diagnóstico de las ${hora}`, `Written by Claude (Amazon Bedrock) from the ${hora} diagnosis`);
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
  const b = baselineAt(hist, sim.t);
  for (const def of KPIS) {
    const el = document.getElementById(`kpi-${def.id}`);
    const v = k[def.id];
    el.querySelector('.k-value').innerHTML = def.f(v);
    const bv = b?.[def.baseKey || def.id];
    const dEl = el.querySelector('.k-delta');
    let alert = false;
    if (v != null && bv != null) {
      const diff = v - bv;
      const isPct = def.unit === 'pp';
      const shown = isPct ? diff * 100 : diff;
      const small = isPct ? Math.abs(shown) < 0.5 : Math.abs(diff) < Math.max(1, Math.abs(bv) * 0.05);
      const good = def.up ? diff > 0 : diff < 0;
      const txt = `${shown > 0 ? '▲' : '▼'} ${num(Math.abs(shown), isPct ? 1 : 0)}${isPct ? ppUnit() : def.unit === 'min' ? ' min' : ''} ${tx('vs media', 'vs avg')}`;
      dEl.textContent = small ? tx('≈ media 14 días', '≈ 14-day average') : txt;
      dEl.className = `k-delta ${small ? 'flat' : good ? 'good' : 'bad'}`;
      const rel = Math.abs(diff) / (Math.abs(bv) || 1);
      alert = !small && !good && (isPct ? Math.abs(shown) > 4 : rel > 0.5);
    } else {
      dEl.textContent = hist ? (v == null ? tx('aún sin rutas salidas', 'no routes out yet') : '') || ' ' : tx('calculando media…', 'computing average…');
      dEl.className = 'k-delta flat';
    }
    el.classList.toggle('alert', alert);
    spark(el.querySelector('svg'), sim.hourly, hist, def.id === 'calle' ? 'calle' : def.id);
  }
  $('#clock').textContent = fmt(Math.floor(sim.clock ?? sim.t));
  const live = liveTarget();
  $('#live').classList.toggle('replay', live.replay);
  $('#live-label').textContent = live.replay ? tx('EN DIFERIDO', 'REPLAY') : tx('EN VIVO', 'LIVE');
  $('#live').title = live.replay
    ? tx(`En España son las ${fmt(Math.floor(live.real))}: de noche el almacén no opera y se reproduce el turno de día.`, `It is ${fmt(Math.floor(live.real))} in Spain: the warehouse is closed at night, so the day shift is replayed.`)
    : tx('Hora real de España: la simulación avanza minuto a minuto.', 'Real time in Spain: the simulation runs minute by minute.');
  $('#shift').textContent = live.replay
    ? `${tx('Turno de día en diferido', 'Day shift replay')} · ${state.site.nombre}`
    : `${tx('Hora de España', 'Spain time')} · ${state.site.nombre}`;
}

function paintBanner() {
  const sim = state.sim;
  const el = $('#banner');
  const activas = sim.incidencias.filter((w) => w.empezo && !w.acabo);
  let html = '';
  if (activas.length) {
    const n = activas.length;
    const ids = activas.map((w) => w.f.id).join(', ');
    const h = fmt(Math.max(...activas.map((w) => w.hasta)));
    html = tx(
      `<b>${n} ${n > 1 ? 'carretillas' : 'carretilla'} en el taller</b> (${ids}) hasta las ${h}. <button type="button" class="link-btn" data-open-ai>Pregunta a la IA cómo afecta</button>`,
      `<b>${n} ${n > 1 ? 'forklifts' : 'forklift'} in the workshop</b> (${ids}) until ${h}. <button type="button" class="link-btn" data-open-ai>Ask the AI how it affects the shift</button>`,
    );
  } else if (sim.c.sinHueco > 0 && sim.freeLocations() < 3) {
    html = tx('<b>Nave llena:</b> hay palés en recepción sin hueco donde ubicarlos.', '<b>Warehouse full:</b> there are pallets in receiving with no location to go to.');
  }
  el.hidden = !html;
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
}

function paintFeed() {
  const ev = state.sim.events;
  if (ev.length === state.lastEvents) return;
  state.lastEvents = ev.length;
  const items = ev.slice(-80).reverse().map((e) => `<li class="${e.nivel}"><time>${fmt(e.t)}</time><span>${esc(e.texto)}</span></li>`).join('');
  $('#feed').innerHTML = items;
  $('#feed-count').textContent = tx(`${ev.length} eventos`, `${ev.length} events`);
}

function paintBadges() {
  const n = riskCount(state.sim);
  const b = document.getElementById('badge-rutas');
  b.hidden = !n;
  b.textContent = n;
}

var lastNetwork = -1; // var: ídem
function refreshAll() {
  paintKpis();
  paintBanner();
  paintFeed();
  paintBadges();
  chart.render(state.sim, currentHistory());
  renderPanel(false);
  const slot = Math.floor(state.sim.t / 60);
  if (slot !== lastNetwork) {
    lastNetwork = slot;
    paintSiteDots();
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
    // El almacén sigue al reloj real. Si el objetivo queda por detrás (de día a diferido a las
    // 22:00, o de vuelta a las 06:00), se vuelve a simular el día hasta la hora que toca.
    const target = liveTarget().t;
    const now = state.sim.clock ?? state.sim.t;
    if (target < now - 1) resetDay(target);
    else if (target > now) state.sim.advance(Math.min(target - now, 30));
  }
  scene.update(dt);
  scene.render();
  acc += dt;
  palAcc += dt;
  if (palAcc > 0.35) { palAcc = 0; scene.refreshPallets(); }
  if (acc > 0.5) { acc = 0; refreshAll(); }
  requestAnimationFrame(frame);
}

buildChrome();
buildChat();
setMode('operativa');
setTab('detalle');
loadSite('zgz').then(async () => {
  // El resto de almacenes calcula su histórico en segundo plano (para comparar y para los puntos de estado).
  for (const s of SITES) {
    if (!state.history.has(s.id)) {
      state.history.set(s.id, null);
      state.history.set(s.id, await computeHistory(s, 14));
    }
  }
  lastNetwork = -1;
  paintSiteDots();
});
requestAnimationFrame(frame);

window.__estiba = state; // para depurar desde la consola
window.__scene = scene;
