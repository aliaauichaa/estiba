// ¿La pregunta trata de Ali (el creador) o de qué es Estiba, o del turno del almacén?
// clasificar() devuelve 'ali', 'turno' o 'dudosa'. Las dudosas las resuelve la Lambda con una llamada corta
// al modelo (ali.mjs temaDe); la web, sin Lambda, sigue el hilo (esPreguntaSobreAli).
//
// Tres niveles de señal (revisiones del 07-10-2026: con palabras clave solas fallaba en los dos sentidos,
// porque el vocabulario de un reclutador de logística y el de un jefe de turno se pisan):
//  - FUERTE: solo puede ser sobre Ali o sobre Estiba como proyecto (su nombre, su CV, LinkedIn, sus empresas
//    y proyectos, «quién ha hecho esto», Estiba + usar/precio/clientes/tecnología…). Decide sola.
//  - DÉBIL: vocabulario de perfil (experiencia, estudios, encaje, «ha trabajado», he/his…). Decide solo si
//    no hay vocabulario del turno; si lo hay, es dudosa.
//  - TURNO: vocabulario de la operativa (y los destinos y el almacén del contexto). Decide sola, salvo que la
//    respuesta anterior fuera sobre Ali: entonces es dudosa (seguimientos como «¿Ha gestionado almacenes?»).
// Ojo, del turno: ALI-1042 (familia «Alimentación»), «hire a forklift», «resume» (reanudar), «hueco vacante»,
// «referencia candidata», «perfil de demanda», «certificado de calidad», «estudio de tiempos», «CV de la
// demanda», «teléfono del transportista», «carretilleros senior», «who created this order».

// Sin tildes con una tabla explícita, sin depender de String.normalize ni de los datos ICU del entorno.
const TILDES = { á: 'a', à: 'a', â: 'a', ä: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e', í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', ú: 'u', ù: 'u', û: 'u', ü: 'u', ñ: 'n', ç: 'c' };
const norm = (s) => String(s || '').toLowerCase().replace(/[áàâäéèêëíìîïóòôöúùûüñç]/g, (c) => TILDES[c]);
const re = (partes) => new RegExp(partes.join('|'));

// «Esto» como la app: nunca «this» suelto («who created this order?»).
const APP = String.raw`(esto|estiba|la app|la aplicacion|la web|la pagina|la demo|la herramienta|el proyecto|el gemelo|esta (app|aplicacion|web|pagina|demo|herramienta|plataforma)|este (proyecto|gemelo|simulador)|this (app|site|tool|demo|project|simulator|thing)|the (app|site|tool|demo|project|simulator))`;
const VERBO_ES = String.raw`(h?a (hecho|echo)|hizo|hiso|h?a creado|creo|h?a desarrollado|desarrollo|h?a programado|programo|h?a disenado|diseno)`;
const VERBO_EN = String.raw`(made|built|created|developed|designed|wrote|coded|is behind|s behind)`;

