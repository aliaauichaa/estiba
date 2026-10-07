// Lambda del asistente de Estiba: recibe la pregunta y el diagnóstico ya calculado en el navegador
// y pide a Claude (Amazon Bedrock) que lo redacte. El modelo no ve más datos que los que se le pasan.
//
// Variables de entorno:
//   (El CORS lo pone la Function URL; si la Lambda también lo pusiera, la cabecera saldría duplicada.)
//   BEDROCK_REGION   por defecto us-east-1
//   MODELO           por defecto us.anthropic.claude-haiku-4-5-20251001-v1:0
//   TOPE_DIARIO      llamadas por día y contenedor (protección básica de coste, por defecto 300)

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { permitidas, cifrasInventadas } from './cifras.mjs';

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || 'us-east-1', maxAttempts: 1 });
const MODELO = process.env.MODELO || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const TOPE = Number(process.env.TOPE_DIARIO || 300);
let dia = '';
let usadas = 0;

const SISTEMA = `Eres el asistente de operaciones de Estiba, un gemelo digital de almacén. Respondes a un jefe de turno.
- Idioma: el que indique <idioma> ("es" = español de España, "en" = inglés británico), aunque la pregunta venga en otro. Los datos pueden venir en el otro idioma: tradúcelos tú.
Reglas:
- Usa SOLO los datos del bloque <datos>. Si algo no está, dilo; no inventes cifras, causas ni nombres.
- CIFRAS: escribe solo cifras y horas que aparezcan tal cual en <datos> o en <respuesta_base>. Prohibido calcular: nada de restas, sumas, diferencias, totales, medias ni porcentajes nuevos. Si te falta una cifra, descríbelo sin número.
- No inventes plazos ni horizontes («la próxima hora», «esta tarde») que no estén en los datos.
- Las cifras de rutas son PEDIDOS, nunca palés.
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
  const idioma = input.idioma === 'en' ? 'en' : 'es';
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
    content: `<idioma>${idioma}</idioma>
<datos>${JSON.stringify(input.contexto ?? {})}</datos>\n<respuesta_base>${String(input.respuestaBase || '').slice(0, 4000)}</respuesta_base>\n\nPregunta: ${pregunta}`,
  });

  usadas++;
  const base = String(input.respuestaBase || '');
  const permit = permitidas(input.contexto ?? {}, base, pregunta);
  try {
    // Primer intento; si escribe alguna cifra que no está en los datos, se le pide que lo rehaga
    // sin ella. Si aun así falla, se devuelve la respuesta base (calculada, correcta) y no la suya.
    let texto = await llamar(mensajes);
    let malas = cifrasInventadas(texto, permit);
    if (malas.length) {
      console.warn('cifras no permitidas (1.º intento)', malas.join(' '));
      const aviso = idioma === 'en'
        ? `Your answer contains figures that are not in the data: ${malas.join(', ')}. Rewrite it without them. Do not calculate anything: only figures that appear in <datos> or <respuesta_base>.`
        : `Tu respuesta tiene cifras que no están en los datos: ${malas.join(', ')}. Reescríbela sin ellas. No calcules nada: solo cifras que aparezcan en <datos> o en <respuesta_base>.`;
      texto = await llamar([...mensajes, { role: 'assistant', content: texto }, { role: 'user', content: aviso }]);
      malas = cifrasInventadas(texto, permit);
    }
    if (malas.length) {
      console.warn('cifras no permitidas (2.º intento): se usa la respuesta base', malas.join(' '));
      return reply(200, { texto: base, fuente: 'base' });
    }
    if (!texto) return reply(502, { error: 'respuesta vacía' });
    return reply(200, { texto, fuente: 'modelo' });
  } catch (e) {
    console.error('bedrock', e.name, e.message);
    return reply(502, { error: 'el modelo no respondió' });
  }
}

async function llamar(messages) {
  const out = await bedrock.send(new InvokeModelCommand({
    modelId: MODELO,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 600, temperature: 0, system: SISTEMA, messages }),
  }));
  const data = JSON.parse(new TextDecoder().decode(out.body));
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}
