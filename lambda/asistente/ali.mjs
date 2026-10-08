// Preguntas sobre Ali (el creador) o sobre qué es Estiba: misma ficha y mismo tratamiento que los chats
// públicos de Mi Campo y Quillaflow (ficha-ali.mjs, copiada por `node sincronizar.mjs` desde
// Proyecto IA/ficha-ali; no editar la copia). Sin el SDK de AWS: `invocar` lo pone index.mjs (y las pruebas).

import { buildEstibaPublicPrompt, HERRAMIENTA_DATOS, textoRespuestaPublica, LINKEDIN, contieneNegacion } from './ficha-ali.mjs';
import { clasificar, esPreguntaSobreAli, promptClasificador } from './ruta.mjs';

// ¿Ficha de Ali o asistente del turno? Las señales claras deciden sin modelo (ruta.mjs); las dudosas, una
// llamada mínima (5 tokens de salida). Si esa llamada falla, se sigue el hilo de la respuesta anterior.
export async function temaDe(pregunta, historial, invocar, contexto = {}) {
  const c = clasificar(pregunta, historial, contexto);
  if (c !== 'dudosa') return c;
  try {
    const data = await invocar({ max_tokens: 5, temperature: 0, messages: [{ role: 'user', content: promptClasificador(pregunta, historial, contexto) }] });
    const t = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('').toLowerCase();
    if (/\bali\b/.test(t)) return 'ali';
    if (/\bturno\b/.test(t)) return 'turno';
  } catch (e) {
    console.warn('clasificador', e?.name, e?.message);
  }
  return esPreguntaSobreAli(pregunta, historial, contexto) ? 'ali' : 'turno';
}

// Historial del chat ({rol, texto}) a mensajes de la API: solo texto, alternando, empezando por el usuario.
export function mensajesDe(historial, ultimo) {
  const mensajes = [];
  for (const h of (Array.isArray(historial) ? historial : []).slice(-6)) {
    const role = h?.rol === 'usuario' ? 'user' : 'assistant';
    const texto = String(h?.texto || '').slice(0, 1500);
    if (!texto) continue;
    if (mensajes.length && mensajes[mensajes.length - 1].role === role) mensajes[mensajes.length - 1].content += `\n${texto}`;
    else mensajes.push({ role, content: texto });
  }
  while (mensajes.length && mensajes[0].role !== 'user') mensajes.shift();
  if (mensajes.length && mensajes[mensajes.length - 1].role === 'user') mensajes.pop();
  mensajes.push({ role: 'user', content: ultimo });
  return mensajes;
}

const textoLibre = (content) => (Array.isArray(content) ? content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
const usaHerramienta = (content) => (Array.isArray(content) ? content : []).some((b) => b?.type === 'tool_use');

// El prompt público de la ficha va con caché (unos 8.500 tokens que se repiten en cada pregunta) y la
// herramienta de datos verificados en modo auto. textoRespuestaPublica escribe los datos si el modelo usa
// la herramienta y, en todo caso, deja solo enlaces de la ficha y el LinkedIn de Ali visible.
// Arreglos de las revisiones del 07-10-2026:
//  - Texto libre que rompe una regla que el prompt no basta para sostener (ver problemasDelTexto): se le
//    pide UNA reescritura. Cuenta en el tope (opciones.alReescribir).
//  - El LinkedIn va siempre: todo lo que llega aquí trata de Ali o de su demo, y el postproceso común solo
//    lo añade si aparece la palabra «Ali» (el modelo a veces escribe «su CV» o, peor, «tu CV»).
const DICE_SER_ALI = /\b(soy|i'?m|i am|this is|aqu[ií] (est[aá]|habla)) ali\b/i;
const SEGUNDA_PERSONA = /\b(tu|tus) (cv|perfil|experiencia|trayectoria|formaci\w+|linkedin|correo|email|trabajo|puntos)\b|\bcontigo\b|\byour (cv|profile|experience|background|email|linkedin|work|skills)\b|\byou (completed|have|studied|worked|did)\b/i;
const VALORACION = /\b(strong (match|fit)|good fit|great fit|ideal candidate|perfect (fit|candidate)|proven|expertise|domina|experto|buen encaje|encaja perfectamente|recomiendo (contratarle|contratarlo|contratar))\b/i;

export function problemasDelTexto(texto, pregunta, idioma) {
  const en = idioma === 'en';
  const out = [];
  if (contieneNegacion(texto)) out.push(en
    ? 'you turned something that is not documented into a denial ("does not have", "never"): say it is not documented in the available information, without stating that Ali lacks it'
    : 'has convertido algo que no consta en una negación («no tiene», «nunca»): di que no está documentado en la información disponible, sin afirmar que Ali no lo tiene');
  if (DICE_SER_ALI.test(pregunta) && SEGUNDA_PERSONA.test(texto)) out.push(en
    ? 'you cannot verify who is writing: talk about Ali in the third person ("his CV", never "your CV"), give no personal advice and do not mention this rule'
    : 'no puedes comprobar quién escribe: habla de Ali en tercera persona («su CV», nunca «tu CV»), sin consejos personales y sin mencionar esta regla');
  if (VALORACION.test(texto)) out.push(en
    ? 'you assessed his fit or level ("strong match", "proven", "expertise"…): give only the documented evidence and what to check in an interview, without recommending or choosing'
    : 'has valorado su encaje o su nivel («buen encaje», «experto»…): da solo la evidencia documentada y qué contrastar en la entrevista, sin recomendar ni elegir');
  return out;
}

export async function responderSobreAli({ pregunta, idioma, historial }, invocar, { alReescribir = () => {}, now = new Date() } = {}) {
  const prompt = buildEstibaPublicPrompt(idioma, now);
  const peticion = (messages) => invocar({
    max_tokens: 1200,
    temperature: 0.2,
    system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
    tools: [HERRAMIENTA_DATOS],
    tool_choice: { type: 'auto' },
    messages,
  });
  const mensajes = mensajesDe(historial, pregunta);
  let data = await peticion(mensajes);
  const libre = textoLibre(data?.content);
  const problemas = usaHerramienta(data?.content) ? [] : problemasDelTexto(libre, pregunta, idioma);
  if (problemas.length) {
    const aviso = idioma === 'en'
      ? `Rewrite your whole answer, keeping what is right: ${problemas.join('; ')}.`
      : `Reescribe la respuesta entera y mantén lo que está bien: ${problemas.join('; ')}.`;
    alReescribir();
    try {
      const otra = await peticion([...mensajes, { role: 'assistant', content: libre }, { role: 'user', content: aviso }]);
      if (textoLibre(otra?.content) || usaHerramienta(otra?.content)) data = otra;
    } catch (e) {
      console.warn('reescritura (ali)', e?.name, e?.message);
    }
  }
  let texto = textoRespuestaPublica(data?.content, { prompt, idioma });
  if (!texto) throw new Error('respuesta vacía');
  if (!texto.includes('linkedin.com/in/ali-aauicha')) {
    texto = `${texto.trimEnd()}\n\n${idioma === 'en' ? 'More about Ali' : 'Más sobre Ali'}: ${LINKEDIN}`;
  }
  return texto;
}
