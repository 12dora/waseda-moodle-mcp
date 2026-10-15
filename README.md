# Waseda Moodle MCP

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants read and act on
**Waseda University's Moodle** (`https://wsdmoodle.waseda.jp`). It is Waseda-only by design:
the Moodle origin, the login flow and several features (syllabus-based timetable, deadline
sweep) are specific to that site.

It runs either as a hosted service on Cloudflare Workers (with a web console) or as a local
stdio process.

## Features

**Deadlines and course sweep**
- Outstanding deadlines grouped Overdue / Today / Tomorrow / Next 7 days / Later, from the Moodle calendar plus a background sweep that finds undated activities and deadlines written in course text (marked "verify").
- Recent teacher additions and changes in your courses.

**Timetable**
- Per-day classes with times, room and campus, built from the public Waseda syllabus and the academic calendar. On-demand and unknown slots listed separately.

**Courses, content and grades**
- Enrolled courses (this term by default), a confirmed "my courses" filter, course sections and activities, activity details, name search across courses, grades per course.

**Forums, messages and notifications**
- Forum threads and posts, Moodle conversations, notifications with unread counts.

**Files**
- Download any Moodle file through a short-lived signed URL (hosted) or a temp file (stdio); small files can be attached inline.

**Writes with preview, then confirm**
- Assignment submission (text and files), forum posts and replies, Moodle messages, manual completion.
- Every write is two steps: `prepare_*` returns a preview, and nothing reaches Moodle until `confirm_action` runs after you agree. Writes can also be restricted to approval in the web console, or turned off.

## How it works

The server talks to Moodle's web services using the same token the official Moodle mobile app
uses. That token is obtained from Moodle's mobile-app launch flow while you are signed in to
Moodle in your browser; your password is never requested or seen.

```
AI client  <-- MCP (HTTP or stdio) -->  MCP server (Worker / Node)  <-- REST -->  Moodle web services
                                              |
                                        D1 / KV (hosted)
```

## Quick start (hosted instance)

1. Open the console (for example `https://wasemoodle.example.com`) and connect Moodle on the
   **Connect** page using the bookmarklet, the browser extension, or by pasting the launch link.
2. Optionally confirm this term's courses on **My courses**.
3. Add the server to your AI client (see below). The MCP URL is `https://wasemoodle.example.com/mcp`.

## Clients

| Client | Auth | Setup |
|---|---|---|
| claude.ai | OAuth | Settings -> Connectors -> Add custom connector -> URL `https://wasemoodle.example.com/mcp` |
| Claude Code (OAuth) | OAuth | `claude mcp add --transport http waseda-moodle https://wasemoodle.example.com/mcp` |
| Claude Code (API key) | API key | see below |
| Other Streamable HTTP clients (e.g. LobeHub) | OAuth or API key | URL + optional `Authorization` header |
| Local stdio | Moodle token on disk | see below |

**Claude Code with an API key** (create the key on the console **API keys** page):

```sh
claude mcp add --transport http waseda-moodle https://wasemoodle.example.com/mcp \
  --header "Authorization: Bearer <API_KEY>"
```

With OAuth, the client discovers the authorization server from the `401` response
(RFC 9728), registers itself and opens the consent page, where you can grant read-only or
read+write access.

**Generic Streamable HTTP clients** (LobeHub and others): transport Streamable HTTP, URL
`https://wasemoodle.example.com/mcp`. Clients that support MCP OAuth need only the URL;
otherwise add the header `Authorization: Bearer <API_KEY>`. API keys start with `wmm_`
and can be read-only or read+write.

**Local stdio** (Node 20+):

```sh
pnpm install
pnpm build:stdio                                  # produces dist/stdio.js
node dist/stdio.js connect -                      # paste the launch link on stdin
```

Client configuration (JSON form used by most clients):

```json
{
  "mcpServers": {
    "waseda-moodle": {
      "command": "node",
      "args": ["/path/to/waseda-moodle-mcp/dist/stdio.js"]
    }
  }
}
```

