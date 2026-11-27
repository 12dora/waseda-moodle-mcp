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
| Languages | Japanese (default, `default_locale`), English, Chinese (Simplified) |
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
| en | Lets AI assistants like Claude check your Waseda Moodle deadlines and timetable by keeping your sign-in linked to an MCP service. |
| ja | Claude などの AI アシスタントから早稲田 Moodle の課題・締切・時間割を確認できるよう、サインインを MCP サービスに連携し、接続を保ちます。 |
| zh-CN | 让 Claude 等 AI 助手查看你的早稻田 Moodle 作业、截止时间和课程表：将登录连接到 MCP 服务并保持连接。 |

## Full description

Plain text: paste the content of each block as it is. Japanese is the main listing (`default_locale`); English and
Chinese are the other two languages.

### 日本語（メイン）

```text
Claude などの AI アシスタントに「今週の課題は？」「明日の授業は何時から？」と聞くだけで、早稲田 Moodle の情報を確認できるようになります。この拡張機能は、Moodle のサインインを Waseda Moodle MCP サービスに連携し、その接続を保つためのものです。

できること（MCP サービス経由）
• 課題・締切：未提出の課題、小テスト、アンケートを締切順にまとめて確認
• 時間割：曜日ごとの授業、時限、教室、オンデマンド授業
• 成績・フィードバック、コースの新着・お知らせ、掲示板、メッセージ
• 授業資料の検索と一括ダウンロード
• 課題の提出や掲示板への投稿も、内容を確認して承認したときだけ実行

使い方
1. 拡張機能を追加すると設定画面が開きます。サービス URL は入力済みです（変更できます）。
2. 「保存」をクリックすると連携が始まります。Moodle にサインインしていない場合は、サインイン画面が開き、サインイン後に自動で続行します。
3. 以降は、Moodle に再度サインインしたときと約 12 時間ごとに、自動で接続を更新します。再ログインの手間はほとんどありません。

送信する情報と送信先
• 送信するのは wsdmoodle.waseda.jp の MoodleSession Cookie（サインインセッション）のみです。ほかの Cookie、パスワード、閲覧履歴は読み取りません。
• 送信先は、設定画面で指定した HTTPS のサービス URL だけです。
• 同意のチェックを外すと何も送信しません。拡張機能は Cookie を保存しません。

ご注意
このセッションがあれば、Moodle にサインインしているのと同じ操作ができます。自分で運用するサービス、または運営者を信頼できるサービスのみを指定してください。サービスのプライバシーポリシーは設定画面から開けます。

利用の停止
同意のチェックを外して保存するか、拡張機能を削除してください。このブラウザで Moodle からサインアウトすると、サービスが保持するセッションも終了します。

ソースコード（オープンソース）：https://github.com/12dora/waseda-moodle-mcp

本拡張機能は学生が開発した非公式のツールで、早稲田大学、Moodle Pty Ltd、Open LMS とは関係ありません。
```

### English

```text
Ask an AI assistant such as Claude "What's due this week?" or "When does my class start tomorrow?" and get answers from your Waseda Moodle. This extension links your Moodle sign-in to a Waseda Moodle MCP service and keeps that link working.

WHAT YOU CAN DO (through the MCP service)
• Deadlines: open assignments, quizzes and questionnaires, sorted by due date
• Timetable: classes per day with periods, rooms and on-demand courses
• Grades and feedback, course updates and announcements, forums, messages
• Search course materials and download them in bulk
• Submissions and forum posts run only after you review and approve them

HOW IT WORKS
1. After install, Settings opens with the service URL already filled in (you can change it).
2. Click Save to connect. If you are signed out of Moodle, the sign-in page opens and connecting continues after you sign in.
3. From then on the connection renews itself when you sign in to Moodle again and about every 12 hours, so you rarely need to reconnect.

WHAT IS SENT, AND WHERE
• Only the MoodleSession cookie of wsdmoodle.waseda.jp (your sign-in session). No other cookie, password or browsing history is read.
• Only to the HTTPS service URL set in Settings.
• Nothing is sent while the consent box is unticked. The extension does not save the cookie.

BEFORE YOU CONNECT
The session gives the same access as being signed in to Moodle. Use only a service you run yourself or one whose operator you trust. The service's privacy policy is linked in Settings.

STOPPING
Untick the consent box and save, or remove the extension. Signing out of Moodle in this browser also ends the session the service holds.

Open source: https://github.com/12dora/waseda-moodle-mcp

An unofficial tool built by a student. Not affiliated with Waseda University, Moodle Pty Ltd or Open LMS.
```

### 简体中文

```text
问 Claude 等 AI 助手「这周有什么作业？」「明天几点上课？」，就能直接查到早稻田 Moodle 的信息。本扩展负责把你的 Moodle 登录连接到 Waseda Moodle MCP 服务，并保持连接。

能做什么（通过 MCP 服务）
• 作业与截止：未提交的作业、小测、问卷，按截止时间汇总
• 课程表：每天的课程、节次、教室和点播课程
• 成绩与反馈、课程更新与公告、论坛、站内消息
• 搜索课程资料并批量下载
• 提交作业、论坛发帖等操作，只有在你确认后才会执行

使用方法
1. 安装后自动打开设置页，服务地址已预先填好（可修改）。
2. 点击「保存」即开始连接。如果还没登录 Moodle，会打开登录页，登录后自动继续。
3. 之后在你重新登录 Moodle 时以及大约每 12 小时，扩展会自动续接，基本不用重新连接。

发送哪些数据、发送到哪里
• 只发送 wsdmoodle.waseda.jp 的 MoodleSession Cookie（登录会话）。不读取其他 Cookie、密码和浏览记录。
• 只发送到你在设置中填写的 HTTPS 服务地址。
• 取消勾选同意框后不发送任何内容。扩展本身不保存 Cookie。

请注意
持有该会话即可以你的身份操作 Moodle。请只使用自己部署的服务，或运营者值得信任的服务。服务的隐私政策可在设置页打开。

停止使用
取消勾选同意框并保存，或移除扩展。在此浏览器中退出 Moodle，服务端持有的会话也会随之失效。

开源代码：https://github.com/12dora/waseda-moodle-mcp

本扩展为学生开发的非官方工具，与早稻田大学、Moodle Pty Ltd 及 Open LMS 无关。
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
| `promo-440x280.png` | 440×280 | — | Small promotional tile |
| `promo/promo-440x280-{ja,en,zh}.png` | 440×280 | Small promo tile, per language | — |
| `promo/marquee-1400x560-ja.png` | 1400×560 | Marquee promo tile (optional, all languages) | — |
| `screenshots/<locale>/*.png` | 1280×800 | Screenshots | Screenshots |

The PNGs in this folder are rendered from the SVG files of the same name with `node scripts/render-store-assets.mjs`;
the ones in `promo/` are rendered from HTML with the same icon and palette.
