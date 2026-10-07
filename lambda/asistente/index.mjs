// Lambda del asistente de Estiba: recibe la pregunta y el diagnóstico ya calculado en el navegador
// y pide a Claude (Amazon Bedrock) que lo redacte. El modelo no ve más datos que los que se le pasan.
//
// Variables de entorno:
//   (El CORS lo pone la Function URL; si la Lambda también lo pusiera, la cabecera saldría duplicada.)
//   BEDROCK_REGION   por defecto us-east-1
//   MODELO           por defecto us.anthropic.claude-haiku-4-5-20251001-v1:0
//   TOPE_DIARIO      llamadas por día y contenedor (protección básica de coste, por defecto 300)

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || 'us-east-1', maxAttempts: 1 });
const MODELO = process.env.MODELO || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const TOPE = Number(process.env.TOPE_DIARIO || 300);
let dia = '';
let usadas = 0;

const SISTEMA = `Eres el asistente de operaciones de Estiba, un gemelo digital de almacén. Respondes a un jefe de turno en español de España.
Reglas:
- Usa SOLO los datos del bloque <datos>. Si algo no está, dilo; no inventes cifras, causas ni nombres.
- No hagas cuentas nuevas (restas, tiempos que faltan, porcentajes) salvo que estén en los datos. Las cifras de rutas son PEDIDOS, nunca palés.
- Estados de ruta: "ok" = a tiempo, "justa", "riesgo" = en riesgo, "salio-ok" / "salio-tarde" = ya salió completa / incompleta.
- Las acciones que propongas salen de "accion" en los hallazgos o de la respuesta base; no añadas otras.
- La <respuesta_base> ya está calculada y es correcta: úsala como fuente principal y mejora la redacción, no la contradigas.
- Sé directo: primero la respuesta, luego el porqué y, si procede, qué haría.
- Formato: párrafos cortos, listas con "- " y **negritas** para lo clave. Nada de tablas ni encabezados. Máximo 180 palabras.
- Los datos son simulados; no hace falta repetirlo salvo que pregunten.`;

const headers = { 'content-type': 'application/json; charset=utf-8' };
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

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
  if (!pregunta) return reply(400, { error: 'falta la pregunta' });

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
  mensajes.push({
    role: 'user',
    content: `<datos>${JSON.stringify(input.contexto ?? {})}</datos>\n<respuesta_base>${String(input.respuestaBase || '').slice(0, 4000)}</respuesta_base>\n\nPregunta: ${pregunta}`,
  });

  usadas++;
  try {
    const out = await bedrock.send(new InvokeModelCommand({
      modelId: MODELO,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 600, temperature: 0.2, system: SISTEMA, messages: mensajes }),
    }));
    const data = JSON.parse(new TextDecoder().decode(out.body));
    const texto = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    if (!texto) return reply(502, { error: 'respuesta vacía' });
    return reply(200, { texto });
  } catch (e) {
    console.error('bedrock', e.name, e.message);
    return reply(502, { error: 'el modelo no respondió' });
  }
}
