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
- Calendar feed: a secret ICS subscription URL (console **Settings**) for deadlines and the timetable in Google Calendar, Apple Calendar or Outlook.

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

MCP URL: `https://wasemoodle.example.com/mcp` (Streamable HTTP). OAuth is the default: the client
discovers the authorization server from the `401` response (RFC 9728), registers itself and opens
the consent page, where you grant read-only or read+write access. API keys (`wmm_…`, created on the
console **API keys** page) are for clients that can send an `Authorization: Bearer <API_KEY>` header.
The console **Overview** page shows the same steps with your instance URL filled in.

| Client | Setup |
|---|---|
| Claude (web, Desktop; usable on mobile once added) | Customize → Connectors → Add custom connector → URL → Connect. Free plan: 1 custom connector; Team/Enterprise: an Owner adds it in Organization settings → Connectors. |
| ChatGPT | Plugins → + → Add custom MCP server → URL, Authentication OAuth → Create. Available on Plus, Pro, Business, Enterprise and Edu. |
| Grok | grok.com/connectors → New Connector → Custom → URL. Business/Enterprise: admin adds it first at console.x.ai. |
| Claude Code | `claude mcp add --transport http waseda-moodle https://wasemoodle.example.com/mcp`, then `/mcp` → Authenticate |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers": {"waseda-moodle": {"url": "https://wasemoodle.example.com/mcp"}}}` |
| VS Code (Copilot) | `.vscode/mcp.json`: `{"servers": {"waseda-moodle": {"type": "http", "url": "https://wasemoodle.example.com/mcp"}}}` |
| Codex CLI | `codex mcp add waseda-moodle --url https://wasemoodle.example.com/mcp`, then `codex mcp login waseda-moodle` |
| Gemini CLI | `gemini mcp add --transport http waseda-moodle https://wasemoodle.example.com/mcp`, then `/mcp auth waseda-moodle` (free and Google One users now use Antigravity CLI) |
| Grok CLI | `grok mcp add --transport http waseda-moodle https://wasemoodle.example.com/mcp` |
| Other (LobeHub, Cherry Studio, …) | Streamable HTTP + URL; OAuth if supported, otherwise the API-key header |

**With an API key** instead of OAuth. Keep the key out of project files: CLIs store it in your
user config, and Codex and Cursor read it from `WMM_API_KEY` (set it in your shell profile, e.g.
`export WMM_API_KEY='<API_KEY>'` in `~/.zshrc`).

```sh
# Claude Code / Grok CLI (instead of the OAuth command; `claude mcp remove waseda-moodle` first if already added)
claude mcp add --transport http waseda-moodle https://wasemoodle.example.com/mcp \
  --header "Authorization: Bearer <API_KEY>"
grok mcp add --transport http waseda-moodle https://wasemoodle.example.com/mcp \
  --header "Authorization: Bearer <API_KEY>"
# Codex
codex mcp add waseda-moodle --url https://wasemoodle.example.com/mcp --bearer-token-env-var WMM_API_KEY
```

Cursor (`~/.cursor/mcp.json`): add `"headers": { "Authorization": "Bearer ${env:WMM_API_KEY}" }` to the
server entry. VS Code (`.vscode/mcp.json`): let VS Code prompt for the key and store it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "wmm-api-key", "description": "Waseda Moodle MCP API key", "password": true }
  ],
  "servers": {
    "waseda-moodle": {
      "type": "http",
      "url": "https://wasemoodle.example.com/mcp",
      "headers": { "Authorization": "Bearer ${input:wmm-api-key}" }
    }
  }
}
```

Gemini CLI (`~/.gemini/settings.json`, use `httpUrl`): add
`"headers": { "Authorization": "Bearer <API_KEY>" }` to the server entry. ChatGPT and Claude
(web) use OAuth only.

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
| `get_due_items` | Outstanding deadlines grouped by day, with your submission state (draft, in progress, submitted) and sweep results | read |
| `list_courses` | Enrolled courses (`scope`: `mine` or `all`) | read |
| `get_course` | Sections and activities of one course | read |
| `search_course_content` | Search activity, section and file names | read |
| `get_activity` | Full details of one activity | read |
| `get_grades` | Grades for a course | read |
| `set_my_courses` | Save this term's courses (server-side filter; does not change Moodle) | read scope |
| `get_course_updates` | Recent teacher changes | read |
| `get_timetable` | Classes per day with room and campus | read |
| `set_course_schedule` | Set or clear a course's class time (server-side; does not change Moodle) | read scope |
| `get_syllabus` | Public syllabus: plan, grading weights, textbooks | read |
| `get_quiz_review` | Review a finished quiz attempt (questions, marks, right answers) | read |
| `get_file` | Fetch a Moodle file (signed URL, temp file, or inline up to 1 MiB) | read |
| `list_discussions` | Forum threads (default: announcements) | read |
| `get_discussion` | Posts of one discussion | read |
| `list_messages` | Moodle conversations | read |
| `get_conversation` | Messages of one conversation | read |
| `list_notifications` | Notifications and unread count | read |
| `search_forums` | Keyword search over forum discussions (optionally messages) | read |
| `search_people` | Find teachers and classmates seen in your course forums or conversations | read |
| `create_upload_link` | Short-lived upload URL for large files (hosted only) | write |
| `prepare_submission` | Preview an assignment submission | write |
| `prepare_forum_post` | Preview a forum post or reply | write |
| `prepare_message` | Preview a Moodle message | write |
| `prepare_completion` | Preview marking an activity done / not done | write |
| `prepare_forum_subscription` | Preview subscribing to / unsubscribing from a forum | write |
| `prepare_mark_read` | Preview marking notifications or a conversation as read | write |
| `confirm_action` | Execute a prepared action | write |
| `cancel_action` | Discard a prepared action | write |

Prompts: `daily_briefing` (optional date), `weekly_plan`, `exam_prep` (course). Resources: `moodle://course/{course_id}`
and `moodle://syllabus/{course_id}`. Prepared actions expire after 30 minutes. Times
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
