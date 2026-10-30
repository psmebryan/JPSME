// Article text formatting: a small, safe set of marks an admin types in the
// article editor, turned into HTML for the public page.
//
//   # Heading             ## Smaller heading      ### Smallest heading
//   - item  or  * item    a bullet list
//   1. item               a numbered list
//   > quote               a highlighted note
//   ---                   a dividing line
//   **bold**  *italic*    [text](https://link)    a bare https:// link
//
// Everything is HTML-escaped FIRST, so nothing an admin types can become a
// tag or a script; only the marks above add markup, and links accept http(s)
// and mailto only. A plain-text article (every article written before this)
// renders as paragraphs with its line breaks, exactly as it read before.

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeHref(url) {
  const value = String(url || '').trim();
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
}

function anchor(href, text) {
  const external = /^https?:\/\//i.test(href);
  return `<a href="${href}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
}

// Inline marks on one already-escaped line.
function inline(escaped) {
  const links = [];
  const keep = (html) => { links.push(html); return `\u0000${links.length - 1}\u0000`; };
  let s = escaped;
  // [text](url): the url was escaped too, so &amp; is turned back for the check.
  s = s.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (m, text, url) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    return href ? keep(anchor(escapeHtml(href), text)) : m;
  });
  // Bare links.
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,;:!?)'"])/g, (m, lead, url) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    return href ? lead + keep(anchor(escapeHtml(href), url)) : m;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => links[Number(i)]);
}

function render(body) {
  const lines = String(body == null ? '' : body).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null; // { tag, items }
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(escapeHtml(i))}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map((l) => inline(escapeHtml(l))).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { flushAll(); return; }
    if ((m = line.match(/^(#{1,3})\s+(.+)$/))) {
      flushAll();
      const level = m[1].length + 1; // # -> h2, ## -> h3, ### -> h4
      out.push(`<h${level}>${inline(escapeHtml(m[2]))}</h${level}>`);
      return;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); return; }
    if ((m = line.match(/^\s*[-*•]\s+(.+)$/))) {
      flushParagraph(); flushQuote();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(m[1]);
      return;
    }
    if ((m = line.match(/^\s*\d{1,3}[.)]\s+(.+)$/))) {
      flushParagraph(); flushQuote();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(m[1]);
      return;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      flushParagraph(); flushList();
      quote.push(m[1]);
      return;
    }
    flushList(); flushQuote();
    paragraph.push(line);
  });
  flushAll();
  return out.join('\n');
}

// Plain text for cards and previews: the marks taken out, links reduced to
// their text, whitespace collapsed, cut at a word near `max`.
function excerpt(body, max = 180) {
  const text = String(body == null ? '' : body)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*(#{1,3}|[-*•]|\d{1,3}[.)]|>)\s+/gm, '')
    .replace(/^\s*(-{3,}|\*{3,})\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max).trim()}…`;
}

module.exports = { render, excerpt, escapeHtml, safeHref };
