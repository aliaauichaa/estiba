// Markdown mínimo para las respuestas del asistente: párrafos, listas y negritas. Escapa todo lo demás.

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

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
