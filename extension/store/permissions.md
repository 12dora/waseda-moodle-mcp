# Privacy answers — single purpose, permissions, data use

Both stores ask for these. Paste the English text. It describes `manifest.json` and `background.js`; update it
whenever either changes.

## Single purpose

```text
Connects the user's Waseda Moodle sign-in session, with the user's consent, to the Waseda Moodle MCP service URL the user enters, and keeps that connection up to date.
```

## Permission justifications

| Permission | Justification (paste) |
|---|---|
| `cookies` | Reads one cookie, MoodleSession of wsdmoodle.waseda.jp, to connect the user's account and keep it connected, and detects when that cookie changes after a new sign-in. It is sent only to the service URL the user consented to and is not saved by the extension. |
| `storage` | Saves the service URL, the consent for that URL and the last sync result locally, and keeps the id of the tab waiting for a Moodle sign-in for the browser session only. No cookie or token is saved. |
| `alarms` | Runs a sync about every 12 hours so the connected service keeps a current Moodle session. |
| Host `https://wsdmoodle.waseda.jp/*` | The only Moodle site supported: needed to read the MoodleSession cookie, to check whether the user is signed in, and to read the Moodle app launch link when Moodle offers one. |
| Optional host `https://*/*` | The user types the address of their own or chosen service, so its origin is unknown at install time. Nothing is granted at install; on Save, the extension requests access to that single HTTPS origin only, to send the data there. |

Chrome shows one box for all host permissions. Paste:

```text
https://wsdmoodle.waseda.jp/* is the only supported Moodle site: it is needed to read the MoodleSession cookie, check whether the user is signed in, and read the Moodle app launch link when offered. The optional https://*/* pattern is never granted at install. The user types the address of the service they use, which cannot be known in advance; on Save, the extension requests that one HTTPS origin only, and sends data nowhere else.
```

Not requested: `tabs`, `history`, `webRequest`, `scripting`, content scripts. The extension opens and updates its own
sign-in and console tabs, which needs no `tabs` permission.

## Remote code

Answer: **No, I am not using remote code.** All JavaScript is in the package, unminified, with no third-party
libraries, `eval` or externally loaded scripts. Responses from Moodle and from the service are read as data only.

## Data handled

| Data | When | Why | Where it goes | Kept by the extension |
|---|---|---|---|---|
| `MoodleSession` cookie value | After consent: Connect, Sync now, a new Moodle sign-in, about every 12 hours. Also read to show the sign-in status in the popup | Connect the account and keep it connected | To Moodle for the sign-in check; to the consented service URL | No (a replaced value is compared in memory when the cookie changes) |
| Moodle app launch link (contains an app token) and the random value used to request it | Connect only, and only if Moodle offers the link | Lets the service also use Moodle's app service | To the consented service URL | No |
| One-time connect code (issued by the service) | Connect | Open the service console and finish connecting | In the address of the console tab on the service | No |
| Service URL, consent (URL, scope, time) | On Save | Know where data may be sent | Stays in the browser | Until changed, withdrawn or the extension is removed |
| Time and result of the last sync | After each attempt | Show status in the popup | Stays in the browser | Until the URL changes or is cleared, or the extension is removed |
| Id of the tab waiting for sign-in, with an expiry time | While Connect waits (10 minutes at most) | Continue after sign-in | Stays in the browser | Browser session only |

As with any web request, the service also receives the IP address and browser details. What the service stores and
for how long is described in its privacy policy (`<service URL>/privacy`).

The extension does not read the Moodle password, other cookies, browsing history or the content of other sites. It
contains no analytics or advertising.

## Chrome: data usage form

| Category | Tick | Reason |
|---|---|---|
| Authentication information | **Yes** | Moodle session cookie; app token inside the launch link |
| Website content | **Yes** | The launch link is read from a Moodle page |
| Personally identifiable information | No | The extension reads and sends no name, address, email or ID |
| Health information | No | |
| Financial and payment information | No | |
| Personal communications | No | |
| Location | No | |
| Web history | No | |
| User activity | No | |

The service uses the session to read the user's Moodle account (name, user id, courses). That is stated in its
privacy policy. The table above covers what the extension itself handles.

Tick all three certifications; each is true:

1. I do not sell or transfer user data to third parties, outside of the approved use cases.
2. I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
3. I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Edge: privacy answers

- **Does the extension access, collect or transmit personal information?** Yes (authentication information).
- **Privacy policy URL:** `<service URL>/privacy`
- Where Partner Center asks for single purpose, permission justifications, remote code or data usage, use the answers
  above.

## Data use statement

Paste where a free-text explanation is asked for.

```text
The extension handles the user's Waseda Moodle session cookie and, when Moodle offers it, the Moodle app launch link. After the user consents, it sends them only to the service URL the user entered, solely to connect the user's account and keep it connected. The data is not sold, not used for advertising, profiling, creditworthiness or lending, and not transferred for any other purpose. Nothing is sent to any other destination. The use of information received from Moodle adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.
```
