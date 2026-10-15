# Store listing — Waseda Moodle MCP Connector

Paste into the Chrome Web Store and Edge Add-ons dashboards. Keep this copy, the privacy page
(`<serviceUrl>/privacy`, e.g. `https://wasemoodle.example.com/privacy`) and the code in sync.

Assets: `icon-128.svg` (store icon, 96×96 art + 16 px padding), `logo-300.svg` (Edge logo),
`promo-440x280.svg` (small promo tile). Render PNGs with `node scripts/render-store-assets.mjs`.
Screenshots (1280×800) come from the real UI, taken in a demo environment.

## Dashboard answers

- **Single purpose:** Send the user's Waseda Moodle mobile-app token, with their consent, only to the Moodle MCP
  service URL they configure, and keep that connection refreshed.
- **Remote code:** No, I am not using remote code.
- **Data usage:** Authentication information; Website content. Certify all three Limited Use statements.
- **Privacy policy URL:** `https://<PUBLIC_URL>/privacy`

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Stores the service URL, the user's consent for that URL and the last sync result locally. Never stores the Moodle token. |
| `alarms` | Refreshes the connection about every 12 hours while the user stays signed in to Moodle. |
| Host `https://wsdmoodle.waseda.jp/*` | Reads the Moodle mobile-app launch page with the user's existing session and detects sign-in on `/my/`. No other sites. |
| Optional host `https://*/*` | The service origin is entered by the user and unknown at install time. On Save the extension requests only that HTTPS origin. Nothing is requested at install. |
| Content script on `launch.php` | Only in a tab the extension opened (`wmmExt=1`): reads the `#launchapp` link and passes it to the extension. Inactive on normal visits. |

## English

**Short description (≤132):**
Connects your Waseda Moodle session to your own MCP service and keeps it signed in.

**Detailed description:**
Connects your Waseda Moodle session to a Moodle MCP service you operate and keeps the connection signed in.

After you enter your service URL and agree in Settings, the extension reads the Moodle mobile-app token on
wsdmoodle.waseda.jp and sends it only to that HTTPS URL. It never stores or revokes the token and never sends it to
the developer. The official Moodle app keeps working.

Choose Connect to link your account; if you are not signed in to Moodle, a sign-in tab opens. While your Moodle session
is valid, the connection is refreshed in the background about every 12 hours.

Unofficial. Not affiliated with Waseda University or Open LMS. Requires an existing Moodle MCP server.

## 日本語

**短い説明:**
早稲田 Moodle のセッションを自分の MCP サービスに接続し、ログイン状態を維持します。

**詳細な説明:**
早稲田 Moodle のセッションを、利用者が運用する Moodle MCP サービスに接続し、接続状態を維持します。

設定でサービス URL を入力して同意すると、wsdmoodle.waseda.jp 上の Moodle モバイルアプリ用トークンを読み取り、その HTTPS URL
にだけ送信します。トークンを保存・失効させることはなく、開発者へ送ることもありません。公式 Moodle アプリはそのまま使えます。

「接続」を選ぶとアカウントを連携します。Moodle に未サインインの場合はサインイン用タブが開きます。Moodle
セッションが有効な間、約 12 時間ごとにバックグラウンドで接続を更新します。

非公式の拡張機能です。早稲田大学および Open LMS とは関係ありません。Moodle MCP サーバーが別途必要です。

## 简体中文

**简短说明:**
将早稻田 Moodle 会话连接到你自己的 MCP 服务，并保持登录状态。

**详细说明:**
将你的早稻田 Moodle 会话连接到你自己运行的 Moodle MCP 服务，并保持登录。

在设置中填写服务 URL 并同意后，扩展会读取 wsdmoodle.waseda.jp 上的 Moodle 移动应用令牌，并仅发送到该 HTTPS
地址。扩展不会保存或吊销令牌，也不会发送给开发者。官方 Moodle 应用可照常使用。

点击“连接”即可关联账户；若尚未登录 Moodle，会打开登录标签页。在 Moodle 会话有效期间，扩展约每 12 小时在后台刷新连接。

非官方工具，与早稻田大学及 Open LMS 无关。需要已有的 Moodle MCP 服务器。
