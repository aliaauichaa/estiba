// Etiquetas que no se pisan. Las de las plantas o las delegaciones van ancladas a su edificio y, con nombres
// largos («Inyección de plásticos · 246 min») o la pantalla estrecha, se tapaban unas a otras. Cada fotograma
// se miden en pantalla y, de abajo arriba, cada una busca el sitio libre más cercano subiendo o bajando, sin
// meterse bajo un panel flotante ni salirse del visor (tapas) ni alejarse de su edificio: hasta seis veces su
// altura hacia arriba, donde una línea guía baja hasta él, y dos hacia abajo, donde no la hay. Se prefiere
// subir; si no hay sitio en ningún sentido, se queda donde estaba. Los rótulos con solape 'ocultar' no empujan
// a nadie: si pisan una etiqueta, se esconden. Sin dependencias de three, para poder probarlo en Node.
//
// items: [{ l, r, t, b, prio, antes, ocultar, oculta }]: rectángulo en pantalla sin desplazar; prioridad (la
// mayor se coloca antes y no se mueve por las de menos); desplazamiento del fotograma anterior; si se esconde
// en vez de moverse, y si estaba escondida. tapas: rectángulos que no se pueden pisar (los bordes del visor,
// con un lado infinito).
// Devuelve, por etiqueta, el desplazamiento vertical en píxeles (negativo: hacia arriba) o null si se esconde.
export function separarEtiquetas(items, { hueco = 3, histeresis = 4, tapas = [], margen = 12, alturas = { arriba: 6, abajo: 2 } } = {}) {
  // La histéresis evita parpadeos al mover la cámara: de dos etiquetas casi a la misma altura sigue moviéndose
  // la que ya se movía, en el mismo sentido mientras tenga sitio, y un rótulo escondido no vuelve hasta que
  // tiene algo de sitio de sobra.
  const orden = items
    .map((it, i) => ({ it, i, base: it.b - (it.antes ? histeresis : 0) }))
    .sort((a, b) => (b.it.prio ?? 0) - (a.it.prio ?? 0) || b.base - a.base || a.it.l - b.it.l);
  const puestas = [];
  const pisa = (l, r, t, b, p, m) => l < p.r + m && r > p.l - m && t < p.b + m && b > p.t - m;
  const fijas = tapas.map((p) => ({ ...p, m: 0 }));

  // Desliza la caja hacia arriba (dir -1) o hacia abajo (+1) hasta que no pise nada. Al pasar un obstáculo ya no
  // vuelve a pisarlo, así que acaba; null si choca con un borde del visor o se aleja demasiado.
  const deslizar = (it, dir) => {
    const obst = puestas.concat(fijas);
    const tope = (dir < 0 ? alturas.arriba : alturas.abajo) * (it.b - it.t);
    let t = it.t;
    let b = it.b;
    for (let mov = true; mov;) {
      mov = false;
      if (Math.abs(t - it.t) > tope) return null;
      for (const p of obst) {
        if (!pisa(it.l, it.r, t, b, p, p.m)) continue;
        if (!Number.isFinite(dir < 0 ? p.t : p.b)) return null;
        const d = dir < 0 ? b - (p.t - p.m) : p.b + p.m - t;
        t += dir * d;
        b += dir * d;
        mov = true;
      }
    }
    return t - it.t;
  };

  const libre = (it, d) => !puestas.concat(fijas).some((p) => pisa(it.l, it.r, it.t + d, it.b + d, p, p.m));
  const dentro = (it, d) => Math.abs(d) <= (d < 0 ? alturas.arriba : alturas.abajo) * (it.b - it.t);

  const res = new Array(items.length).fill(0);
  for (const { it, i } of orden) {
    if (it.ocultar) {
      const m = hueco + (it.oculta ? histeresis : 0);
      if (puestas.some((p) => pisa(it.l, it.r, it.t, it.b, p, m))) { res[i] = null; continue; }
      puestas.push({ l: it.l, r: it.r, t: it.t, b: it.b, m: hueco });
      continue;
    }
    const arriba = deslizar(it, -1);
    let d = 0;
    if (arriba !== 0) {
      const abajo = deslizar(it, 1);
      const ok = (x) => x != null;
      if (it.antes > 0) d = ok(abajo) ? abajo : ok(arriba) ? arriba : 0;
      else if (it.antes < 0) d = ok(arriba) ? arriba : ok(abajo) ? abajo : 0;
      else d = ok(arriba) && (!ok(abajo) || -arriba <= abajo + margen) ? arriba : ok(abajo) ? abajo : 0;
      // Estabilidad: si el sitio que ya tenía sigue libre y a distancia, se queda en él salvo que el nuevo esté
      // claramente más cerca. Sin esto, con muchas etiquetas juntas (móvil) cada cambio arrastraba a las demás
      // y alguna iba y volvía entre dos sitios al girar la cámara.
      if (it.antes && d !== it.antes && libre(it, it.antes) && dentro(it, it.antes)
        && !(d && Math.abs(d) + 2 * margen < Math.abs(it.antes))) d = it.antes;
    }
    puestas.push({ l: it.l, r: it.r, t: it.t + d, b: it.b + d, m: hueco });
    res[i] = d;
  }
  return res;
}
