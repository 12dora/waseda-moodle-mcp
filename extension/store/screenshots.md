# Screenshots

Chrome takes 1–5 screenshots, Edge up to 6. The same five files serve both stores.

## Rules

- Exactly 1280×800, PNG without transparency (24-bit RGB) or JPEG. Light colour scheme.
- Real extension and console UI with demo data only. Service URL `https://wasemoodle.example.com`, person
  `Taro Yamada` / `山田太郎`, invented course names. No browser address bar, bookmarks, profile picture, notifications,
  real cookie values or local paths.
- Popup shots: render the 320 px popup at 2× and centre it on a plain `#f6f8fa` canvas. Settings shots: 1280×800
  viewport, whole page visible without scrolling.
- Save as `extension/store/screenshots/<locale>/<file>`. `en` is required; `ja` and `zh-CN` are optional (without
  them, the stores show the English set). `store/` is not part of the uploaded package.

## Shot list (upload in this order)

| File | Page and state | What it shows |
|---|---|---|
| `01-popup-connected.png` | Popup, connected | Service URL, Moodle "Signed in", Last sync "Connected · session updated" with date, Connect and Open console |
| `02-settings-consent.png` | Settings, after Save | URL filled in, consent box ticked, Privacy policy link, "Saved.", Sync now enabled, Privacy section |
| `03-popup-sign-in.png` | Popup, signed out, after Connect | Moodle "Not signed in", message "Sign in to Moodle in the opened tab. The connection then continues automatically." |
| `04-console-connected.png` | Console Overview | Connections card: Moodle "Connected", Account, Method "Browser extension", Last checked |
| `05-settings-before-consent.png` | Settings, Save with the box unticked | Nothing is sent without consent: "Tick the consent box to connect. Nothing is sent until you do." |

## Demo state

Shots 1–3 and 5 use the extension's own pages with a stand-in `chrome` object (no real Moodle, no real cookie).
`i18n.getMessage` reads `_locales/<locale>/messages.json` (folder `zh_CN` for `zh-CN`); `i18n.getUILanguage` returns
the locale; `permissions.request` resolves to `true`; `runtime.openOptionsPage` and `tabs.create` do nothing.

| Shot | `storage.local` | `runtime.sendMessage` answers | Action before capture |
|---|---|---|---|
| 01 | `serviceUrl`, `consent`, `lastSync.result = "updated"` | `wmm:moodle-status` → `{ signedIn: true }` | — |
| 02 | empty | — | Type the URL, tick the box, click Save |
| 03 | `serviceUrl`, `consent`, `lastSync.result = "signin_required"` | `wmm:moodle-status` → `{ signedIn: false }`; `wmm:connect` → `{ ok: false, error: "signin_required" }` | Click Connect |
| 05 | empty | — | Type the URL, leave the box unticked, click Save |

Values:

- `serviceUrl`: `"https://wasemoodle.example.com"`
- `consent`: `{ "serviceUrl": "https://wasemoodle.example.com", "scope": "session", "at": <epoch ms> }`
- `lastSync`: `{ "at": <epoch ms>, "result": <as above> }`

Shot 02 needs `storage.local.set` to accept the write. Shot 04 comes from the demo console used for `docs/images/`,
connected through the extension (`connectedVia = "extension"`).
