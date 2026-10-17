// Red de suministro de la operativa de automoción. Ficticia: los nombres son genéricos, no empresas.
// Pirámide clásica: muchos Tier 3 (materias primas) → Tier 2 (componentes) → Tier 1 (módulos que
// llegan en secuencia, JIT) → la planta del fabricante (OEM) que monta el coche.
// Unidades: «juegos», lo que lleva un coche de cada cosa. La línea consume 0,5 juegos/min (takt 2 min).

export const TAKT = 2;          // minutos por coche: 30 coches por hora
export const ESTACIONES = 12;   // S01…S12

// Módulos que montan los Tier 1 y estación de la línea donde se instalan (índice desde 0).
export const MODULOS = [
  { id: 'cockpit', estacion: 2, t1: 't1-cockpit', es: 'Cockpit', en: 'Cockpit' },
  { id: 'puertas', estacion: 5, t1: 't1-puertas', es: 'Puertas', en: 'Doors' },
  { id: 'asientos', estacion: 8, t1: 't1-asientos', es: 'Asientos', en: 'Seats' },
  { id: 'frontal', estacion: 10, t1: 't1-frontal', es: 'Frontal', en: 'Front end' },
];

// Insumos (lo que fabrica cada planta de Tier 3 y Tier 2).
export const INSUMOS = {
  acero: { es: 'acero en bobina', en: 'coil steel' },
  granza: { es: 'granza de polímero', en: 'polymer pellets' },
  chip: { es: 'chips', en: 'chips' },
  cobre: { es: 'cobre', en: 'copper' },
  textil: { es: 'textil', en: 'textile' },
  chapa: { es: 'piezas estampadas', en: 'stampings' },
  plastico: { es: 'piezas de plástico', en: 'plastic parts' },
  ecu: { es: 'centralitas (ECU)', en: 'control units (ECU)' },
  funda: { es: 'espumas y fundas', en: 'foams and covers' },
};

// ritmo: juegos/min a plena capacidad · transito: minutos hasta el cliente · lote: juegos por camión.
export const PLANTAS = [
  { id: 't3-acero', tier: 3, es: 'Acería', en: 'Steel mill', produce: 'acero', ritmo: 0.8, transito: 120, lote: 220, x: -112 },
  { id: 't3-granza', tier: 3, es: 'Polímeros', en: 'Polymers', produce: 'granza', ritmo: 2.1, transito: 100, lote: 380, x: -56 },
  { id: 't3-chips', tier: 3, es: 'Semiconductores', en: 'Semiconductors', produce: 'chip', ritmo: 1.4, transito: 140, lote: 240, x: 0 },
  { id: 't3-cobre', tier: 3, es: 'Cobre y cable', en: 'Copper & cable', produce: 'cobre', ritmo: 1.4, transito: 110, lote: 260, x: 56 },
  { id: 't3-textil', tier: 3, es: 'Textil técnico', en: 'Technical textiles', produce: 'textil', ritmo: 0.8, transito: 90, lote: 200, x: 112 },
  { id: 't2-estampacion', tier: 2, es: 'Estampación', en: 'Stamping', produce: 'chapa', usa: ['acero'], ritmo: 0.68, transito: 45, lote: 70, x: -78 },
  { id: 't2-inyeccion', tier: 2, es: 'Inyección de plásticos', en: 'Plastic injection', produce: 'plastico', usa: ['granza'], ritmo: 1.95, transito: 40, lote: 70, x: -26 },
  { id: 't2-electronica', tier: 2, es: 'Electrónica', en: 'Electronics', produce: 'ecu', usa: ['chip', 'cobre'], ritmo: 1.3, transito: 50, lote: 70, x: 26 },
  { id: 't2-tapiceria', tier: 2, es: 'Espumas y tapicería', en: 'Foams & trim', produce: 'funda', usa: ['textil'], ritmo: 0.68, transito: 35, lote: 70, x: 78 },
  { id: 't1-cockpit', tier: 1, es: 'Cockpit', en: 'Cockpit', modulo: 'cockpit', usa: ['plastico', 'ecu'], ritmo: 0.6, transito: 18, x: -57 },
  { id: 't1-puertas', tier: 1, es: 'Puertas', en: 'Doors', modulo: 'puertas', usa: ['chapa', 'plastico'], ritmo: 0.6, transito: 26, x: -19 },
  { id: 't1-asientos', tier: 1, es: 'Asientos', en: 'Seats', modulo: 'asientos', usa: ['funda'], ritmo: 0.6, transito: 14, x: 19 },
  { id: 't1-frontal', tier: 1, es: 'Frontal', en: 'Front end', modulo: 'frontal', usa: ['plastico', 'ecu'], ritmo: 0.6, transito: 30, x: 57 },
];

export const MODELOS = [
  { es: 'Berlina', en: 'Saloon', peso: 3 },
  { es: 'SUV', en: 'SUV', peso: 4 },
  { es: 'SUV híbrido', en: 'Hybrid SUV', peso: 2 },
  { es: 'Familiar', en: 'Estate', peso: 1 },
];
export const COLORES = [
  { es: 'Blanco', en: 'White', hex: 0xe8eaed, peso: 4 },
  { es: 'Gris', en: 'Grey', hex: 0x7b828c, peso: 3 },
  { es: 'Negro', en: 'Black', hex: 0x1d2026, peso: 3 },
  { es: 'Azul', en: 'Blue', hex: 0x2f5fa8, peso: 2 },
  { es: 'Rojo', en: 'Red', hex: 0xb3322e, peso: 1 },
];
// Nombres que se escriben igual en español y en inglés (Lisboa y Sevilla, como Logroño, van en su forma local).
export const CONCESIONARIOS = ['Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Bilbao', 'Lisboa', 'Lyon', 'Stuttgart'];

// Incidencias de HOY (día 0), las que el asistente tiene que saber explicar.
export const INCIDENCIAS_HOY = [
  { tipo: 'cuota', planta: 't3-chips', desde: '06:00', hasta: '22:00', factor: 0.25,
    es: 'el fabricante recorta la cuota de chips al 25 %', en: 'the maker cuts the chip allocation to 25%' },
  { tipo: 'retraso', planta: 't1-asientos', desde: '10:05', minutos: 58,
    es: 'accidente en la autovía', en: 'motorway accident' },
];
