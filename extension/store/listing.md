# Store listing — Waseda Moodle MCP Connector

Listing copy for the Chrome Web Store and Microsoft Edge Add-ons. Related files:
[SUBMIT.md](SUBMIT.md) (steps), [permissions.md](permissions.md) (privacy answers),
[screenshots.md](screenshots.md) (images). Keep this copy, the privacy page (`<service URL>/privacy`) and the code in
sync.

## Common fields

| Field | Value |
|---|---|
| Store name | `Waseda Moodle MCP Connector` (read from the package) |
| Publisher name | `12dora` |
| Category, Chrome | Productivity → Education |
| Category, Edge | Productivity |
| Languages | English (default), Japanese, Chinese (Simplified) |
| Mature content | No |
| Price | Free |
| Homepage / website | `https://github.com/12dora/waseda-moodle-mcp` |
| Support URL | `https://github.com/12dora/waseda-moodle-mcp/issues` |
| Privacy policy URL | `<service URL>/privacy` (`<service URL>` is the instance's `PUBLIC_URL`) |

## Short description

Both stores read this from the package (`extDescription` in `_locales/*/messages.json`); it is not typed into the
dashboard. The limit is 132 characters. To change it, edit the locale file, raise the version and upload again.

| Locale | Text |
|---|---|
| en | Keeps your Waseda Moodle session connected to your Waseda Moodle MCP service. |
| ja | 早稲田 Moodle のサインインを Moodle MCP サービスに連携し、接続を維持します。 |
| zh-CN | 将早稻田 Moodle 的登录会话连接到 Moodle MCP 服务，并保持连接。 |

## Full description

Plain text: paste the content of each block as it is.

### English

```text
Connects your Waseda Moodle account to a Waseda Moodle MCP service, so that AI assistants you link to that service can look up your assignments, deadlines, timetable and course updates.

WHAT IT DOES
• Connect: sign in to Waseda Moodle as usual and click Connect. The service's console opens and links your account.
• Stay connected: when you sign in to Moodle again, and about every 12 hours, your current session is sent so the connection keeps working. "Sync now" in Settings does the same on demand.

WHAT IT SENDS, AND WHERE
• Your Moodle sign-in session: the MoodleSession cookie of wsdmoodle.waseda.jp. No other cookie is read.
• Destination: only the HTTPS service URL you enter in Settings.
• Nothing is sent until you tick the consent box. Your password and browsing history are not read. The extension does not save the cookie.

BEFORE YOU CONNECT
The session gives the same access as being signed in to Moodle. Enter only a service you trust: one you host yourself, or an instance whose operator you trust. That operator receives the data listed above. The service's privacy policy is linked in Settings.

STOPPING
Untick the consent box and save, or remove the extension. Signing out of Moodle in this browser ends the session the service holds; while the extension is set up, your next sign-in reconnects automatically.

REQUIREMENTS
A Waseda Moodle account and a Waseda Moodle MCP service. An instance may limit who can sign up.

Open source: https://github.com/12dora/waseda-moodle-mcp

Unofficial. Not affiliated with, endorsed by or sponsored by Waseda University, Moodle Pty Ltd or Open LMS.
```

### 日本語

```text
早稲田 Moodle のアカウントを Waseda Moodle MCP サービスに連携します。サービスに接続した AI アシスタントから、課題、締切、時間割、コースの更新情報を確認できるようになります。

主な機能
• 連携：通常どおり早稲田 Moodle にサインインして「連携」をクリックします。サービスのコンソールが開き、アカウントが連携されます。
• 接続の維持：Moodle に再度サインインしたときと約 12 時間ごとに、現在のセッションを送信して接続を保ちます。設定の「今すぐ同期」で手動でも送信できます。

送信する情報と送信先
• Moodle のサインインセッション：wsdmoodle.waseda.jp の MoodleSession Cookie。ほかの Cookie は読み取りません。
• 送信先：設定で入力した HTTPS のサービス URL のみ。
• 同意のチェックを入れるまで何も送信しません。パスワードと閲覧履歴は読み取りません。拡張機能は Cookie を保存しません。

連携する前に
このセッションがあれば、Moodle にサインインしているのと同じ操作ができます。自分で運用するサービス、または運営者を信頼できるサービスのみを指定してください。上記の情報はその運営者が受け取ります。サービスのプライバシーポリシーは設定画面から開けます。

利用の停止
同意のチェックを外して保存するか、拡張機能を削除してください。このブラウザで Moodle からサインアウトすると、サービスが保持するセッションは終了します。拡張機能を設定したままにしていると、次回のサインインで自動的に再接続します。

必要なもの
早稲田 Moodle のアカウントと Waseda Moodle MCP サービス。サービスによっては、利用登録できる人が限られます。

ソースコード：https://github.com/12dora/waseda-moodle-mcp

非公式の拡張機能です。早稲田大学、Moodle Pty Ltd、Open LMS とは関係がなく、承認や支援も受けていません。
```

### 简体中文

```text
将你的早稻田 Moodle 账户连接到 Waseda Moodle MCP 服务，让接入该服务的 AI 助手能够查询你的作业、截止时间、课程表和课程更新。

功能
• 连接：照常登录早稻田 Moodle，然后点击“连接”。扩展会打开该服务的控制台并关联你的账户。
• 保持连接：当你重新登录 Moodle 时，以及大约每 12 小时，扩展会发送当前会话，使连接持续有效。也可以在设置中点击“立即同步”手动发送。

发送哪些数据、发送到哪里
• Moodle 登录会话：wsdmoodle.waseda.jp 的 MoodleSession Cookie。不读取任何其他 Cookie。
• 发送目标：只有你在设置中填写的 HTTPS 服务地址。
• 在你勾选同意框之前不发送任何内容。不读取你的密码和浏览记录。扩展不保存 Cookie。

连接前请注意
持有该会话等同于以你的身份登录 Moodle。请只填写你信任的服务：自己部署的服务，或运营者值得信任的实例。上述数据会由该运营者接收。服务的隐私政策可在设置页面打开。

停止使用
取消勾选同意框并保存，或直接移除扩展。在此浏览器中退出 Moodle 会结束服务所持有的会话；只要扩展仍保持设置，下次登录时会自动重新连接。

使用条件
需要早稻田 Moodle 账户和一个 Waseda Moodle MCP 服务。部分实例会限制可注册的用户。

开源代码：https://github.com/12dora/waseda-moodle-mcp

非官方扩展。与早稻田大学、Moodle Pty Ltd 及 Open LMS 无任何关联，也未获其认可或赞助。
```

## Search terms (Edge only)

At most 7 terms per language, 30 characters per term and 21 words in total.

| Locale | Terms |
|---|---|
| en | `Waseda Moodle` · `wsdmoodle` · `MCP` · `Model Context Protocol` · `assignment deadlines` · `AI assistant` |
| ja | `早稲田 Moodle` · `wsdmoodle` · `MCP` · `課題 締切` · `時間割` · `AI アシスタント` |
| zh-CN | `早稻田 Moodle` · `wsdmoodle` · `MCP` · `作业 截止时间` · `课程表` · `AI 助手` |

## Graphic assets

| File (in `extension/store/`) | Size | Chrome field | Edge field |
|---|---|---|---|
| `icon-128.png` | 128×128 | Store icon | — |
| `logo-300.png` | 300×300 | — | Extension logo |
| `promo-440x280.png` | 440×280 | Small promo tile | Small promotional tile |
| `screenshots/<locale>/*.png` | 1280×800 | Screenshots | Screenshots |

The PNGs are rendered from the SVG files of the same name with `node scripts/render-store-assets.mjs`.