const FUERTE = re([
  String.raw`\bali\b(?![- ]?\d)`, 'aauicha', 'azghouli', 'linkedin',
  String.raw`\b(su|sus|his|her) (cv|curriculum|curriculo|resume|linkedin|github|portfolio|portafolio)\b`, String.raw`\b(el|tu|un|a|the|your) (cv|curriculum|curriculo|resume)( de| of| del)? ?(ali|el creador|el desarrollador|the developer|the creator|him)?\s*\??$`,
  String.raw`\b(quillaflow|mi campo|micampo|shootingstats|sese|paack|fluiconnecto|in4\.?0|bae systems)\b`,
  // Quién la ha hecho / who built it.
  String.raw`\bquien\b.{0,25}\b${VERBO_ES}\b.{0,15}\b${APP}\b`, String.raw`\bquien (te|lo|la|os) ${VERBO_ES}\b`,
  String.raw`\b(quien|who)\b.{0,25}\b${VERBO_ES}\s*\??$`, String.raw`\bwho\b.{0,20}\b${VERBO_EN}\b.{0,10}\b(you|it|this)\s*\??$`,
  String.raw`\bquien esta detras\b`, String.raw`\bde quien es (esto|estiba|${APP})\b`, String.raw`\b(el|la) que ${VERBO_ES} ${APP}\b`,
  String.raw`\bwho\b.{0,20}\b${VERBO_EN}\b.{0,15}\b(${APP}|you)\b`, String.raw`\bwho('s| is) (the )?(author|creator|developer|programmer)\b`,
  String.raw`\b(creador|creadora|creator|autor|autora|author)\b`, String.raw`\b(the|el|la) (developer|desarrollador|desarrolladora|programador|programadora)\s*\??$`,
  String.raw`\b(tell me about|hablame (de|del)|cuentame (de|del|sobre)) (the |el |la )?(developer|desarrollador|programador|creador|creator|author|autor)\b`,
  // Estiba como producto o proyecto.
  String.raw`\bestiba\b.{0,40}\b(usar|uso|use|license|licencia|comprar|buy|precio|price|cuesta|cost|implantar|instalar|install|conectar|integrar|integrat|real|reales|clientes|usuarios|customers|users|tecnolog|technolog|stack|codigo|code|github|open source|produccion|production|demo|simula)`,
  String.raw`\b(usar|use|license|licenciar|comprar|buy|implantar|instalar|install|integrar|integrate)\b.{0,20}\bestiba\b`,
  String.raw`\b(como (esta|fue|se ha) hech[oa]|how (is|was))\s${APP}\s?(built|made)?`,
  String.raw`\b(que es|para que sirve|what is|what does) (estiba|esta (app|aplicacion|web|demo|herramienta)|this (app|site|tool|demo|project))\b`,
  String.raw`\b(que es esto|what is this|what is it)\s*\??$`, String.raw`\bwhat does estiba do\b`,
  String.raw`\b(tech stack|stack tecnico|(what|which) (tech )?stack (does|is|did) (it|this|estiba)|built with|con que (esta|fue) hech[oa]|que tecnologias? (usa|tiene|lleva)|codigo fuente|source code|open source|repositorio|repository)\b`,
  String.raw`\b((los )?datos son reales|son datos reales|son reales (los|estos) datos|(is|are) (the |this |these )?data real|is (it|this|estiba) real(?![- ]time)|(estiba|esto|la app|la demo) (se usa|se ha usado|esta) en (algun|un|almacenes)|used (in|by) real|real warehouses?|almacen(es)? (real(es)?|de verdad))\b`,
  // Su contacto y su persona (con referencia inequívoca).
  String.raw`\b(contactar con (ali|el creador|el desarrollador|el autor)|contactarle|contact (him|the developer|the creator)|(su|his) (telefono|phone|email|correo)|donde vive|where (does he|is he) (live|based)|where is he based)\b`,
  String.raw`\b(hire (him|ali|the (developer|creator))|hiring (him|ali)|contratarle|contratarlo|contratar a (ali|el creador|el desarrollador))\b`,
]);

const DEBIL = re([
  String.raw`\b(he|his|him|el es|ella|has he|was he|had he|is he|would he|does he|did he|can he|he's|the candidate|el candidato|in real life)\b`,
  String.raw`\b(su|sus) (experiencia|perfil|trayectoria|formacion|estudios|carrera|nivel|ingles|idiomas|puesto|trabajo|empleo|disponibilidad|situacion)\b`,
  String.raw`\b(ha|habia|ha sido|fue) (trabajado|gestionado|liderado|usado|dirigido|coordinado|sido (jefe|responsable|encargado|analista))\b`,
  String.raw`\b(se dedica|esta trabajando|trabaja ahora|busca trabajo|esta disponible|disponible para|dispuesto|willing|relocat|mudar\w*|trabajaria|sabe (sql|python|excel|sap|aws|ingles|hacer|usar|programar)|habla (ingles|arabe))\b`,
  String.raw`\b(trayectoria profesional|career|carrera profesional|work experience|years of experience|anos de experiencia|experiencia (profesional|laboral|previa|en (logistica|almacenes?|supply|cloud|aws))|tiene experiencia|has experience|experience (in|with))\b`,
  String.raw`\bque estudio\s*\??$`, String.raw`\b(que hizo|what did he do|what has he done)\b`, String.raw`\b(que|sus|his) (certificad\w*|certifications?|titulos?)\b`,
  String.raw`\b(estudios|donde estudio|formacion academica|titulacion|education|(a|his|the|un) degree|degree in|bachelor|grado en|(a|his|un|el|su) master'?s?|master'?s degree|universidad|university|certificacion(es)?|certificad[oa]s? (de aws|de sap|oficial)|certifications?|certified)\b`,
  String.raw`\b(junior|senior|entrevista|interview|freelance|salario|salary|tarifa|(his|su|day|hourly|daily) rate|remoto|remote|una vacante|a vacancy|(buen|gran|good|strong|great) (candidato|candidate|fit)|encaj\w*|(un|una) (puesto|vacante|oferta) de|puesto de (analista|desarrollador|developer|ingeniero|engineer|jefe|responsable|trabajo)|jefe de almacen|warehouse manager|(a|this|the) (role|position|job) (as|of|for)|tiene el perfil|el perfil para|fit for)\b`,
  String.raw`\b(que idiomas|what languages|nivel de ingles|english level|habla ingles|speak english|his english)\b`,
  String.raw`\b(developer|desarrollador|desarrolladora|programador|programadora)\b`,
]);

