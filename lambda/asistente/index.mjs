// Lambda del asistente de Estiba: recibe la pregunta y el diagnóstico ya calculado en el navegador
// y pide a Claude (Amazon Bedrock) que lo redacte. El modelo no ve más datos que los que se le pasan.
//
// Dos límites que se COMPRUEBAN, no solo se piden en el prompt:
//  - Cifras: toda cifra u hora que escriba tiene que estar en los datos (cifras.mjs).
//  - Acciones: no las redacta. Escribe solo la explicación y elige acciones de una lista cerrada
//    (contexto.acciones) por su id; la Lambda las añade con su texto exacto. Si la explicación
//    se cuela con recomendaciones propias (acciones.mjs), se le pide que la rehaga.
// Si después del reintento sigue fallando, se devuelve la respuesta base calculada en el navegador.
//
// Variables de entorno:
//   (El CORS lo pone la Function URL; si la Lambda también lo pusiera, la cabecera saldría duplicada.)
//   BEDROCK_REGION   por defecto us-east-1
//   MODELO           por defecto us.anthropic.claude-haiku-4-5-20251001-v1:0
//   TOPE_DIARIO      llamadas por día y contenedor (protección básica de coste, por defecto 300)

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { permitidas, cifrasInventadas } from './cifras.mjs';
import { recomendaciones } from './acciones.mjs';

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || 'us-east-1', maxAttempts: 1 });
const MODELO = process.env.MODELO || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const TOPE = Number(process.env.TOPE_DIARIO || 300);
let dia = '';
let usadas = 0;

const SISTEMA = `Eres el asistente de operaciones de Estiba, un gemelo digital de almacén. Respondes a un jefe de turno usando la herramienta «responder».
- Idioma: el que indique <idioma> ("es" = español de España, "en" = inglés británico), aunque la pregunta venga en otro. Los datos pueden venir en el otro idioma: tradúcelos tú.
Qué va en cada campo:
- «explicacion»: QUÉ está pasando y POR QUÉ, con los datos. NUNCA recomiendes nada aquí: ni acciones, ni consejos, ni imperativos («prioriza», «pide», «libera», «bring in», «focus on»), ni «deberías», «conviene», «hay que», «should», «recommend». Las recomendaciones van solo en «acciones».
- «acciones»: los id de las acciones de <datos>.acciones que vengan al caso de la pregunta, por orden de importancia. Puede ir vacía (por ejemplo si preguntan solo un dato o una comparación). No hay más acciones posibles que esas.
Reglas:
- Usa SOLO los datos de <datos> y <respuesta_base>. Si algo no está, dilo; no inventes cifras, causas ni nombres.
- CIFRAS: escribe solo cifras y horas que aparezcan tal cual en <datos> o en <respuesta_base>. Prohibido calcular: nada de restas, sumas, diferencias, totales, medias ni porcentajes nuevos. Si te falta una cifra, descríbelo sin número.
- No inventes plazos ni previsiones («la próxima hora», «saldrán incompletas») que no estén en los datos.
- Las cifras de rutas son PEDIDOS, nunca palés. Estados de ruta: "ok" = a tiempo, "justa", "riesgo" = en riesgo, "salio-ok" / "salio-tarde" = ya salió completa / incompleta.
- La <respuesta_base> ya está calculada y es correcta: úsala como fuente principal y mejora la redacción, no la contradigas.
- Formato de «explicacion»: párrafos cortos, listas con "- " y **negritas** para lo clave. Nada de tablas ni encabezados. Máximo 140 palabras.
- Los datos son simulados; no hace falta repetirlo salvo que pregunten.`;

const headers = { 'content-type': 'application/json; charset=utf-8' };
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

