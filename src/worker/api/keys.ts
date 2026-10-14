/** API keys and authorized OAuth apps. */

import { Hono } from 'hono';
import type { ApiKeyRow } from '../../core/context';
import { randomId, randomSecret, sha256Hex } from '../../core/crypto';
import { InvalidInput, NotFound } from '../../core/errors';
import { isoJst } from '../../core/time';
import type { AppEnv } from '../auth';
import { isScope } from '../env';
import { auditConsole, cleanLabel, readJson, reqString, scopesFrom, session, storeOf } from './shared';

const MAX_ACTIVE_API_KEYS = 20;
/** 40 base62 characters (~238 bits) as in the contract. */
const API_KEY_ENTROPY_BYTES = 29.75;

function keyInfo(k: ApiKeyRow) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    createdAt: isoJst(k.createdAt),
    lastUsedAt: k.lastUsedAt === null ? null : isoJst(k.lastUsedAt),
    revokedAt: k.revokedAt === null ? null : isoJst(k.revokedAt),
  };
}

export function keyRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/keys', session, async (c) => {
    const keys = await storeOf(c.env).listApiKeys(c.get('user').id);
    return c.json(keys.map(keyInfo));
  });

  app.post('/api/keys', session, async (c) => {
    const user = c.get('user');
    const store = storeOf(c.env);
    const body = await readJson(c);
    const name = cleanLabel(reqString(body.name, 'name', 200), 60);
    if (!name) throw new InvalidInput('name is required.');
    const scopes = scopesFrom(body.scopes, ['moodle:read']);
    if (scopes.length === 0) throw new InvalidInput('Choose at least one access level.');
    const active = (await store.listApiKeys(user.id)).filter((k) => k.revokedAt === null).length;
    if (active >= MAX_ACTIVE_API_KEYS) throw new InvalidInput('Too many active API keys. Revoke one first.');

    const secret = randomSecret('wmm_', API_KEY_ENTROPY_BYTES);
    const row: ApiKeyRow = {
      id: randomId('key', 9),
      userId: user.id,
      name,
      prefix: secret.slice(0, 8),
      keyHash: await sha256Hex(secret),
      scopes,
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await store.createApiKey(row);
    auditConsole(c, user, 'apikey:create', { name, scopes });
    return c.json({ key: keyInfo(row), secret });
  });

  app.delete('/api/keys/:id', session, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    if (!(await storeOf(c.env).revokeApiKey(user.id, id, Date.now()))) throw new NotFound('API key not found.');
    auditConsole(c, user, 'apikey:revoke', { id });
    return c.json({ ok: true });
  });

  app.get('/api/apps', session, async (c) => {
    const page = await c.env.OAUTH_PROVIDER.listUserGrants(String(c.get('user').id), { limit: 100 });
    return c.json(
      page.items.map((g) => {
        const meta = (g.metadata ?? {}) as { clientName?: unknown };
        return {
          id: g.id,
          clientId: g.clientId,
          clientName: typeof meta.clientName === 'string' && meta.clientName ? meta.clientName : g.clientId,
          scopes: g.scope.filter(isScope),
          createdAt: isoJst(g.createdAt * 1000),
        };
      }),
    );
  });

  app.delete('/api/apps/:grantId', session, async (c) => {
    const user = c.get('user');
    const grantId = c.req.param('grantId');
    await c.env.OAUTH_PROVIDER.revokeGrant(grantId, String(user.id));
    auditConsole(c, user, 'app:revoke', { id: grantId });
    return c.json({ ok: true });
  });

  return app;
}
