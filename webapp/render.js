// Card text -> HTML, shared by the phone app and the Mac window (which shows
// webapp/card.html in a WKWebView). One renderer, so a card looks the same
// everywhere.
//
// The format is deliberately small. Cards are written by hand, in JSON, so
// anything fancier than this is a tax on writing them:
//
//   $x^2$            inline math (KaTeX)
//   $$ ... $$        display math
//   **bold**  *italic*  `code`
//   - item           bullet list (consecutive lines starting "- ")
//   1. item          numbered list
//   blank line       paragraph break; a single newline is a line break
//   \$               a literal dollar sign
//
// Math is pulled out before anything else is touched, so `*` and `_` inside a
// formula are never mistaken for emphasis. Without KaTeX loaded (tests, or a
// failed asset) math falls back to its source text, still readable.
'use strict';

(function (root) {
  const OPEN = '', CLOSE = '', DOLLAR = '';

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function math(tex, display) {
    const k = root.katex;
    if (k && k.renderToString) {
      try {
        return k.renderToString(tex, { displayMode: display, throwOnError: false,
                                       strict: 'ignore' });
      } catch (e) { /* fall through to the source text */ }
    }
    return '<code>' + esc(display ? '$$' + tex + '$$' : '$' + tex + '$') + '</code>';
  }

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<i>$2</i>');
  }

  function renderCard(text) {
    const maths = [];
    let t = String(text == null ? '' : text).replace(/\\\$/g, DOLLAR);
    t = t.replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (m, d, i) => {
      maths.push(d !== undefined ? math(d.trim(), true) : math(i.trim(), false));
      return OPEN + (maths.length - 1) + CLOSE;
    });

    const out = [];
    for (const block of esc(t).split(/\n{2,}/)) {
      const lines = block.split('\n');
      const isList = re => lines.every(l => re.test(l));
      if (isList(/^\s*[-•]\s+/)) {
        out.push('<ul>' + lines.map(l =>
          '<li>' + inline(l.replace(/^\s*[-•]\s+/, '')) + '</li>').join('') + '</ul>');
      } else if (isList(/^\s*\d+[.)]\s+/)) {
        out.push('<ol>' + lines.map(l =>
          '<li>' + inline(l.replace(/^\s*\d+[.)]\s+/, '')) + '</li>').join('') + '</ol>');
      } else if (block.trim()) {
        out.push('<p>' + lines.map(inline).join('<br>') + '</p>');
      }
    }

    return out.join('')
      .replace(new RegExp(OPEN + '(\\d+)' + CLOSE, 'g'), (m, n) => maths[+n])
      .replace(new RegExp(DOLLAR, 'g'), '$');
  }

  root.renderCard = renderCard;
  if (typeof module !== 'undefined') module.exports = { renderCard };
})(typeof window !== 'undefined' ? window : globalThis);