function herramienta(ids) {
  return {
    name: 'responder',
    description: 'Entrega la respuesta al jefe de turno: la explicación y las acciones elegidas de la lista cerrada.',
    input_schema: {
      type: 'object',
      properties: {
        explicacion: { type: 'string', description: 'Qué pasa y por qué, sin recomendaciones.' },
        acciones: {
          type: 'array',
          description: 'Ids de <datos>.acciones aplicables, por orden de importancia. Puede estar vacía.',
          items: ids.length ? { type: 'string', enum: ids } : { type: 'string' },
        },
      },
      required: ['explicacion', 'acciones'],
    },
  };
}

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === 'OPTIONS') return { statusCode: 204 };
  if (method !== 'POST') return reply(405, { error: 'método no permitido' });

  const hoy = new Date().toISOString().slice(0, 10);
  if (hoy !== dia) { dia = hoy; usadas = 0; }
  if (usadas >= TOPE) return reply(429, { error: 'tope diario alcanzado' });

  let input;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    if (!raw || raw.length > 24000) return reply(413, { error: 'petición demasiado grande' });
    input = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'JSON no válido' });
  }
  const pregunta = String(input.pregunta || '').slice(0, 300).trim();
  const idioma = input.idioma === 'en' ? 'en' : 'es';
  if (!pregunta) return reply(400, { error: 'falta la pregunta' });
  const contexto = input.contexto ?? {};
  const acciones = Array.isArray(contexto.acciones)
    ? contexto.acciones.filter((a) => a && typeof a.id === 'string' && typeof a.texto === 'string').slice(0, 8)
    : [];
  const porId = new Map(acciones.map((a) => [a.id, a]));

  const historial = Array.isArray(input.historial) ? input.historial.slice(-6) : [];
  const mensajes = [];
  for (const h of historial) {
    const role = h.rol === 'usuario' ? 'user' : 'assistant';
    const texto = String(h.texto || '').slice(0, 1500);
    if (!texto) continue;
    if (mensajes.length && mensajes[mensajes.length - 1].role === role) mensajes[mensajes.length - 1].content += `\n${texto}`;
    else mensajes.push({ role, content: texto });
  }
  while (mensajes.length && mensajes[0].role !== 'user') mensajes.shift();
  if (mensajes.length && mensajes[mensajes.length - 1].role === 'user') mensajes.pop();
  const base = String(input.respuestaBase || '').slice(0, 4000);
  mensajes.push({
    role: 'user',
    content: `<idioma>${idioma}</idioma>\n<datos>${JSON.stringify(contexto)}</datos>\n<respuesta_base>${base}</respuesta_base>\n\nPregunta: ${pregunta}`,
  });

  usadas++;
  const permit = permitidas(contexto, base, pregunta);
  const tool = herramienta(acciones.map((a) => a.id));
  const problemas = (r) => {
    const out = [];
    const cifras = cifrasInventadas(r.explicacion, permit);
    if (cifras.length) out.push(idioma === 'en' ? `figures not in the data: ${cifras.join(', ')}` : `cifras que no están en los datos: ${cifras.join(', ')}`);
    const recs = recomendaciones(r.explicacion);
    if (recs.length) out.push(idioma === 'en' ? `recommendations inside «explicacion» (${recs.join(', ')})` : `recomendaciones dentro de «explicacion» (${recs.join(', ')})`);
    const raras = r.acciones.filter((id) => !porId.has(id));
    if (raras.length) out.push(`ids: ${raras.join(', ')}`);
    return out;
  };

  try {
    let r = await llamar(mensajes, tool);
    let fallos = problemas(r);
    if (fallos.length) {
      console.warn('respuesta rechazada (1.º intento):', fallos.join(' | '));
      const aviso = idioma === 'en'
        ? `Rejected: ${fallos.join('; ')}. Call «responder» again fixing that: «explicacion» only says what happens and why, with figures copied from the data; recommendations only as ids in «acciones».`
        : `Rechazada: ${fallos.join('; ')}. Vuelve a llamar a «responder» corrigiéndolo: «explicacion» solo cuenta qué pasa y por qué, con cifras copiadas de los datos; las recomendaciones, solo como ids en «acciones».`;
      r = await llamar([
        ...mensajes,
        { role: 'assistant', content: [{ type: 'tool_use', id: r.id, name: 'responder', input: r.raw }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: r.id, is_error: true, content: aviso }] },
      ], tool);
      fallos = problemas(r);
    }
    if (fallos.length || !r.explicacion) {
      console.warn('respuesta rechazada (2.º intento): se usa la respuesta base:', fallos.join(' | '));
      return reply(200, { texto: base, fuente: 'base' });
    }
    const elegidas = [...new Set(r.acciones)].map((id) => porId.get(id));
    const texto = elegidas.length
      ? `${r.explicacion}\n\n**${idioma === 'en' ? 'What to do' : 'Qué hacer'}:**\n${elegidas.map((a) => `- **${a.titulo}:** ${a.texto}`).join('\n')}`
      : r.explicacion;
    return reply(200, { texto, fuente: 'modelo' });
  } catch (e) {
    console.error('bedrock', e.name, e.message);
    return reply(502, { error: 'el modelo no respondió' });
  }
}

async function llamar(messages, tool) {
  const out = await bedrock.send(new InvokeModelCommand({
    modelId: MODELO,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 700,
      temperature: 0,
      system: SISTEMA,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'responder' },
      messages,
    }),
  }));
  const data = JSON.parse(new TextDecoder().decode(out.body));
  const uso = (data.content || []).find((c) => c.type === 'tool_use' && c.name === 'responder');
  if (!uso) throw new Error('sin tool_use');
  const raw = uso.input || {};
  return {
    id: uso.id,
    raw,
    explicacion: String(raw.explicacion || '').trim(),
    acciones: Array.isArray(raw.acciones) ? raw.acciones.map(String) : [],
  };
}
