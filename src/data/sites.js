// Tres almacenes ficticios con perfiles distintos. Todo es simulado; las ciudades solo dan contexto.
// Cada uno esconde un problema diferente para que el análisis tenga algo que encontrar:
//  - Zaragoza: hoy tres carretillas pasan por el taller en plena mañana.
//  - Madrid: el almacén sano, sirve de referencia.
//  - Barcelona: la nave va casi llena y el slotting es antiguo.

export const SITES = [
  {
    id: 'zgz',
    nombre: 'Zaragoza',
    zona: 'PLAZA',
    seed: 'estiba-zgz-v1',
    pasillos: 8,
    huecos: 10,
    niveles: 4,
    muellesEntrada: 3,
    muellesSalida: 4,
    carretillas: 5,
    skus: 380,
    pedidosDia: 300,
    camionesEntrada: 11,
    ocupacion: 0.8,
    calidadSlotting: 0.35,
    capCalle: 14,
    rutas: [
      ['Zaragoza ciudad', '08:30'], ['Huesca', '10:00'], ['Lleida', '11:30'], ['Logroño', '13:00'],
      ['Pamplona', '14:30'], ['Teruel', '16:00'], ['Calatayud', '17:30'], ['Soria', '19:00'], ['Zaragoza tarde', '20:30'],
    ],
    incidenciasHoy: [
      { tipo: 'taller', unidades: 2, desde: '09:45', hasta: '15:30', motivo: 'revisión de mástil y baterías' },
    ],
  },
  {
    id: 'mad',
    nombre: 'Madrid',
    zona: 'Coslada',
    seed: 'estiba-mad-v1',
    pasillos: 9,
    huecos: 10,
    niveles: 4,
    muellesEntrada: 4,
    muellesSalida: 5,
    carretillas: 7,
    skus: 420,
    pedidosDia: 330,
    camionesEntrada: 12,
    ocupacion: 0.74,
    calidadSlotting: 0.75,
    capCalle: 16,
    rutas: [
      ['Madrid centro', '08:00'], ['Alcalá', '09:30'], ['Getafe', '11:00'], ['Guadalajara', '12:30'],
      ['Toledo', '14:00'], ['Segovia', '15:30'], ['Ávila', '17:00'], ['Cuenca', '18:30'], ['Madrid tarde', '20:00'],
    ],
    incidenciasHoy: [],
  },
  {
    id: 'bcn',
    nombre: 'Barcelona',
    zona: 'El Prat',
    seed: 'estiba-bcn-v1',
    pasillos: 7,
    huecos: 10,
    niveles: 4,
    muellesEntrada: 3,
    muellesSalida: 4,
    carretillas: 6,
    skus: 410,
    pedidosDia: 270,
    camionesEntrada: 11,
    ocupacion: 0.9,
    calidadSlotting: 0.1,
    capCalle: 12,
    rutas: [
      ['Barcelona centro', '08:30'], ['Sabadell', '10:00'], ['Mataró', '11:30'], ['Girona', '13:00'],
      ['Tarragona', '14:30'], ['Reus', '16:00'], ['Manresa', '17:30'], ['Barcelona tarde', '19:30'],
    ],
    incidenciasHoy: [],
  },
];

export const FAMILIAS = [
  { pref: 'BEB', nombre: 'Bebidas', variantes: ['agua 1,5 L x6', 'refresco lata x24', 'zumo 1 L x6', 'cerveza x12', 'isotónica x12'] },
  { pref: 'DRO', nombre: 'Droguería', variantes: ['detergente 3 L', 'suavizante 2 L', 'lavavajillas x3', 'papel higiénico x12', 'lejía 2 L'] },
  { pref: 'ALI', nombre: 'Alimentación seca', variantes: ['aceite 1 L x12', 'arroz 1 kg x10', 'pasta 500 g x20', 'legumbre x12', 'tomate frito x24'] },
  { pref: 'PER', nombre: 'Perfumería', variantes: ['gel 750 ml x6', 'champú x6', 'pasta dental x12', 'desodorante x12'] },
  { pref: 'BAZ', nombre: 'Bazar', variantes: ['menaje caja', 'pilas x24', 'bolsas basura x20', 'film x12'] },
  { pref: 'MAS', nombre: 'Mascotas', variantes: ['pienso 4 kg', 'arena 10 L', 'snacks x12'] },
];

export const TRANSPORTISTAS = [
  'Transportes Cierzo', 'Logística Moncayo', 'Carga Meseta', 'TransLevante Sur', 'Ruta Ebro',
  'Frigo Pirineo', 'Distribuciones Duero', 'Grupaje Mediterráneo',
];

export const PROVEEDORES = [
  'Bebidas del Valle', 'Hogar Limpio SA', 'Conservas Aragón', 'Cosmética Nórdica', 'Alimentos Sierra',
  'Menaje Ibérico', 'Granja Pirenaica', 'Papelera del Norte',
];
