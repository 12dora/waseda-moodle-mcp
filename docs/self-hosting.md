# Self-hosting on Cloudflare Workers

The hosted variant is a single Cloudflare Worker that serves the MCP endpoint, the OAuth
endpoints, the console API and the console SPA (static assets). State lives in D1; KV is used
only by the OAuth library. Everything fits the Workers Free plan for a small group of users.

## Prerequisites

- A Cloudflare account (Free plan is enough) and a domain on Cloudflare if you want a custom domain.
- Node.js 20+ and pnpm.
- `pnpm install` in the repository root (installs `wrangler` locally; run it via `pnpm exec wrangler` or `npx wrangler`).
- `wrangler login`.

## 1. Create D1 and KV

```sh
wrangler d1 create waseda-moodle-mcp          # note the database_id
wrangler kv namespace create OAUTH_KV          # note the id
```

KV holds only OAuth clients, grants and tokens (managed by
`@cloudflare/workers-oauth-provider`) and one purge cursor key. Application rate limits and
all other data live in D1, because KV Free allows only 1,000 writes per day.

## 2. Local config: `wrangler.local.jsonc`

`wrangler.jsonc` is committed with placeholders (`REPLACE_WITH_D1_ID`, `REPLACE_WITH_KV_ID`,
`https://wasemoodle.example.com`). Keep your real values in a gitignored copy:

```sh
cp wrangler.jsonc wrangler.local.jsonc
```

Edit `wrangler.local.jsonc`:

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "waseda-moodle-mcp",
                   "database_id": "<your-d1-id>", "migrations_dir": "./migrations" }],
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<your-kv-id>" }],
"vars": {
  "PUBLIC_URL": "https://wasemoodle.example.com",
  "REGISTRATION": "allowlist",
  "ALLOWED_MOODLE_USERIDS": "1001, 1002",
  "SYLLABUS_LOOKUP": "on"
},
"routes": [{ "pattern": "wasemoodle.example.com", "custom_domain": true }],
"workers_dev": false
```

`wrangler.local.jsonc` is listed in `.gitignore`. Never commit real ids or domains.

## 3. Variables and secrets

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `PUBLIC_URL` | var | `https://wasemoodle.example.com` | Public origin, no trailing slash. Used for the MCP resource URL (`/mcp`), OAuth redirects, signed file links and the bookmarklet. Must match the domain you serve from. |
| `REGISTRATION` | var | `allowlist` | `open`: anyone with a valid Waseda Moodle token can sign up. Any other value: allowlist. |
| `ALLOWED_MOODLE_USERIDS` | var | `""` | Moodle numeric user ids allowed to create an account in allowlist mode; separated by commas, spaces or semicolons. Existing users can always reconnect. |
| `SYLLABUS_LOOKUP` | var | `on` | `off` disables fetching the public Waseda syllabus (the timetable then has no slots). |
| `EXTENSION_URL` | var (optional) | unset | Install URL for the browser extension shown in the console. Unset hides the link. |
| `VITE_CONTACT_URL` | console build env (optional) | unset | `https://` or `mailto:` link shown as the contact on the privacy page. Read when the console is built (`web/.env.local` or the build environment), not by the Worker. Unset shows "Contact the operator of this instance." |
| `MASTER_KEY` | secret | required | 32 random bytes, base64. Encrypts Moodle tokens and short-lived handoff/OAuth blobs, and keys the HMAC for file links. Changing it makes stored tokens unreadable (users must reconnect). |

Set the secret:

```sh
openssl rand -base64 32 | wrangler secret put MASTER_KEY --config wrangler.local.jsonc
```

For `wrangler dev`, put `MASTER_KEY=...` in a gitignored `.dev.vars` file.

A user's Moodle id is shown in Moodle under the profile URL (`user/profile.php?id=<id>`).

## 4. Apply migrations

```sh
wrangler d1 migrations apply waseda-moodle-mcp --remote --config wrangler.local.jsonc
wrangler d1 migrations apply waseda-moodle-mcp --local  --config wrangler.local.jsonc   # for wrangler dev
```