Or with Claude Code: `claude mcp add waseda-moodle -- node /path/to/dist/stdio.js --read-only`.

| Option | Meaning |
|---|---|
| `--read-only` / `WMM_READ_ONLY=1` | Register read tools only |
| `WMM_TOKEN` | Token or launch link; overrides the token file |
| `WMM_CONFIG_DIR` | Config directory (default `~/.config/waseda-moodle-mcp`; token file mode 0600) |
| `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | Outbound proxy settings |

Stdio stores the token in plain text (file mode 0600) and does not support console approval
of writes or `create_upload_link`.

## Tools

| Tool | Purpose | Access |
|---|---|---|
| `get_due_items` | Outstanding deadlines grouped by day, with sweep results | read |
| `list_courses` | Enrolled courses (`scope`: `mine` or `all`) | read |
| `get_course` | Sections and activities of one course | read |
| `search_course_content` | Search activity, section and file names | read |
| `get_activity` | Full details of one activity | read |
| `get_grades` | Grades for a course | read |
| `set_my_courses` | Save this term's courses (server-side filter; does not change Moodle) | read scope |
| `get_course_updates` | Recent teacher changes | read |
| `get_timetable` | Classes per day with room and campus | read |
| `get_file` | Fetch a Moodle file (signed URL, temp file, or inline up to 1 MiB) | read |
| `list_discussions` | Forum threads (default: announcements) | read |
| `get_discussion` | Posts of one discussion | read |
| `list_messages` | Moodle conversations | read |
| `get_conversation` | Messages of one conversation | read |
| `list_notifications` | Notifications and unread count | read |
| `create_upload_link` | Short-lived upload URL for large files (hosted only) | write |
| `prepare_submission` | Preview an assignment submission | write |
| `prepare_forum_post` | Preview a forum post or reply | write |
| `prepare_message` | Preview a Moodle message | write |
| `prepare_completion` | Preview marking an activity done / not done | write |
| `confirm_action` | Execute a prepared action | write |
| `cancel_action` | Discard a prepared action | write |

Prompts: `daily_briefing` and `weekly_plan`. Prepared actions expire after 30 minutes. Times
are shown in JST. The server never takes quizzes.

## Security and privacy

- No Moodle password is ever requested. The Moodle token is encrypted at rest (AES-256-GCM with the operator's `MASTER_KEY`).
- File contents are streamed, not stored. Download and upload links are HMAC-signed and expire in 15 and 30 minutes.
- API keys are stored as hashes. OAuth access tokens last 12 hours, refresh tokens 90 days.
- Deleting your account in the console removes all of your data on the server.

Details: [docs/privacy.md](docs/privacy.md).

## Self-hosting

The hosted variant fits the Cloudflare Workers Free plan (Worker + D1 + KV + static assets).
See [docs/self-hosting.md](docs/self-hosting.md).

## Development

| Command | Purpose |
|---|---|
| `pnpm dev` | `wrangler dev` (console via `pnpm --filter waseda-moodle-mcp-web dev`) |
| `pnpm test` | Vitest (core, worker, node, extension) |
| `pnpm --filter waseda-moodle-mcp-web test` | Console tests |
| `pnpm typecheck` | TypeScript, root and `web/` |
| `pnpm lint` / `pnpm lint:fix` | Biome |
| `pnpm dup` / `pnpm dead` | jscpd duplication / knip dead code |
| `pnpm quality` | lint + dup + dead + typecheck (tests run separately) |
| `pnpm build:stdio` | Bundle the stdio server |

Layout: `src/core` (runtime-agnostic services, Moodle client, MCP tools), `src/worker`
(Cloudflare entry, OAuth, API, D1 store, cron), `src/node` (stdio CLI), `web` (React console),
`extension` (MV3 connector, no build step), `migrations` (D1 SQL), `tests`.

## License

MIT.

## Disclaimer

This is an unofficial project and is not affiliated with or endorsed by Waseda University.
The Moodle token it uses is the same token the official Moodle mobile app uses (one per
user). This server never revokes or resets it; if Moodle rejects it, the server simply asks
you to reconnect.
