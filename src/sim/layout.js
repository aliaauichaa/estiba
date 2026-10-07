// Geometría de la nave en metros. Eje x = ancho (muelles en la fachada z = 0), eje z = fondo.
// Las estanterías van en pasillos paralelos al eje z, con un pasillo transversal delante y otro detrás.

export const DIM = {
  RACK_D: 1.1,      // fondo de una estantería
  AISLE_W: 3.2,     // ancho de pasillo de carretilla
  GAP: 0.6,         // separación entre módulos espalda con espalda
  BAY_L: 2.7,       // largo de un hueco (dos palés)
  LEVEL_H: 1.55,    // altura entre niveles
  X0: 6,            // margen lateral
  Z_RACK0: 16,      // donde empiezan las estanterías
  Z_FRONT: 13,      // pasillo transversal delantero
  SPEED: 105,       // m/min de una carretilla cargada (≈ 6,3 km/h)
  DOCK_STEP: 5.4,   // separación entre puertas de muelle
};

// Penalización en metros equivalentes por subir a cada nivel (tiempo de elevación).
export const LEVEL_PENALTY = [0, 2, 9, 16, 24];

export function aisleLetter(i) {
  return String.fromCharCode(65 + i);
}

export function buildLayout(cfg) {
  const { pasillos, huecos, niveles, muellesEntrada, muellesSalida } = cfg;
  const M = DIM.RACK_D * 2 + DIM.AISLE_W + DIM.GAP;
  const W = DIM.X0 * 2 + pasillos * M - DIM.GAP;
  const rackLen = huecos * DIM.BAY_L;
  const D = DIM.Z_RACK0 + rackLen + 6;
  const zRear = DIM.Z_RACK0 + rackLen + 2.6;

  const aisles = [];
  for (let i = 0; i < pasillos; i++) {
    const base = DIM.X0 + i * M;
    aisles.push({
      i,
      letra: aisleLetter(i),
      x: base + DIM.RACK_D + DIM.AISLE_W / 2,
      rackX: [base + DIM.RACK_D / 2, base + DIM.RACK_D + DIM.AISLE_W + DIM.RACK_D / 2],
    });
  }

  const locations = [];
  for (const a of aisles) {
    for (let side = 0; side < 2; side++) {
      for (let b = 0; b < huecos; b++) {
        for (let l = 0; l < niveles; l++) {
          const z = DIM.Z_RACK0 + (b + 0.5) * DIM.BAY_L;
          locations.push({
            idx: locations.length,
            id: `${a.letra}${String(b + 1).padStart(2, '0')}-${l + 1}${side ? 'D' : 'I'}`,
            aisle: a.i,
            side,
            bay: b,
            level: l,
            rx: a.rackX[side],
            y: l * DIM.LEVEL_H,
            z,
            pick: { aisle: a.i, x: a.x, z },
            sku: -1,
            units: 0,
            role: null,
            reserved: false,
            picks: 0,
          });
        }
      }
    }
  }

  // Muelles: recepción a la izquierda, expedición a la derecha, separados por un hueco central.
  const docks = [];
  for (let k = 0; k < muellesEntrada; k++) {
    docks.push({ id: `R${k + 1}`, tipo: 'entrada', x: 7 + k * DIM.DOCK_STEP });
  }
  for (let k = 0; k < muellesSalida; k++) {
    docks.push({ id: `E${k + 1}`, tipo: 'salida', x: W - 7 - (muellesSalida - 1 - k) * DIM.DOCK_STEP });
  }
  for (const d of docks) d.lane = { x: d.x, z: 6 };

  const inDocks = docks.filter((d) => d.tipo === 'entrada');
  const outDocks = docks.filter((d) => d.tipo === 'salida');
  const mean = (arr) => arr.reduce((s, d) => s + d.x, 0) / arr.length;

  return {
    W,
    D,
    rackLen,
    zFront: DIM.Z_FRONT,
    zRear,
    aisles,
    locations,
    docks,
    inDocks,
    outDocks,
    depotIn: { x: mean(inDocks), z: 7 },
    depotOut: { x: mean(outDocks), z: 7 },
    parking: { x: W / 2, z: 10.5 },
    taller: { x: W - 3, z: D - 3 },
    niveles,
  };
}

// Distancia de recorrido real (no en línea recta): dentro del mismo pasillo se va directo;
// si no, hay que salir por el pasillo transversal delantero o el trasero.
export function travel(L, a, b) {
  if (a.aisle != null && a.aisle === b.aisle) return Math.abs(a.z - b.z);
  let best = Math.abs(a.z - L.zFront) + Math.abs(a.x - b.x) + Math.abs(b.z - L.zFront);
  if (a.aisle != null && b.aisle != null) {
    const rear = Math.abs(a.z - L.zRear) + Math.abs(a.x - b.x) + Math.abs(b.z - L.zRear);
    if (rear < best) best = rear;
  }
  return best;
}

export function pathPoints(L, a, b) {
  if (a.aisle != null && a.aisle === b.aisle) return [a, b];
  let c = L.zFront;
  if (a.aisle != null && b.aisle != null) {
    const front = Math.abs(a.z - L.zFront) + Math.abs(b.z - L.zFront);
    const rear = Math.abs(a.z - L.zRear) + Math.abs(b.z - L.zRear);
    if (rear < front) c = L.zRear;
  }
  return [a, { x: a.x, z: c }, { x: b.x, z: c }, b];
}

// Coste de una ubicación para el slotting: distancia desde expedición + penalización por altura.
export function locationCost(L, loc) {
  return travel(L, L.depotOut, loc.pick) + LEVEL_PENALTY[loc.level];
}

// Secuencia de visita por vecino más próximo.
export function routeNearest(L, start, stops, end = start) {
  const rest = stops.slice();
  const seq = [];
  let cur = start;
  let dist = 0;
  while (rest.length) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const d = travel(L, cur, rest[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    dist += bd;
    cur = rest[bi];
    seq.push(cur);
    rest.splice(bi, 1);
  }
  dist += travel(L, cur, end);
  return { seq, dist };
}

// Secuencia tal cual viene en el pedido (como un albarán impreso sin ordenar).
export function routeAsListed(L, start, stops, end = start) {
  let cur = start;
  let dist = 0;
  for (const s of stops) { dist += travel(L, cur, s); cur = s; }
  dist += travel(L, cur, end);
  return { seq: stops.slice(), dist };
}

export function routeWaypoints(L, start, seq, end) {
  const pts = [start];
  let cur = start;
  for (const s of [...seq, end]) {
    const p = pathPoints(L, cur, s);
    for (let i = 1; i < p.length; i++) pts.push(p[i]);
    cur = s;
  }
  return pts;
}