Migrations `0001`-`0004` create users, credentials, sessions, API keys, actions, upload
drafts, audit, handoffs, OAuth requests, rate limits, course snapshots and the syllabus cache.

## 5. Build and deploy

```sh
pnpm --filter waseda-moodle-mcp-web run build
wrangler deploy --config wrangler.local.jsonc
```

Note: `pnpm deploy` runs the same build but calls `wrangler deploy` without `--config`, so it
would deploy the committed placeholders. Use the two commands above.

## 6. Custom domain

Either declare the route in `wrangler.local.jsonc` (as above, `custom_domain: true`) or add it
in the dashboard under Workers -> your Worker -> Settings -> Domains & Routes. `PUBLIC_URL` must
equal this origin exactly, otherwise OAuth discovery and file links break. Check with
`curl https://wasemoodle.example.com/health` (returns `{"ok":true}`).

## 7. Cron

Schedule: `17 0-14,22-23 * * *` (UTC), i.e. hourly at :17 from 07:17 to 23:17 JST, with no runs
overnight.

Each run performs a course sweep: up to 20 users with an active credential (never-swept users
first, then least recently swept), at most 2 course refreshes per user and at most 44 Moodle
calls per invocation. It stores compact course snapshots used by `get_due_items` and
`get_course_updates`. The 03:17 UTC run additionally purges expired data in D1 (see
[privacy.md](privacy.md)) and expired OAuth data in KV in small batches.

## 8. Registration modes

- **Allowlist** (default): only the listed Moodle user ids can create an account. Use this for a private instance.
- **Open**: any Waseda Moodle user can sign up. Consider the Free-tier limits below before opening.

Users of any instance must hold a valid token for `wsdmoodle.waseda.jp`; other Moodle sites
are rejected.

## 9. Free-tier limits that matter

| Limit (Free) | Value | How the code stays within it |
|---|---|---|
| Worker requests | 100,000 / day | Static console assets are served without invoking the Worker; per-user MCP limit 120 calls / 60 s |
| CPU per invocation | 10 ms | Moodle calls are I/O; responses are rendered as compact markdown |
| Subrequests per invocation | 50 | Moodle client capped at 40 calls per request; cron at 44 |
| D1 | 5M reads, 100k writes / day, 500 MB | Rate-limit counters skip writes when already over limit; snapshots and logs are purged on schedule |
| KV | 100k reads, 1k writes / day | KV used only for OAuth; access tokens last 12 h to reduce refresh writes |
| Cron triggers | 5 | One trigger used |

Built-in per-IP limits: `/authorize` 60 / 10 min, `/register` 20 / h, `/api/connect` 60 / 10 min,
handoff 60 / h, extension refresh 300 / h per IP and 6 / h per token. If the rate-limit store
fails, requests are allowed (fail open).

Monitor your Cloudflare usage in the dashboard (Workers & Pages -> Metrics, D1 and KV
analytics), especially in open registration mode.

## 10. Optional edge rate-limit rule

As an extra safeguard you can add a Cloudflare WAF rate-limiting rule for your domain, for
example on paths `/mcp`, `/api/`, `/authorize`, `/register`, `/token`, `/f/` and `/u/`.
Leave the console paths unblocked: when an API request is blocked at the edge (HTTP 403), the
console shows a "Service paused" screen instead of failing silently. This rule is operator
configuration and is not required.

## 11. Browser extension

The MV3 extension in `extension/` needs no build. Load it unpacked
(`chrome://extensions` -> Developer mode -> Load unpacked -> `extension/`) and set your
`PUBLIC_URL` as the service URL in its options. To point users at a store listing, set
`EXTENSION_URL`.

## 12. Updating

```sh
git pull
pnpm install
wrangler d1 migrations apply waseda-moodle-mcp --remote --config wrangler.local.jsonc
pnpm --filter waseda-moodle-mcp-web run build
wrangler deploy --config wrangler.local.jsonc
```

Compare `wrangler.jsonc` with your `wrangler.local.jsonc` after pulling and copy over any new
keys (bindings, flags, cron) while keeping your own ids and vars.
