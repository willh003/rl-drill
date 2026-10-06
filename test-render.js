#!/usr/bin/env node
// The card text renderer (webapp/render.js). KaTeX itself is not loaded here,
// so these tests cover what the renderer owns: escaping, structure, and that
// math is lifted out before emphasis and HTML escaping can touch it.

'use strict';

const { renderCard } = require('./webapp/render.js');

let failures = 0;
function eq(got, want, label) {
  if (got !== want) {
    failures++;
    console.error('FAIL: ' + label + '\n  got:  ' + JSON.stringify(got) +
                  '\n  want: ' + JSON.stringify(want));
  }
}

// Without KaTeX, math falls back to its source in <code>, HTML-escaped.
eq(renderCard('Show $a<b$.'),
   '<p>Show <code>$a&lt;b$</code>.</p>', 'inline math fallback, escaped');
eq(renderCard('$$x^2$$'), '<p><code>$$x^2$$</code></p>', 'display math fallback');

// With a KaTeX stand-in, math is replaced wholesale and never re-processed.
global.katex = { renderToString: (t, o) => '[' + (o.displayMode ? 'D' : 'I') + ':' + t + ']' };
eq(renderCard('a $x_*^*y$ b'), '<p>a [I:x_*^*y] b</p>', '* inside math is not emphasis');
eq(renderCard('$$\\sum_i a_i$$ and $b$'), '<p>[D:\\sum_i a_i] and [I:b]</p>',
   'display then inline');
eq(renderCard('$$\na\n$$'), '<p>[D:a]</p>', 'multi-line display math');
delete global.katex;

// Text
eq(renderCard('<script>alert(1)</script>'),
   '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', 'html is escaped');
eq(renderCard('a **bold** `c<d` *it*'),
   '<p>a <b>bold</b> <code>c&lt;d</code> <i>it</i></p>', 'inline markup');
eq(renderCard('2 * 3 * 4'), '<p>2 * 3 * 4</p>', 'spaced asterisks are not emphasis');
eq(renderCard('costs \\$5 and \\$6'), '<p>costs $5 and $6</p>', 'escaped dollars');
eq(renderCard(''), '', 'empty');
eq(renderCard(null), '', 'null');

// Structure
eq(renderCard('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>',
   'paragraphs and line breaks');
eq(renderCard('- a\n- **b**'), '<ul><li>a</li><li><b>b</b></li></ul>', 'bullets');
eq(renderCard('1. a\n2) b'), '<ol><li>a</li><li>b</li></ol>', 'numbered');
eq(renderCard('intro\n\n- a\n- b'), '<p>intro</p><ul><li>a</li><li>b</li></ul>',
   'paragraph then list');

console.log('test-render: ' + (failures ? 'FAILED, ' + failures + ' failure(s)'
                                        : 'all cases pass'));
process.exit(failures ? 1 : 0);
