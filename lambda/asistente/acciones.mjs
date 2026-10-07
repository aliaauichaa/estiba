// Detecta recomendaciones dentro de la explicación del modelo. Las acciones solo pueden venir de la
// lista cerrada del diagnóstico (por id); si la explicación aconseja algo por su cuenta, se rechaza.
// Es una heurística deliberadamente estricta: un falso positivo solo cuesta un reintento.

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Expresiones de consejo en cualquier punto de la frase.
const CONSEJO = [
  // español
  /\bdeberia(s|mos|n)?\b/, /\bdebe(s|mos|n)?\b/, /\bconvien(e|en)\b/, /\bconvendria\b/, /\bhay que\b/, /\bhabria que\b/,
  /\brecomiend[oa]\b/, /\brecomendable\b/, /\brecomendaria\b/, /\bsugier[oe]\b/, /\btienes que\b/, /\btendrias que\b/,
  /\bes necesario\b/, /\bnecesitas\b/, /\bmi consejo\b/, /\blo ideal\b/,
  // inglés
  /\bshould(n't)?\b/, /\bmust\b/, /\bneeds? to\b/, /\brecommend/, /\bsuggest/, /\bi'?d\b/, /\bi would\b/,
  /\bconsider\b/, /\btry to\b/, /\bmake sure\b/, /\byou could\b/, /\bbest to\b/, /\bit'?s worth\b/,
];

// Imperativos al principio de una frase o de un punto de lista.
const IMPERATIVO = /^(prioriza|pide|solicita|libera|concentra|centra|retrasa|adelanta|avisa|habilita|ubica|revisa|consolida|trae|alquila|empieza|deja de|refuerza|reparte|programa|bring|prioriti[sz]e|focus|release|hold|warn|hire|rent|call|ask|move|speed up|start|stop|consolidate|review|open|delay|spread|book|get|add|pull|shift|reassign|put)\b/;

export function recomendaciones(texto) {
  const t = norm(texto);
  const hits = [];
  for (const re of CONSEJO) {
    const m = t.match(re);
    if (m) hits.push(m[0]);
  }
  const frases = t.split(/(?<=[.!?:;])\s+|\n+/);
  for (let f of frases) {
    f = f.replace(/^[\s\-*•\d.)]+/, '').replace(/^\*+/, '').trim();
    const m = f.match(IMPERATIVO);
    if (m) hits.push(m[0]);
  }
  return [...new Set(hits)];
}
