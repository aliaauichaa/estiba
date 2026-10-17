// Operativas que se pueden elegir arriba. Cada una sabe montar su simulación, su escena y sus paneles.
import { crearAlmacen } from './almacen.js';
import { crearAutomocion } from './automocion.js';
import { crearUltimaMilla } from './ultimamilla.js';

export const OPERATIVAS = [crearAlmacen(), crearAutomocion(), crearUltimaMilla()];
