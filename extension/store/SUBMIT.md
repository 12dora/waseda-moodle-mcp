# Submitting the extension

Publish to both stores. Dashboard labels, limits and review times below can change; if a screen differs, follow the
screen and use the same text.

## Values used by both stores

| Name | Value |
|---|---|
| Publisher name | `12dora` |
| Chrome contact email | `<contact email you set>` — a dedicated address, never a personal one |
| Edge support contact | `https://github.com/12dora/waseda-moodle-mcp/issues` |
| Homepage / website | `https://github.com/12dora/waseda-moodle-mcp` |
| Privacy policy URL | `<service URL>/privacy` |
| Package | `dist/extension-<version>.zip` (version from `manifest.json`) |

`<service URL>` is the public origin (`PUBLIC_URL`) of the instance you publish with, without a trailing slash.

## Before you start

1. Create the dedicated contact address. Use it for both store developer accounts.
2. Deploy the server from the same revision as the extension. An older server does not accept the session.
3. Build the console with `VITE_CONTACT_URL=https://github.com/12dora/waseda-moodle-mcp/issues`, so the privacy page
   shows a contact. Deploy it.
4. Open `<service URL>/privacy?lang=en` in a private window. It must load without sign-in and contain the "Browser
   extension" section.
5. Check that the GitHub repository is public, Issues are enabled and `main` contains the code you are submitting.
6. Run `pnpm pack:ext`. In the zip, `manifest.json` is at the root; there are no test files and no `store/` folder.
7. Test the unpacked zip in Chrome and in Edge: connect while signed in, connect while signed out, sign out and in
   again.
8. Capture the images listed in [screenshots.md](screenshots.md).

## Chrome Web Store

### Register (once)

1. Create a Google account on the dedicated address and turn on 2-Step Verification. The developer account's address
   cannot be changed later.
2. Open `https://chrome.google.com/webstore/devconsole`, accept the developer agreement and pay the one-time
   registration fee (US$5).
3. **Account** page: Publisher name `12dora`; Contact email `<contact email you set>`, then confirm the verification
   mail. The contact email is shown publicly.
4. Trader declaration: choose **Non-trader** if you publish outside any trade or business (free, personal open-source
   project). A trader must publish contact details, including an address.

### Create the item

1. **Add new item** → upload the zip.
2. **Store listing** tab:

| Field | Enter |
|---|---|
| Title, Summary | Read from the package; check they match [listing.md](listing.md) |
| Description | English block in listing.md |
| Category | Productivity → Education |
| Language | English |
| Store icon | `extension/store/icon-128.png` |
| Screenshots | `extension/store/screenshots/en/`, in file-name order |
| Small promo tile | `extension/store/promo-440x280.png` |
| Marquee tile, promo video | Leave empty |
| Homepage URL | Homepage value above |
| Support URL | Issues URL above |
| Official URL, Mature content | None / No |

   Then pick Japanese and Chinese (China) in the language selector and paste their descriptions (and screenshots, if
   captured).

3. **Privacy** tab, from [permissions.md](permissions.md):

| Field | Enter |
|---|---|
| Single purpose | "Single purpose" block |
| Justification: cookies, storage, alarms | Matching table rows |
| Host permission justification | The combined host block |
| Remote code | No, I am not using remote code |
| Data usage | Tick Authentication information only |
| Certifications | Tick all three |
| Privacy policy URL | `<service URL>/privacy` |

