// Red de última milla: un cross-dock que recibe la mercancía de los clientes, la clasifica por
// delegación de provincia y la manda en camiones (olas); en cada delegación, los conductores la
// reparten al cliente final. Volúmenes e incidencias simulados; las marcas se citan solo como
// ejemplo del tipo de cliente (moda, deporte, comida a domicilio, e-commerce).

export const CROSSDOCK = { es: 'Cross-dock Getafe', en: 'Getafe cross-dock' };

export const CLIENTES = [
  { id: 'zara', nombre: 'Zara', pref: 'ZR', bultos: 2900, camiones: 3, color: 0xe8eaed },
  { id: 'inditex', nombre: 'Inditex', pref: 'IN', bultos: 1900, camiones: 2, color: 0xb9c2cf },
  { id: 'decathlon', nombre: 'Decathlon', pref: 'DC', bultos: 1800, camiones: 2, color: 0x3b82c4 },
  // Comida a domicilio: va refrigerada y se reparte primero en la ruta.
  { id: 'gousto', nombre: 'Gousto', pref: 'GO', bultos: 900, camiones: 1, color: 0x46c46f, frio: true },
  { id: 'ecommerce', nombre: 'E-commerce', pref: 'EC', bultos: 1500, camiones: 2, color: 0xc9a36b, es: 'E-commerce varios', en: 'Assorted e-commerce' },
];

// Delegaciones: rumbo (grados desde el norte) y distancia en km desde el cross-dock, para el esquema;
// tránsito del camión en minutos; parte del volumen y conductores.
export const DELEGACIONES = [
  { id: 'mad-n', cod: 'MNO', es: 'Madrid Norte', en: 'Madrid North', rumbo: 5, km: 30, transito: 35, cuota: 0.22, conductores: 18 },
  { id: 'mad-e', cod: 'MES', es: 'Madrid Este', en: 'Madrid East', rumbo: 82, km: 28, transito: 30, cuota: 0.17, conductores: 14 },
  { id: 'guadalajara', es: 'Guadalajara', en: 'Guadalajara', rumbo: 50, km: 65, transito: 50, cuota: 0.09, conductores: 8 },
  { id: 'cuenca', es: 'Cuenca', en: 'Cuenca', rumbo: 112, km: 150, transito: 105, cuota: 0.08, conductores: 7 },
  { id: 'ciudad-real', es: 'Ciudad Real', en: 'Ciudad Real', rumbo: 182, km: 175, transito: 115, cuota: 0.12, conductores: 10 },
  { id: 'toledo', es: 'Toledo', en: 'Toledo', rumbo: 212, km: 55, transito: 55, cuota: 0.13, conductores: 11 },
  { id: 'avila', es: 'Ávila', en: 'Ávila', rumbo: 292, km: 110, transito: 85, cuota: 0.08, conductores: 6 },
  { id: 'segovia', es: 'Segovia', en: 'Segovia', rumbo: 332, km: 90, transito: 75, cuota: 0.11, conductores: 9 },
];

// Olas de salida del cross-dock a las delegaciones y reparto de conductores previsto por ola.
export const OLAS = [
  { hora: '09:00', conductores: 0.45 },
  { hora: '12:00', conductores: 0.35 },
  { hora: '15:00', conductores: 0.2 },
];

export const CONDUCTOR_MAX = 140;   // bultos que caben en una furgoneta por ruta
export const FIN_REPARTO = '21:30';

export const INCIDENCIAS_HOY = [
  { tipo: 'sorter', desde: '08:05', hasta: '09:05', es: 'atasco en la inducción', en: 'jam at the induction point' },
  { tipo: 'retraso', cliente: 'zara', minutos: 75, es: 'retenido en la salida de su almacén', en: 'held at its warehouse exit' },
  { tipo: 'bajas', delegacion: 'toledo', conductores: 3, es: 'conductores de baja', en: 'drivers off sick' },
];
