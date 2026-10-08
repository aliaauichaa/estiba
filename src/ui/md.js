// Markdown mínimo para las respuestas del asistente: párrafos, listas, negritas y enlaces. Escapa todo lo demás.
// Enlaces: [texto](https://…) y URLs sueltas (las respuestas sobre Ali terminan con su LinkedIn visible).
// Solo http(s) y mailto; se abren en otra pestaña.

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// La URL suelta no se come comillas («», "", '), la comilla invertida ni los ** de una negrita.
const ENLACE = /\[([^\[\]]+)\]\(((?:https?:\/\/|mailto:)[^\s()]+)\)|(https?:\/\/[^\s<>()\[\]«»"'`*]+)/g;
const a = (url, texto) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${texto}</a>`;

function inline(s) {
  const enlaces = [];
  // Los enlaces se apartan antes de escapar y de aplicar negritas; luego se reponen (\u0000n\u0000).
  const conMarcas = s.replace(ENLACE, (m, texto, url, suelta) => {
    if (suelta) {
      const recorte = suelta.match(/[.,;:!?]+$/)?.[0] || '';  // el punto final no es parte de la URL
      const limpia = recorte ? suelta.slice(0, -recorte.length) : suelta;
      enlaces.push(a(limpia, esc(limpia)) + esc(recorte));
    } else {
      enlaces.push(a(url, esc(texto).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')));
    }
    return `\u0000${enlaces.length - 1}\u0000`;
  });
  return esc(conMarcas)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\u0000(\d+)\u0000/g, (m, i) => enlaces[Number(i)]);
}

export function md(text) {
  const blocks = text.trim().split(/\n{2,}/);
  return blocks.map((b) => {
    const lines = b.split('\n');
    const html = [];
    let list = null;
    for (const line of lines) {
      const ul = line.match(/^\s*-\s+(.*)$/);
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) {
          if (list) html.push(`</${list.tag}>`);
          list = { tag };
          html.push(`<${tag}>`);
        }
        html.push(`<li>${inline((ul || ol)[1])}</li>`);
      } else {
        if (list) { html.push(`</${list.tag}>`); list = null; }
        html.push(`<p>${inline(line)}</p>`);
      }
    }
    if (list) html.push(`</${list.tag}>`);
    return html.join('');
  }).join('');
}

export { esc };
