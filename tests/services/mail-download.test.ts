import { describe, expect, it } from 'vitest';
import { MailUnavailable } from '../../src/core/errors';
import { bytesOfBase64Url } from '../../src/core/mail/gmail';
import { type FileRouteEnv, streamDownload } from '../../src/core/services/file-http';
import { b64urlUtf8 } from '../fixtures/mail/builder';
import { makeFakeContext } from '../helpers/fake-context';
import { makeFakeMail } from '../helpers/fake-mail';

const MSG = 'aa000004';
const ATT = 'ANGjd-attach-1';
const BYTES = 'hello-pdf';
const get = (init: RequestInit = {}) => new Request('https://wasemoodle.example.com/f/x', init);

function envOf(mail?: ReturnType<typeof makeFakeMail>, withMail = true): FileRouteEnv {
  const fake = makeFakeContext(mail ? { mail } : {});
  return {
    store: fake.store,
    signer: fake.ctx.signer,
    makeMoodle: async () => {
      throw new Error('moodle unused');
    },
    makeMail: withMail
      ? async () => {
          if (!mail) throw new Error('no mail');
          return mail;
        }
      : undefined,
  };
}

async function ticket(env: FileRouteEnv, patch: Record<string, unknown> = {}) {
  return env.signer.sign(
    { k: 'ml', u: 1, m: MSG, a: ATT, n: '講義資料.pdf', t: 'application/pdf', s: BYTES.length, ...patch },
    900,
  );
}

describe('streamDownload mail tickets', () => {
  it('returns decoded bytes and attachment headers for k=ml', async () => {
    const mail = makeFakeMail({
      answers: { [`GET messages/${MSG}/attachments/${ATT}`]: { size: BYTES.length, data: b64urlUtf8(BYTES) } },
    });
    const env = envOf(mail);
    const res = await streamDownload(env, await ticket(env), get());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BYTES);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-length')).toBe(String(BYTES.length));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(mail.calls[0]).toMatchObject({ method: 'GET', path: `messages/${MSG}/attachments/${ATT}` });
  });

  it('answers HEAD from the ticket size without calling Gmail', async () => {
    const mail = makeFakeMail({
      answers: { [`GET messages/${MSG}/attachments/${ATT}`]: { size: 99, data: b64urlUtf8(BYTES) } },
    });
    const env = envOf(mail);
    const res = await streamDownload(env, await ticket(env, { s: 42 }), get({ method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-length')).toBe('42');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mail.calls).toHaveLength(0);
  });

  it('reads attachment JSON via indexOf, including whitespace after the colon', async () => {
    const json = `{ "size": ${BYTES.length}, "data": "${b64urlUtf8(BYTES)}" }`;
    const mail = makeFakeMail({ answers: { [`GET messages/${MSG}/attachments/${ATT}`]: json } });
    const env = envOf(mail);
    const res = await streamDownload(env, await ticket(env), get());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BYTES);
  });

  it('serves html/svg/xml/javascript and unknown active types as application/octet-stream', async () => {
    const mail = makeFakeMail({
      answers: { [`GET messages/${MSG}/attachments/${ATT}`]: { size: BYTES.length, data: b64urlUtf8(BYTES) } },
    });
    const env = envOf(mail);
    const active = [
      'text/html',
      'image/svg+xml',
      'application/xml',
      'application/javascript',
      'text/xml',
      'application/ecmascript',
      'text/vnd.example',
      'application/x-msdownload',
    ];
    for (const t of active) {
      const res = await streamDownload(env, await ticket(env, { t }), get());
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
    }
  });

  it('serves passive types as-is (pdf, raster images, plain/csv, openxml, zip, audio, video)', async () => {
    const mail = makeFakeMail({
      answers: { [`GET messages/${MSG}/attachments/${ATT}`]: { size: BYTES.length, data: b64urlUtf8(BYTES) } },
    });
    const env = envOf(mail);
    const passive = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/heic',
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'audio/mpeg',
      'video/mp4',
    ];
    for (const t of passive) {
      const res = await streamDownload(env, await ticket(env, { t }), get());
      expect(res.headers.get('content-type')).toBe(t);
    }
  });

  it('maps a missing or non-string attachment data field to 502, not an empty file', async () => {
    const envOfBody = (body: object | string) => {
      const mail = makeFakeMail({ answers: { [`GET messages/${MSG}/attachments/${ATT}`]: body } });
      return envOf(mail);
    };
    for (const body of ['{"size":1}', '{"data":null}', '{"data": 1}', '{"data": "abc']) {
      const env = envOfBody(body);
      const res = await streamDownload(env, await ticket(env), get());
      expect(res.status).toBe(502);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'mail_unavailable' } });
    }
  });

  it('returns 404 when makeMail is absent', async () => {
    const mail = makeFakeMail({
      answers: { [`GET messages/${MSG}/attachments/${ATT}`]: { size: 1, data: b64urlUtf8('x') } },
    });
    const env = envOf(mail, false);
    const res = await streamDownload(env, await ticket(env), get());
    expect(res.status).toBe(404);
    expect(mail.calls).toHaveLength(0);
  });

  it('maps MailUnavailable to 502', async () => {
    const mail = makeFakeMail({
      answers: {
        [`GET messages/${MSG}/attachments/${ATT}`]: () => {
          throw new MailUnavailable();
        },
      },
    });
    const env = envOf(mail);
    const res = await streamDownload(env, await ticket(env), get());
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'mail_unavailable' } });
  });
});

describe('bytesOfBase64Url', () => {
  it('decodes with and without native Uint8Array.fromBase64', () => {
    const holder = Uint8Array as unknown as { fromBase64?: unknown };
    const original = holder.fromBase64;
    const encoded = b64urlUtf8('hello-pdf');
    const decode = () => new TextDecoder().decode(bytesOfBase64Url(encoded));
    try {
      expect(decode()).toBe('hello-pdf');
      holder.fromBase64 = undefined;
      expect(decode()).toBe('hello-pdf');
    } finally {
      holder.fromBase64 = original;
    }
  });
});
