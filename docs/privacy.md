# Privacy

Effective date: 2026-10-15

This document describes how Waseda Moodle MCP (the hosted service and the "Waseda Moodle MCP
Connector" browser extension) handles your data. It applies to any instance run from this
repository; the operator of an instance is the party responsible for it.

Waseda Moodle MCP is unofficial and not affiliated with Waseda University.

## Summary

- We never ask for or see your Moodle password.
- Your Moodle token is stored encrypted and is used only to act on Moodle at your request (and for a background deadline sweep).
- File contents are passed through, never stored.
- Your data is not sold, shared, used for advertising, or used to train AI models.
- You can delete everything from the console at any time.

## What is collected

| Data | Why | Notes |
|---|---|---|
| Moodle web-service token (and the optional private token) | To call Moodle on your behalf | Encrypted with AES-256-GCM using the instance's `MASTER_KEY`. A hash and the last 4 characters are kept to recognise the token and display it as `••••abcd`. |
| Moodle user id, full name, language | To identify your account | Read from Moodle when you connect. |
| Settings | Write mode, the courses you confirmed for this term, class times you set, console language | |
| Console sessions | To keep you signed in | Only a hash of the session cookie, plus a short user-agent snippet. |
| API keys | To authenticate MCP clients | Only a hash, a short prefix, the name and scopes. The full key is shown once. |
| OAuth grants and tokens | To authenticate MCP clients that use OAuth | Managed by the OAuth library. |
| Pending and past actions | The preview-then-confirm write flow | Includes what you asked to send (for example message text, forum post, submission file names). |
| Upload drafts | Large file uploads | File names and sizes only, not contents. |
| Activity (audit) log | So you can see what was done in your name | Action names and non-content details such as ids and booleans. |
| Course snapshots | Deadline detection and "what's new" | Compact outline of your courses: activity names, dates, completion, file names and links, and short text snippets (up to about 2 KB) that mention deadlines. |
| Syllabus cache | Timetable | Parsed public Waseda syllabus pages (times, rooms, instructors). Public data, shared across users, not tied to you. |
| Class times from Moodle | Timetable | Weekly class times derived from the attendance sessions of your courses in Moodle, when the syllabus gives none. Kept per user and refreshed weekly. |
| Calendar subscription | Calendar apps (only if you turn it on) | A hash of your private calendar link (the link itself is not stored), the time of the last fetch, and the generated calendar (deadlines and classes) for up to 30 minutes. |
| Rate-limit counters | Abuse protection | Keyed by IP address, user or token hash; short-lived. |

## What is never collected

- Your Moodle password. Sign-in happens on Moodle; the service receives only the mobile-app token.
- File contents. Downloads and uploads are streamed between Moodle and your client. When a client asks for a small file inline (up to 1 MiB), it is included in that one response only.
- Moodle tokens in logs. Server logs contain only error names, not request bodies or tokens.

## How long data is kept

Expired data is purged daily.

| Data | Retention |
|---|---|
| Activity log | 90 days |
| Finished, cancelled or expired actions | 90 days after creation |
| Pending actions | Expire after 30 minutes |
| Revoked API keys | 90 days after revocation |
| Course snapshots | 30 days after last check |
| Class times from Moodle | 30 days after last check |
| Calendar subscription | Until you turn it off or delete your account |
| Sessions, connect handoffs, OAuth requests, upload drafts | Until they expire (sessions: 30 days of inactivity; handoffs: 2 minutes; upload links: 30 minutes) |
| OAuth tokens | Access 12 hours, refresh 90 days, or until you revoke the app |
| Rate-limit counters | 1 day |
| Syllabus cache (public data) | Up to 400 days |
| Your account, token and settings | Until you delete your account |

## Who can access it

- You, through the console and your connected AI clients.
- The operator of the instance, who has technical access to the database and the encryption key. Operators are expected to access data only to run and secure the service.
- Cloudflare, as the hosting provider, processes the data as part of running the service.

Data is not sold, shared with third parties, or used for advertising, profiling or training AI
models. What your AI client does with tool results is governed by that client's own policy.

## Disconnect and delete

In the console:

- **Apps**: revoke an MCP client's OAuth access.
- **API keys**: revoke a key.
- **Settings -> Delete account**: revokes all OAuth grants and permanently deletes your user record, encrypted token, settings, sessions, API keys, actions, upload drafts, activity log, course snapshots, class times from Moodle and your calendar subscription. Your Moodle account is not affected.

The service never revokes or resets your Moodle token, because it is the same token the
official Moodle mobile app uses; revoking it would sign your phone out. If you also want to
invalidate the token, do so from Moodle itself (this will sign out the mobile app as well).

## Local (stdio) mode

When run locally, nothing is sent to any server other than Moodle. The token is stored in
plain text in `~/.config/waseda-moodle-mcp/token` (file mode 0600); settings and pending
actions in `state.json` next to it. Delete that directory to remove all local data.

## Browser extension

The extension only helps you connect your Moodle account to the service you choose.

- **What it reads**: only the Moodle mobile-app launch page on `https://wsdmoodle.waseda.jp`, using your existing Moodle sign-in, to obtain the launch link that contains the token. It does not read any other page or your browsing history.
- **Where it sends data**: only to the service URL you configure in its options (for which it asks for permission). Nothing is sent to the extension developer or anyone else.
- **What it stores**: the service URL, when you agreed to send data to it, and the time and result of the last sync. The token is never stored in the extension.
- **Background refresh**: about every 12 hours it repeats the capture and sends the token to your service so that a changed token is picked up.
- **Permissions**: `storage`, `alarms`, host access to `wsdmoodle.waseda.jp`, and optional access to your service origin.

**Limited Use**: The use of information received from Moodle by the extension adheres to the
Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only
to provide the connect feature, is not transferred except to the service you configured, is
not used for advertising, credit-worthiness or lending purposes, and is not read by humans
except where required for security, legal compliance, or with your consent.

## Changes

Material changes to this document are made in the repository and are visible in its history.

## Contact

Contact the operator of the instance you use; the console's privacy page links the operator's contact
when `VITE_CONTACT_URL` is set (see [self-hosting](self-hosting.md)). For the project itself, open an issue in the
repository.