4. **Distribution** tab: Free; Visibility Public (choose Unlisted for a trial run); all regions.
5. **Test instructions** tab: leave user name and password empty; paste [note A](#note-a--chrome-test-instructions).
6. **Submit for review**. Untick automatic publishing if you want to choose the release time. Review usually takes a
   few days; the optional broad host permission can make it longer.

## Microsoft Edge Add-ons

### Register (once)

1. Create a Microsoft account on the dedicated address.
2. Open `https://partner.microsoft.com/dashboard/microsoftedge/overview` and register for the Microsoft Edge program.
   There is no registration fee.
3. Account type **Individual**; Publisher display name `12dora`. Fill the contact details Microsoft requires, with the
   dedicated address as email. Accept the agreement. Verification can take some time.

### Create the extension

1. **Create new extension** → upload the same zip.
2. **Availability**: Visibility Public; all markets.
3. **Properties**:

| Field | Enter |
|---|---|
| Category | Productivity |
| Accesses, collects or transmits personal information | Yes |
| Privacy policy URL | `<service URL>/privacy` |
| Website URL | Homepage value above |
| Support contact | `https://github.com/12dora/waseda-moodle-mcp/issues` |
| Mature content | No |

4. **Privacy** (if shown as its own page): answers from [permissions.md](permissions.md), as for Chrome.
5. **Store listings**, for English, Japanese and Chinese (Simplified):

| Field | Enter |
|---|---|
| Display name, Short description | Read from the package |
| Description | That language's block in listing.md (250–10,000 characters) |
| Extension logo | `extension/store/logo-300.png` |
| Small promotional tile | `extension/store/promo-440x280.png` |
| Large promotional tile, video | Leave empty |
| Screenshots | That language's folder, or `en` |
| Search terms | listing.md, "Search terms" |

6. **Publish** → in **Notes for certification** paste [note B](#note-b--edge-notes-for-certification) → submit. Review
   can take up to seven business days.

## Review notes

Reviewers cannot sign in: Waseda Moodle accepts university accounts only, and no demo account can be issued. The notes
give them a check without an account and point to the source.

### Note A — Chrome test instructions

Limit: 500 characters.

```text
No test account: Waseda Moodle accepts university sign-in only. To check: in Settings enter https://example.com, tick consent, Save, allow access. In the popup click Connect: the Moodle sign-in page opens and nothing is sent to the service while signed out. After sign-in, the MoodleSession cookie goes only to that URL; cookie again on new sign-ins and every 12 h. Source: https://github.com/12dora/waseda-moodle-mcp/tree/main/extension
```

### Note B — Edge notes for certification

Limit: 2,000 characters.

```text
Test account: none can be provided. The extension works with Waseda University's Moodle (https://wsdmoodle.waseda.jp), which accepts university accounts only.

Check without an account:
1. Install. The Settings page opens and the toolbar badge shows "!".
2. Enter https://example.com as Service URL. Saving without the consent box is refused. Tick it, click Save and allow access: only that origin is requested.
3. Open the popup: Moodle shows "Not signed in".
4. Click Connect. The Moodle sign-in page opens in a tab. Nothing is sent to the service URL while signed out (see the service worker's network log). Close the tab to end the wait.
5. Untick consent and Save to withdraw it.

With a Waseda account: after sign-in the extension reads the MoodleSession cookie, posts it to <service URL>/api/connect/handoff and opens <service URL>/connect to finish linking the account. After a new Moodle sign-in, every 12 hours and on "Sync now", it posts the cookie to <service URL>/api/extension/refresh. Nothing is sent anywhere else.

Permissions: cookies reads that one cookie, only after consent; storage keeps the URL, consent and last result; alarms runs the 12-hour sync; the optional https://*/* permission exists because the user types the service address, and only that origin is requested.

Source (the package is this folder, unminified, no build step, no remote code): https://github.com/12dora/waseda-moodle-mcp/tree/main/extension
Key files: background.js, lib/session.js, lib/consent.js.

Unofficial; not affiliated with Waseda University.
```

## After approval

1. Copy the public listing URL.
2. Set `EXTENSION_URL` on the deployment to it and redeploy; the connect page then recommends the extension. The
   setting holds one URL, so choose one listing (Chrome's is the usual choice).
3. Install from each store once and connect.

For an update: raise `version` in `manifest.json`, run `pnpm pack:ext`, upload the new zip in both dashboards and
submit. If data handling or permissions changed, first update the privacy page and these files.

## If a review is rejected

| Reason given | Response |
|---|---|
| Cannot test the functionality | Resubmit with the note above. If asked again, attach a link to a short screen recording of a connect, made with demo data and without showing cookie values. |
| Broad host permission | It is optional and never granted at install; one user-typed origin is requested on Save (`options.js`). |
| Trademark or impersonation ("Waseda", "Moodle") | Point to the "Unofficial / not affiliated" statement in the summary and description. If the store still refuses, rename the extension in `_locales`, the icons and promo tile as needed, and upload a new version. |
| Privacy policy | Check that the URL opens without sign-in and names the extension, the data, the destination and Limited Use. |