// Vocabulario del turno (sin palabras de conversación corriente como «hoy», «ahora», «estado», «resumen»).
const TURNO = /\b([a-z]{3}-\d{4}|otif|fill|dock|muelle|recepcion|calle|carretill|forklift|ruta|route|camion|truck|stock|rotura|slotting|abc|picking|picker|ola|wave|ocupacion|occupancy|hueco|turno|shift|kpi|pedido|order|pale|palet|pallet|zaragoza|madrid|barcelona|almacen|warehouse|pasillo|aisle|sku|referencia|operari|retraso|delay|taller|workshop|inventario|inventory|expedicion|dispatch|salida|cuello de botella|bottleneck|urgente|urgent|prioridad|priorit|que hago|que hacemos|what should i do|what do i do|transportista|carrier|proveedor|supplier|demanda|demand|previsi|forecast|riesgo|risk|compar|productiv|como va|como vamos|how('s| is) (it|the day|everything) going|how are we doing)/;
const SALUDO = /^\s*(hola|buenas|buenos dias|buenas tardes|hello|hi|hey|good (morning|afternoon|evening))\b[\s!.,¡]*$/;

const ES_RESPUESTA_ALI = /linkedin\.com\/in\/ali-aauicha/i;
const ultimaRespuesta = (historial) => [...(Array.isArray(historial) ? historial : [])].reverse().find((h) => h && h.rol !== 'usuario');
export const ultimaFueSobreAli = (historial) => ES_RESPUESTA_ALI.test(String(ultimaRespuesta(historial)?.texto || ''));

// Destinos de ruta y almacén del contexto que manda la web (o los del simulador en la propia web).
function nombraElTurno(q, contexto) {
  const nombres = [String(contexto?.almacen || '').split(/[ (]/)[0],
    ...(Array.isArray(contexto?.rutas) ? contexto.rutas : []).map((r) => String(r?.destino || ''))]
    .map(norm).filter((n) => n.length > 2);
  return nombres.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q));
}

export function clasificar(pregunta, historial = [], contexto = {}) {
  const q = norm(pregunta);
  if (!q.trim() || SALUDO.test(q)) return 'turno';
  if (FUERTE.test(q)) return 'ali';
  const turno = TURNO.test(q) || nombraElTurno(q, contexto);
  const debil = DEBIL.test(q);
  if (debil) return turno ? 'dudosa' : 'ali';
  if (turno) return ultimaFueSobreAli(historial) && !/\b[a-z]{3}-\d{4}\b/.test(q) && !nombraElTurno(q, contexto) ? 'dudosa' : 'turno';
  return 'dudosa';
}

// Para la web (etiqueta y respuesta local sin Lambda), sin modelo: lo dudoso sigue el hilo de la respuesta
// anterior solo si no trae vocabulario del turno, o si trae además señal de perfil («¿Ha gestionado
// almacenes?» tras hablar de Ali sí; «¿Y el OTIF?» no).
export function esPreguntaSobreAli(pregunta, historial = [], contexto = {}) {
  const c = clasificar(pregunta, historial, contexto);
  if (c !== 'dudosa') return c === 'ali';
  if (!ultimaFueSobreAli(historial)) return false;
  const q = norm(pregunta);
  return DEBIL.test(q) || !(TURNO.test(q) || nombraElTurno(q, contexto));
}

// Prompt de la llamada corta que resuelve las dudosas en la Lambda (ali.mjs temaDe).
export function promptClasificador(pregunta, historial = [], contexto = {}) {
  const previa = String(ultimaRespuesta(historial)?.texto || '').slice(0, 400);
  const destinos = (Array.isArray(contexto?.rutas) ? contexto.rutas : []).map((r) => String(r?.destino || '')).filter(Boolean).slice(0, 12);
  const almacen = String(contexto?.almacen || '').slice(0, 60);
  return `Chat de Estiba, un gemelo digital de almacén (demo de portafolio de Ali Aauicha Azghouli). Clasifica la ÚLTIMA pregunta del visitante.
- "ali": pregunta por la persona que creó la app (quién es, trayectoria, experiencia en logística o almacenes, estudios, nivel, encaje en un puesto, contacto, dónde vive, idiomas, sus otros proyectos) o por qué es Estiba como proyecto (quién la hizo, si es real o se usa en almacenes reales, cómo está hecha, para qué sirve). También los seguimientos de una conversación sobre Ali, aunque usen palabras de almacén ("¿ha gestionado almacenes?").
- "turno": pregunta por la operativa del almacén simulado (indicadores, rutas, muelles, carretillas, stock, operarios o equipos del almacén, qué hacer ahora), o un saludo.
${almacen || destinos.length ? `Almacén del turno: ${almacen || '—'}; destinos de sus rutas: ${destinos.join(', ') || '—'} (si la pregunta los nombra, es del turno).\n` : ''}${previa ? `Respuesta anterior del asistente: «${previa}»\n` : ''}Pregunta: «${String(pregunta).slice(0, 300)}»
Responde solo con una palabra: ali o turno.`;
}
