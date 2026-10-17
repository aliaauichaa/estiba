import { test } from 'node:test';
import assert from 'node:assert/strict';
import { separarEtiquetas } from '../src/scene/solape.js';

const caja = (l, t, w = 120, h = 20, extra = {}) => ({ l, r: l + w, t, b: t + h, antes: 0, ...extra });
const pisan = (a, b, dya, dyb) => a.l < b.r && a.r > b.l && a.t + dya < b.b + dyb && a.b + dya > b.t + dyb;

test('etiquetas: las que no se tocan no se mueven', () => {
  assert.deepEqual(separarEtiquetas([caja(0, 100), caja(200, 100), caja(0, 300)]), [0, 0, 0]);
});

test('etiquetas: de dos que se pisan, sube la de arriba y la de abajo se queda', () => {
  // Como «Asientos · 166 min» (más abajo) y «Frontal · sin centralitas» (7 px más arriba) en Tier 1.
  const asientos = caja(600, 548);
  const frontal = caja(690, 541, 180);
  const dy = separarEtiquetas([asientos, frontal]);
  assert.equal(dy[0], 0);
  assert.ok(dy[1] < 0);
  assert.ok(!pisan(asientos, frontal, dy[0], dy[1]));
  assert.ok(frontal.b + dy[1] <= asientos.t - 3, 'queda el hueco entre las dos');
});

test('etiquetas: una fila entera de etiquetas largas queda sin solapes', () => {
  const fila = [0, 1, 2, 3].map((k) => caja(k * 100, 400 - k * 4, 190));
  const dy = separarEtiquetas(fila);
  for (let a = 0; a < fila.length; a++) {
    for (let b = a + 1; b < fila.length; b++) assert.ok(!pisan(fila[a], fila[b], dy[a], dy[b]), `${a} y ${b}`);
  }
  assert.equal(dy[0], 0, 'la más baja se queda');
});

test('etiquetas: la de menos prioridad (la nota del mapa) se aparta aunque esté más abajo', () => {
  const nota = caja(0, 306, 200, 16, { prio: -1 });
  const segovia = caja(150, 300, 150);
  const dy = separarEtiquetas([nota, segovia]);
  assert.equal(dy[1], 0);
  assert.ok(dy[0] < 0);
  assert.ok(!pisan(nota, segovia, dy[0], dy[1]));
});

test('etiquetas: un rótulo de zona que pisa una etiqueta se esconde en vez de empujar', () => {
  // «TIER 3 · MATERIAS PRIMAS» en móvil, debajo de «Inyección de plásticos».
  const tier = caja(10, 210, 160, 14, { prio: -2, ocultar: true });
  const planta = caja(60, 200, 140);
  const libre = caja(400, 500, 160, 14, { prio: -2, ocultar: true });
  assert.deepEqual(separarEtiquetas([tier, planta, libre]), [null, 0, 0]);
  // Escondido, no vuelve por un píxel de sitio: necesita la histéresis de margen.
  const justo = caja(10, 223, 160, 14, { prio: -2, ocultar: true, oculta: true });
  assert.equal(separarEtiquetas([justo, planta])[0], null);
  assert.equal(separarEtiquetas([{ ...justo, oculta: false }, planta])[0], 0);
});

const ARRIBA = (b) => ({ l: -Infinity, r: Infinity, t: -Infinity, b });
const ABAJO = (t) => ({ l: -Infinity, r: Infinity, t, b: Infinity });

test('etiquetas: si arriba no hay sitio (panel o borde del visor), baja; si no lo hay en ningún sentido, se queda', () => {
  const abajo = caja(0, 100);
  const arriba = caja(50, 95);
  assert.ok(separarEtiquetas([abajo, arriba])[1] < 0, 'con sitio, sube');
  assert.equal(separarEtiquetas([abajo, arriba], { tapas: [ARRIBA(90)] })[1], 28, 'contra el borde de arriba, baja');
  // Un panel encima: subir por encima de él la alejaría 75 px; bajar son 28, así que baja.
  assert.equal(separarEtiquetas([abajo, arriba], { tapas: [{ l: 0, r: 400, t: 40, b: 90 }] })[1], 28);
  assert.equal(separarEtiquetas([abajo, arriba], { tapas: [ARRIBA(90), ABAJO(125)] })[1], 0, 'sin sitio, se queda');
});

