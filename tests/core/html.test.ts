import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToMarkdown } from '../../src/core/html';

describe('decodeEntities', () => {
  it('decodes named and numeric entities once', () => {
    expect(decodeEntities('A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41; &hellip; &mdash;')).toBe(
      `A & B <c> "d" 'e' A … —`,
    );
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('Corporate Finance &amp; Valuation')).toBe('Corporate Finance & Valuation');
  });
  it('keeps unknown entities and survives bad numbers', () => {
    expect(decodeEntities('&bogus; &#0; &#xD800; &#9999999;')).toBe('&bogus;   ');
    expect(decodeEntities('plain')).toBe('plain');
    expect(decodeEntities('')).toBe('');
  });
  it('ignores prototype keys', () => {
    expect(decodeEntities('&toString; &constructor; &__proto__;')).toBe('&toString; &constructor; &__proto__;');
  });
  it('turns nbsp into a space', () => {
    expect(decodeEntities('a&nbsp;b&#160;c')).toBe('a b c');
  });
});

describe('htmlToMarkdown', () => {
  it('handles empty input', () => {
    expect(htmlToMarkdown(null)).toBe('');
    expect(htmlToMarkdown(undefined)).toBe('');
    expect(htmlToMarkdown('')).toBe('');
  });

  it('converts paragraphs, line breaks and collapses whitespace', () => {
    expect(htmlToMarkdown('<p>Hello\n   world</p><p>Second<br>line</p>')).toBe('Hello world\n\nSecond\nline');
    expect(htmlToMarkdown('<div>one</div><div>two</div>')).toBe('one\ntwo');
    expect(htmlToMarkdown('<p>a</p><p></p><p>&nbsp;</p><p>b</p>')).toBe('a\n\nb');
  });

  it('converts headings', () => {
    expect(htmlToMarkdown('<h2>Title</h2><p>text</p>')).toBe('## Title\n\ntext');
  });

  it('converts lists, including nested and ordered', () => {
    expect(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
    expect(htmlToMarkdown('<ol><li>first</li><li>second</li></ol>')).toBe('1. first\n2. second');
    expect(htmlToMarkdown('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>')).toBe('- a\n  - b\n- c');
  });

  it('converts links and images', () => {
    expect(htmlToMarkdown('<p>See <a href="https://example.com/a?x=1&amp;y=2">the page</a> now.</p>')).toBe(
      'See [the page](https://example.com/a?x=1&y=2) now.',
    );
    expect(htmlToMarkdown('<a name="top"></a>text <a href="#top">jump</a>')).toBe('text jump');
    expect(htmlToMarkdown('<a href="javascript:alert(1)">x</a>')).toBe('x');
    expect(htmlToMarkdown('<img alt="Diagram" src="https://example.com/d.png">')).toBe(
      '![Diagram](https://example.com/d.png)',
    );
    expect(htmlToMarkdown('<p>a<img alt="x" src="data:image/png;base64,AAAA">b</p>')).toBe('ab');
  });

  it('strips script/style/comments but keeps surrounding text', () => {
    expect(
      htmlToMarkdown(
        '<style>p{color:red}</style><p>a</p><SCRIPT type="x">var a="</p>";</SCRIPT><!-- hidden --><p>b</p>',
      ),
    ).toBe('a\n\nb');
    expect(htmlToMarkdown('x<!-- never closed <p>y</p>')).toBe('x');
  });

  it('formats preformatted blocks and inline code', () => {
    expect(htmlToMarkdown('<p>run <code>npm test</code> now</p>')).toBe('run `npm test` now');
    expect(htmlToMarkdown('<pre>a  b\n  c</pre>')).toBe('```\na  b\n  c\n```');
  });

  it('flattens simple tables', () => {
    expect(htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')).toBe(
      'A | B\n1 | 2',
    );
  });

  it('decodes entities in text and leaves stray angle brackets alone', () => {
    expect(htmlToMarkdown('<p>Q&amp;A: 1 &lt; 2 and 3 < 4</p>')).toBe('Q&A: 1 < 2 and 3 < 4');
    expect(htmlToMarkdown('日本語のテキスト<br/>二行目')).toBe('日本語のテキスト\n二行目');
  });

  it('truncates with an ellipsis', () => {
    const out = htmlToMarkdown(`<p>${'word '.repeat(100)}</p>`, { maxChars: 20 });
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
    expect(htmlToMarkdown('<p>short</p>', { maxChars: 20 })).toBe('short');
  });

  it('stays linear on large and hostile input', () => {
    const big = '<div><p>row <a href="https://example.com/x">link</a> &amp; text</p></div>'.repeat(20000);
    const t0 = Date.now();
    expect(htmlToMarkdown(big).length).toBeGreaterThan(100000);
    expect(htmlToMarkdown('<'.repeat(200000)).length).toBe(200000);
    expect(htmlToMarkdown('<a '.repeat(100000)).length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('does not backtrack on an unterminated tag name (50k chars)', () => {
    const t0 = performance.now();
    expect(htmlToMarkdown(`<a${'b'.repeat(50_000)}`).length).toBe(50_002);
    expect(htmlToMarkdown(`<${'a'.repeat(50_000)} ${'x'.repeat(50_000)}`).length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
