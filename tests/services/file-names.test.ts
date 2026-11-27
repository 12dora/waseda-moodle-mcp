import { describe, expect, it } from 'vitest';
import { nameFromHeaders } from '../../src/core/services/file-http';

/** What fetch exposes for a header whose value holds raw UTF-8 bytes: one character per byte. */
const asHeaderBytes = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));

describe('nameFromHeaders', () => {
  it('decodes a raw UTF-8 quoted filename (the web session download)', () => {
    const headers = new Headers({
      'content-disposition': `attachment; filename="${asHeaderBytes('課題案内（学生用）.pdf')}"`,
    });
    expect(nameFromHeaders(headers, '/pluginfile.php/1/x/y/z.pdf')).toBe('課題案内（学生用）.pdf');
  });
  it('prefers filename* and keeps plain ASCII and non-UTF-8 Latin-1 names as they are', () => {
    const star = new Headers({ 'content-disposition': "attachment; filename*=UTF-8''%E8%AA%B2%E9%A1%8C.pdf" });
    expect(nameFromHeaders(star, '/a/b.pdf')).toBe('課題.pdf');
    expect(nameFromHeaders(new Headers({ 'content-disposition': 'attachment; filename="report.pdf"' }), '/a')).toBe(
      'report.pdf',
    );
    const latin = new Headers({ 'content-disposition': `attachment; filename="caf${String.fromCharCode(0xe9)}.pdf"` });
    expect(nameFromHeaders(latin, '/a')).toBe('café.pdf');
  });
});