test('etiquetas: una fila apretada con un panel encima queda sin solapes y fuera del panel', () => {
  const fila = [0, 1, 2, 3, 4, 5].map((k) => caja(k * 60, 300 - (k % 3) * 5, 150));
  const tapas = [ARRIBA(200), ABAJO(520), { l: 0, r: 220, t: 230, b: 280 }];
  const dy = separarEtiquetas(fila, { tapas });
  for (let a = 0; a < fila.length; a++) {
    for (let b = a + 1; b < fila.length; b++) assert.ok(!pisan(fila[a], fila[b], dy[a], dy[b]), `${a} y ${b}`);
    for (const p of tapas) assert.ok(!pisan(fila[a], p, dy[a], 0), `${a} bajo una tapa`);
  }
});

test('etiquetas: no se aleja de su edificio (seis alturas hacia arriba, dos hacia abajo)', () => {
  // Una columna de seis etiquetas encima: el hueco libre más cercano está a 143 px (más de seis alturas).
  const columna = [0, 1, 2, 3, 4, 5].map((k) => caja(0, 200 - k * 23));
  const nueva = caja(30, 205, 120, 20, { prio: -1 });
  const dy = separarEtiquetas([...columna, nueva], { tapas: [ABAJO(230)] });
  assert.equal(dy[6], 0);
  // Hacia abajo, con el borde de arriba pegado: bajar 28 px (1,4 alturas) vale; 3 alturas, no.
  const abajo = caja(0, 100);
  assert.equal(separarEtiquetas([abajo, caja(50, 95)], { tapas: [ARRIBA(90)] })[1], 28);
  const dos = [abajo, caja(0, 123)];
  assert.equal(separarEtiquetas([...dos, caja(50, 95, 120, 20, { prio: -1 })], { tapas: [ARRIBA(90)] })[2], 0);
});

test('etiquetas: se queda en el sitio que ya tenía mientras siga libre, y vuelve a casa en cuanto puede', () => {
  const abajo = caja(0, 100);
  // Ya estaba 40 px arriba: el hueco más cercano está a 18, pero 18 + 24 no es claramente mejor que 40.
  assert.equal(separarEtiquetas([abajo, caja(50, 95, 120, 20, { antes: -40 })])[1], -40);
  // A 80 px sí compensa acercarse.
  assert.equal(separarEtiquetas([abajo, caja(50, 95, 120, 20, { antes: -80 })])[1], -18);
  // Sin nada que esquivar, vuelve a su sitio.
  assert.equal(separarEtiquetas([caja(0, 300), caja(50, 95, 120, 20, { antes: -50 })])[1], 0);
});

test('etiquetas: la que ya bajaba sigue bajando mientras tenga sitio', () => {
  const abajo = caja(0, 100);
  const arriba = caja(50, 95, 120, 20, { antes: 28 });
  assert.equal(separarEtiquetas([abajo, arriba])[1], 28);
});

test('etiquetas: histéresis, la que ya estaba subida sigue subiendo si la diferencia es pequeña', () => {
  // A está 2 px más abajo que B, pero en el fotograma anterior A era la que subía: no se turnan.
  const a = caja(0, 102, 120, 20, { antes: -25 });
  const b = caja(60, 100);
  const dy = separarEtiquetas([a, b]);
  assert.equal(dy[1], 0);
  assert.ok(dy[0] < 0);
  // Con una diferencia grande, manda la posición.
  const dy2 = separarEtiquetas([caja(0, 110, 120, 20, { antes: -25 }), caja(60, 100)]);
  assert.equal(dy2[0], 0);
  assert.ok(dy2[1] < 0);
});
