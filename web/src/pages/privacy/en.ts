import type { PrivacyDoc } from './types';

export const en: PrivacyDoc = {
  title: 'Privacy policy',
  effective: 'Effective date',
  intro: [
    'This policy describes how Waseda Moodle MCP (the hosted service and the "Waseda Moodle MCP Connector" browser extension) handles your data. It applies to any instance run from the project repository; the operator of an instance is the party responsible for it.',
    'Waseda Moodle MCP is unofficial and not affiliated with Waseda University.',
  ],
  sections: [
    {
      heading: 'Summary',
      blocks: [
        {
          ul: [
            'We never ask for or see your Moodle password.',
            "The service acts on Moodle with your Moodle sign-in session (and the Moodle app token when Waseda's app service is on). Both are stored encrypted and used only for your requests, a background deadline sweep and keeping the connection alive.",
            'A light request about once an hour keeps the session from timing out. Signing out of Moodle ends it.',
            'File contents are passed through, never stored.',
            'Your data is not sold, shared, used for advertising, or used to train AI models.',
            'You can delete everything from the console at any time.',
            'Waseda mail is optional. The contents of your mailbox are never stored.',
          ],
        },
      ],
    },
    {
      heading: 'What is collected',
      blocks: [
        {
          table: {
            head: ['Data', 'Why', 'Notes'],
            rows: [
              [
                'Moodle sign-in session (session cookie and session key)',
                'To call Moodle on your behalf',
                'The MoodleSession cookie and the session key (sesskey) Moodle requires with requests, encrypted with AES-256-GCM using the instance’s master key and sent only to Moodle. It gives the same access as being signed in to Moodle. A light request about once an hour keeps it from timing out. Also kept: when it was last confirmed. Removed when the service finds that Moodle ended it (for example after you sign out of Moodle) or you delete your account.',
              ],
              [
                'Moodle app token and optional private token (only when Waseda’s app service is on)',
                'To call Moodle through its app service and renew the token',
                'Received from a launch link you paste, or obtained by the service from Moodle with your session. Encrypted like the session; a hash and the last 4 characters are kept to recognise the token. With a private token, the service renews the token automatically and, for that, can open a Moodle sign-in session of its own; when the token was last renewed is kept.',
              ],
              ['Moodle user id, full name, language', 'To identify your account', 'Read from Moodle when you connect.'],
              [
                'Settings',
                'Write mode, the courses you confirmed for this term, class times you set, console language',
                '',
              ],
              [
                'Console sessions',
                'To keep you signed in',
                'Only a hash of the session cookie, plus a short user-agent snippet.',
              ],
              [
                'API keys',
                'To authenticate MCP clients',
                'Only a hash, a short prefix, the name and scopes. The full key is shown once.',
              ],
              [
                'OAuth grants and tokens',
                'To authenticate MCP clients that use OAuth',
                'Managed by the OAuth library.',
              ],
              [
                'Pending and past actions',
                'The preview-then-confirm write flow',
                'Includes what you asked to send (for example message text, mail, forum post, submission file names).',
              ],
              ['Upload drafts', 'Large file uploads', 'File names and sizes only, not contents.'],
              [
                'Activity (audit) log',
                'So you can see what was done in your name',
                'Action names and non-content details such as ids and booleans.',
              ],
              [
                'Course snapshots',
                'Deadline detection and “what’s new”',
                'Compact outline of your courses: activity names, dates, completion, file names and links, and short text snippets (up to about 2 KB) that mention deadlines.',
              ],
              [
                'Cached due list',
                'So the console shows your deadlines at once',
                'A copy of your due list (assignments and deadlines with their submission status), refreshed when you open the console, deleted after 7 days or with your account.',
              ],
              [
                'Syllabus cache',
                'Timetable',
                'Parsed public Waseda syllabus pages (times, rooms, instructors). Public data, shared across users, not tied to you.',
              ],
              [
                'Class times from Moodle',
                'Timetable',
                'Weekly class times derived from the attendance sessions of your courses in Moodle, when the syllabus gives none. Kept per user and refreshed weekly.',
              ],
              [
                'Calendar subscription',
                'Calendar apps (only if you turn it on)',
                'A hash of your private calendar link (the link itself is not stored), the time of the last fetch, and the generated calendar (deadlines and classes) for up to 30 minutes.',
              ],
              ['Rate-limit counters', 'Abuse protection', 'Keyed by IP address, user or token hash; short-lived.'],
              [
                'Usage statistics',
                'To see how the service is used',
                'Aggregate counts per day only: tool calls per tool with their failure class and response-time bucket, calls per AI client type and per hour of day, console page use, calendar feed fetches, outcomes of keeping Moodle connections alive and connection methods, and write actions per type by outcome. Also the number of active users per day, week and month, overall and by channel (AI clients, console), and how many users who signed up in a given week are still active 1, 2 and 4 weeks later (signup weeks are grouped so that each group has at least 3 users; smaller groups are not shown). The counts carry no user identifiers and are not linked to any account, so they remain after account deletion. Active users are de-duplicated within the same day, week or month using salted keys that are deleted at the first daily cleanup after that period ends. Visible to the operator only.',
              ],
              [
                'Landing page visits',
                'To see how many people visit the introduction pages',
                'Cloudflare Web Analytics on the public introduction pages (no cookies, no cross-site tracking), aggregated by Cloudflare.',
              ],
            ],
          },
        },
      ],
    },
    {
      heading: 'What is never collected',
      blocks: [
        {
          ul: [
            'Your Moodle password. Sign-in happens on Moodle; the service receives only the Moodle session cookie and, when used, the app token.',
            'File contents. Downloads and uploads are streamed between Moodle and your client. When a client asks for a small file inline (up to 1 MiB), it is included in that one response only.',
            'Moodle session cookies, session keys or tokens in logs. Server logs contain only error names, not request bodies, tokens or cookies.',
          ],
        },
      ],
    },
    {
      heading: 'Waseda mail (optional)',
      blocks: [
        {
          ul: [
            'Only if you connect it in Settings → Mail. Google asks you to authorize access; the service never sees your Google password.',
            'Stored: your mail address, your Google account id, the Google authorization (encrypted like the Moodle session), the permissions granted (read, and send if allowed), and when you connected and last used it.',
            'Never stored: the contents of your mailbox. They pass through to your AI client only when it calls a mail tool. Mail is sent only after you confirm it, and a mail you prepare (sent or not) is kept with its action for 90 days.',
            'A connection unused for the number of days shown in Settings → Mail is disconnected automatically, as is a connection whose access an administrator revoked.',
            'Google limits this app to a fixed number of users. To count against that limit, the service keeps a list of the Moodle user ids that have connected mail, with the date. It holds only these two items and remains after you delete your account.',
            "Access requests: your request status and the request and decision times are stored and deleted with your account. Administrators see each applicant's name, Moodle user id, request time, and connected mail address with its status in order to review requests.",
            'Disconnect any time in Settings → Mail, or at https://myaccount.google.com/permissions.',
          ],
        },
        {
          p: "Waseda Moodle MCP's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. https://developers.google.com/terms/api-services-user-data-policy",
        },
      ],
    },
    {
      heading: 'How long data is kept',
      blocks: [
        { p: 'Expired data is purged daily.' },
        {
          table: {
            head: ['Data', 'Retention'],
            rows: [
              ['Moodle sign-in session', 'Until Moodle ends it or you delete your account'],
              ['Activity log', '90 days'],
              ['Finished, cancelled, expired or superseded actions', '90 days after creation'],
              ['Pending actions', 'Expire after 30 minutes'],
              ['Revoked API keys', '90 days after revocation'],
              ['Course snapshots', '30 days after last check'],
              ['Cached due list', '7 days'],
              ['Class times from Moodle', '30 days after last check'],
              ['Calendar subscription', 'Until you turn it off or delete your account'],
              [
                'Waseda mail connection',
                'Until you disconnect, it is disconnected for inactivity or by an administrator, or you delete your account',
              ],
              ['Mail access request (status and request/decision times)', 'Until you delete your account'],
              ['Mail slot list (Moodle user id and date only)', 'Kept, also after you delete your account'],
              [
                'Sessions, connect handoffs, OAuth requests, upload drafts',
                'Until they expire (sessions: 30 days of inactivity; handoffs: 2 minutes; upload links: 30 minutes)',
              ],
              ['OAuth tokens', 'Access 12 hours, refresh 90 days, or until you revoke the app'],
              ['Rate-limit counters', '1 day'],
              ['Usage statistics', '400 days (counts only)'],
              ['Syllabus cache (public data)', 'Up to 400 days'],
              ['Your account, Moodle credentials and settings', 'Until you delete your account'],
            ],
          },
        },
      ],
    },
    {
      heading: 'Who can access it',
      blocks: [
        {
          ul: [
            'You, through the console and your connected AI clients.',
            'The operator of the instance, who has technical access to the database and the encryption key. Operators are expected to access data only to run and secure the service.',
            'Cloudflare, as the hosting provider, processes the data as part of running the service.',
          ],
        },
        {
          p: 'Data is not sold, shared with third parties, or used for advertising, profiling or training AI models. What your AI client does with tool results is governed by that client’s own policy.',
        },
      ],
    },
    {
      heading: 'Disconnect and delete',
      blocks: [
        { p: 'In the console:' },
        {
          ul: [
            'Apps: revoke an MCP client’s OAuth access.',
            'API keys: revoke a key.',
            'Settings → Mail: disconnect your Waseda mail.',
            'Settings → Delete account: revokes all OAuth grants and permanently deletes your user record, encrypted Moodle sign-in session and app token, settings, sessions, API keys, actions, upload drafts, activity log, course snapshots, cached due list, class times from Moodle, your calendar subscription, your Waseda mail connection and your mail access request. Your Moodle account is not affected.',
          ],
        },
        {
          p: 'Signing out of Moodle in your browser ends the session the service holds. If the extension is set up, it reconnects at your next sign-in; remove the extension to stop that.',
        },
        {
          p: 'The service never signs you out of Moodle, and never revokes or resets your Moodle app token, because it is the same token the official Moodle mobile app uses. Deleting your account removes the service’s copies; the session itself lasts until you sign out of Moodle or it times out. To invalidate the app token, do so in Moodle (this also signs out the mobile app).',
        },
      ],
    },
    {
      heading: 'Local (stdio) mode',
      blocks: [
        {
          p: 'When run locally, nothing is sent to any server other than Moodle. The Moodle session cookie and session key, and the app token if you connected with a launch link, are stored in plain text in ~/.config/waseda-moodle-mcp/token (file mode 0600); settings and pending actions in state.json next to it. While the local server runs, a light request about once an hour keeps the session from timing out. Delete that directory to remove all local data.',
        },
      ],
    },
    {
      heading: 'Browser extension',
      blocks: [
        { p: 'The extension only helps you connect your Moodle account to the service you choose.' },
        {
          ul: [
            'What it reads: the MoodleSession cookie of https://wsdmoodle.waseda.jp, and no other cookie; it asks Moodle whether that session is signed in. It does not read your browsing history or other sites.',
            'Where it sends data: only to the service URL you configure in its options (for which it asks for permission). The data goes only to that service, and whoever operates it receives it.',
            'What it stores: the service URL, when you agreed to send data to it, the time and result of the last sync and, while a connect waits for you to sign in (until the browser closes at most), the id of that tab. The session cookie is never stored in the extension, and nothing is read or sent until you agree in its settings.',
            'Staying connected: when you sign in to Moodle again, and about every 12 hours, it sends the current session cookie to your service. The service accepts it only for an account that is already connected.',
            'Permissions: storage, alarms, cookies, host access to wsdmoodle.waseda.jp, and optional access to your service origin.',
          ],
        },
        {
          p: 'Limited Use: The use of information received from Moodle by the extension adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the connect feature, is not transferred except to the service you configured, is not used for advertising, credit-worthiness or lending purposes, and is not read by humans except where required for security, legal compliance, or with your consent.',
        },
      ],
    },
    {
      heading: 'Changes',
      blocks: [
        { p: 'Material changes to this policy are made in the project repository and are visible in its history.' },
      ],
    },
  ],
  contact: {
    heading: 'Contact',
    label: 'Contact',
    fallback: 'Contact the operator of this instance.',
  },
};
