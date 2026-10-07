// Gráfica del turno en SVG: líneas preparadas por hora (barras), OTIF acumulado y equipos operativos,
// con la media de los 14 días anteriores como referencia.

import { tx, num, pct } from '../i18n.js';

const H0 = 6;
const H1 = 22;
const NS = 'http://www.w3.org/2000/svg';

export const chartLegend = () => [
  { color: '#f5a524', label: tx('Líneas/hora (hoy)', 'Lines/hour (today)') },
  { color: '#5d6a7d', label: tx('Líneas/hora (media 14 días)', 'Lines/hour (14-day average)') },
  { color: '#2ec4b6', label: tx('OTIF acumulado', 'Cumulative OTIF') },
  { color: '#6c9cf0', label: tx('Carretillas operativas', 'Forklifts in service') },
];

export class ShiftChart {
  constructor(el) {
    this.el = el;
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    el.appendChild(this.tip);
    this.svg = document.createElementNS(NS, 'svg');
    el.appendChild(this.svg);
    this.svg.addEventListener('pointermove', (e) => this._hover(e));
    this.svg.addEventListener('pointerleave', () => { this.tip.hidden = true; this._hl?.setAttribute('opacity', 0); });
  }

  render(sim, history) {
    this.sim = sim;
    this.history = history;
    const w = this.el.clientWidth || 600;
    const h = this.el.clientHeight || 170;
    this.w = w;
    this.h = h;
    const pad = { l: 34, r: 34, t: 8, b: 20 };
    this.pad = pad;
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const hours = H1 - H0;
    const bw = iw / hours;
    this.bw = bw;
    const today = new Map(sim.hourly.map((r) => [r.hora, r]));
    const base = history?.hourly;
    let maxL = 10;
    for (const r of sim.hourly) maxL = Math.max(maxL, r.lineas);
    if (base) for (const [, r] of base) maxL = Math.max(maxL, r.lineas || 0);
    maxL = Math.ceil(maxL / 20) * 20;
    const nF = sim.forklifts.length;
    const x = (hora) => pad.l + (hora - H0) * bw;
    const yL = (v) => pad.t + ih - (v / maxL) * ih;
    const yP = (v) => pad.t + ih - ((v - 0.5) / 0.5) * ih; // OTIF de 50 % a 100 %
    const yE = (v) => pad.t + ih - (v / nF) * ih;

    const parts = [];
    for (let k = 0; k <= 4; k++) {
      const yy = pad.t + (ih * k) / 4;
      parts.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy}" y2="${yy}" stroke="#273140" stroke-width="1"/>`);
      parts.push(`<text x="${pad.l - 6}" y="${yy + 3}" text-anchor="end" fill="#5d6a7d" font-size="10" font-family="JetBrains Mono, monospace">${Math.round(maxL * (1 - k / 4))}</text>`);
      parts.push(`<text x="${w - pad.r + 6}" y="${yy + 3}" fill="#2ec4b6" font-size="10" font-family="JetBrains Mono, monospace" opacity="0.8">${Math.round(100 - 50 * (k / 4))}%</text>`);
    }
    for (let hh = H0; hh <= H1; hh += 2) {
      parts.push(`<text x="${x(hh)}" y="${h - 5}" text-anchor="middle" fill="#5d6a7d" font-size="10" font-family="JetBrains Mono, monospace">${String(hh).padStart(2, '0')}h</text>`);
    }
    for (let hh = H0; hh < H1; hh++) {
      const b = base?.get(hh);
      if (b?.lineas != null) {
        parts.push(`<rect x="${x(hh) + bw * 0.12}" y="${yL(b.lineas)}" width="${bw * 0.76}" height="${pad.t + ih - yL(b.lineas)}" fill="none" stroke="#5d6a7d" stroke-dasharray="3 2" rx="2"/>`);
      }
      const r = today.get(hh);
      if (r) parts.push(`<rect x="${x(hh) + bw * 0.2}" y="${yL(r.lineas)}" width="${bw * 0.6}" height="${pad.t + ih - yL(r.lineas)}" fill="#f5a524" opacity="0.85" rx="2"/>`);
    }
    const line = (pts, color, dash = '', width = 2) => (pts.length > 1
      ? `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>` : '');
    const mid = (hh) => x(hh) + bw / 2;
    const baseOt = [];
    if (base) for (let hh = H0; hh < H1; hh++) { const b = base.get(hh); if (b?.otif != null) baseOt.push([mid(hh), yP(Math.max(0.5, b.otif))]); }
    parts.push(line(baseOt, '#2ec4b6', '4 3', 1.5).replace('<polyline', '<polyline opacity="0.5"'));
    const ot = sim.hourly.filter((r) => r.otif != null).map((r) => [mid(r.hora), yP(Math.max(0.5, r.otif))]);
    parts.push(line(ot, '#2ec4b6', '', 2.2));
    const eq = sim.hourly.map((r) => [mid(r.hora), yE(r.equipos)]);
    parts.push(line(eq, '#6c9cf0', '', 1.6));
    for (const p of ot) parts.push(`<circle cx="${p[0]}" cy="${p[1]}" r="2.6" fill="#2ec4b6"/>`);
    const now = Math.min(H1, sim.t / 60);
    parts.push(`<line x1="${x(now)}" x2="${x(now)}" y1="${pad.t}" y2="${pad.t + ih}" stroke="#e7ebf1" stroke-width="1" opacity="0.35"/>`);
    parts.push(`<rect id="hl" x="0" y="${pad.t}" width="${bw}" height="${ih}" fill="#ffffff" opacity="0" pointer-events="none"/>`);
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.innerHTML = parts.join('');
    this._hl = this.svg.querySelector('#hl');
  }

  _hover(e) {
    if (!this.sim) return;
    const rect = this.svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const hora = Math.floor((px - this.pad.l) / this.bw) + H0;
    if (hora < H0 || hora >= H1) { this.tip.hidden = true; return; }
    const r = this.sim.hourly.find((x) => x.hora === hora);
    const b = this.history?.hourly.get(hora);
    const p = (v) => pct(v);
    const avg = tx('media', 'avg');
    const lines = [`<b>${String(hora).padStart(2, '0')}:00–${String(hora + 1).padStart(2, '0')}:00</b>`];
    if (r) {
      lines.push(`${tx('Líneas', 'Lines')}: ${r.lineas} (${avg} ${b ? num(b.lineas) : '—'})`, `OTIF: ${p(r.otif)} (${avg} ${p(b?.otif)})`,
        `${tx('Carretillas', 'Forklifts')}: ${num(r.equipos, 1)}`, `${tx('Palés en calles', 'Pallets in lanes')}: ${num(r.calle)}`);
    } else {
      lines.push(`${tx('Media', 'Average')}: ${b ? num(b.lineas) : '—'} ${tx('líneas', 'lines')} · OTIF ${p(b?.otif)}`);
    }
    this.tip.innerHTML = lines.join('<br>');
    this.tip.hidden = false;
    const x = this.pad.l + (hora - H0 + 0.5) * this.bw;
    this.tip.style.left = `${Math.min(Math.max(x, 90), this.w - 90)}px`;
    this.tip.style.top = `${this.pad.t + 6}px`;
    this._hl?.setAttribute('x', this.pad.l + (hora - H0) * this.bw);
    this._hl?.setAttribute('opacity', 0.04);
  }
}
