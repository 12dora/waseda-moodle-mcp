# Store listing — Waseda Moodle MCP Connector

Paste into the Chrome Web Store and Edge Add-ons dashboards. Keep this copy, the privacy page
(`<serviceUrl>/privacy`, e.g. `https://wasemoodle.example.com/privacy`) and the code in sync.

Assets: `icon-128.svg` (store icon, 96×96 art + 16 px padding), `logo-300.svg` (Edge logo),
`promo-440x280.svg` (small promo tile). Render PNGs with `node scripts/render-store-assets.mjs`.
Screenshots (1280×800) come from the real UI, taken in a demo environment.

## Dashboard answers

- **Single purpose:** Send the user's Waseda Moodle sign-in session, with their consent, only to the Moodle MCP service
  URL they configure, to connect their account and keep it connected.
- **Remote code:** No, I am not using remote code.
- **Data usage:** Authentication information; Website content. Certify all three Limited Use statements.
- **Privacy policy URL:** `https://<PUBLIC_URL>/privacy`

## Permission justifications

| Permission | Justification |
|---|---|
| `cookies` | Reads only the `MoodleSession` cookie of `wsdmoodle.waseda.jp`, to connect the account and keep the connection (including after the user signs in to Moodle again). The cookie is sent only to the service URL the user agreed to, and is never stored by the extension. No other cookie or site is read. |
| `storage` | Stores the service URL, the user's consent for that URL and the last sync result locally, and, for the current browser session, which tab is waiting for the Moodle sign-in. Never stores the cookie. |
| `alarms` | Sends the current session to the service about every 12 hours while the user stays signed in to Moodle. |
| Host `https://wsdmoodle.waseda.jp/*` | Required to read the `MoodleSession` cookie, to check whether the user is signed in, and to read the Moodle app launch link when Moodle offers it. No other sites. |
| Optional host `https://*/*` | The service origin is entered by the user and unknown at install time. On Save the extension requests only that HTTPS origin. Nothing is requested at install. |

## English

**Short description (≤132):**
Connects your Waseda Moodle sign-in to your own MCP service and keeps it connected.

**Detailed description:**
Connects your Waseda Moodle account to a Moodle MCP service you operate and keeps it connected.

After you enter your service URL and agree in Settings, the extension reads one cookie, MoodleSession on
wsdmoodle.waseda.jp (your Moodle sign-in session), and sends it only to that HTTPS URL. If Moodle offers the app launch
link, it is sent along. The extension never stores either of them and never sends them to the developer. Your password
is not read.

Choose Connect to link your account; if you are not signed in to Moodle, a sign-in tab opens and the connection
continues automatically. The session is sent again when you sign in to Moodle again and about every 12 hours. Signing
out of Moodle in this browser ends the connection until your next sign-in, which reconnects automatically.

Unofficial. Not affiliated with Waseda University or Open LMS. Requires an existing Moodle MCP server.

## 日本語

**短い説明:**
早稲田 Moodle のサインインを自分の MCP サービスに連携し、接続を維持します。

**詳細な説明:**
早稲田 Moodle のアカウントを、利用者が運用する Moodle MCP サービスに連携し、接続を維持します。

設定でサービス URL を入力して同意すると、wsdmoodle.waseda.jp の Cookie のうち MoodleSession（Moodle
のサインインセッション）のみを読み取り、その HTTPS URL にだけ送信します。Moodle
がアプリ起動リンクを提供している場合は、あわせて送信します。拡張機能はいずれも保存せず、開発者へ送ることもありません。パスワードは読み取りません。

「連携」を選ぶとアカウントを連携します。Moodle
に未サインインの場合はサインイン用タブが開き、サインイン後に自動で続行します。セッションは、Moodle に再度サインインしたときと約 12
時間ごとに送信されます。このブラウザで Moodle からサインアウトすると接続は終了し、次回のサインインで自動的に再接続します。

非公式の拡張機能です。早稲田大学および Open LMS とは関係ありません。Moodle MCP サーバーが別途必要です。

## 简体中文

**简短说明:**
将早稻田 Moodle 的登录会话连接到你自己的 MCP 服务，并保持连接。

**详细说明:**
将你的早稻田 Moodle 账户连接到你自己运行的 Moodle MCP 服务，并保持连接。

在设置中填写服务 URL 并同意后，扩展只读取 wsdmoodle.waseda.jp 的一个 Cookie：MoodleSession（你的 Moodle
登录会话），并仅发送到该 HTTPS 地址。如果 Moodle 提供应用启动链接，会一并发送。扩展不会保存它们，也不会发送给开发者，也不读取你的密码。

点击“连接”即可关联账户；若尚未登录 Moodle，会打开登录标签页，登录后自动继续。重新登录 Moodle 时以及约每 12
小时，会再次发送会话。在此浏览器中退出 Moodle 会结束连接，下次登录时自动重新连接。

非官方工具，与早稻田大学及 Open LMS 无关。需要已有的 Moodle MCP 服务器。
