# Reading Library

A personal, distraction-free reading app.

- **Hosting + API:** Netlify (free plan), deployed from this GitHub repo
- **Database:** a Google Sheet, reached through a Google Apps Script web app
- **AI sorting:** Google Gemini (free tier), one article at a time with a strict delay between calls
- **Reader:** pages are fetched and cleaned on demand with Mozilla Readability; the Sheet stores only metadata

```
apps-script/Code.gs      Sheet API (paste into the Sheet's Apps Script editor)
netlify/functions/       api.js (HTTP), process-queue.js (every 10 min), harvest.js (every 6 h)
netlify/lib/             shared code: Sheet client, Gemini queue, extractor, RSS harvester
public/                  the static app (setup.html works today; the reader UI comes next)
test/                    npm test
```

## 1. Google Sheet + Apps Script (one time)

1. Open your **Reading Library** sheet, then **Extensions → Apps Script**.
2. Replace the default code with `apps-script/Code.gs`.
3. Run **`setup`** once (approve the permission prompt). Copy the `API_TOKEN` printed in the execution log.
4. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Copy the `/exec` URL.

> If you later change `Code.gs`, use **Deploy → Manage deployments → Edit → New version**. The `/exec` URL stays the same.

## 2. GitHub

Create an empty repo (public or private both work with Netlify) and push this folder:

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## 3. Netlify

1. **Add new site → Import an existing project → GitHub**, pick the repo. The build settings come from `netlify.toml`; there is no build command.
2. **Site configuration → Environment variables**, add:

| Name | Value |
|---|---|
| `APPS_SCRIPT_URL` | the `/exec` URL from step 1 |
| `APPS_SCRIPT_TOKEN` | the `API_TOKEN` from step 1 |
| `GEMINI_API_KEY` | from <https://aistudio.google.com/apikey> |
| `APP_PASSPHRASE` | a long passphrase you will type into the app |
| `GEMINI_MODEL` | *(optional)* a model ID. Default `gemini-flash-lite-latest` (Flash-Lite has the biggest free quota). If a model is unavailable or its free quota for the day is used up, the app switches to another Flash model by itself |
| `CLASSIFY_BATCH` | *(optional)* articles sent to the AI in one request by the background job. Default 5, max 10. Free tiers count requests, so batching is what makes them last |
| `MANUAL_BATCH` | *(optional)* same, for the setup page buttons. Default 2, max 6 |
| `BACKUP_LLM_BASE_URL`, `BACKUP_LLM_API_KEY`, `BACKUP_LLM_MODEL` | *(optional, all three together)* a second AI used when Gemini is out of quota. Any OpenAI-compatible service works (Groq, Cerebras, Mistral, OpenRouter). It cannot read PDFs; those wait for Gemini |
| `BACKUP_LLM_DELAY_MS` | *(optional)* pause between backup calls. Default 2500 |
| `GEMINI_DELAY_MS` | *(optional)* gap between Gemini calls, default `4500` |
| `SEED_PER_FEED` | *(optional)* Day-0 items per feed, 7 to 10, default `8` |

3. **Trigger a deploy** (Deploys → Trigger deploy) so the variables take effect.
4. Open `https://<your-site>.netlify.app/setup.html`, enter the passphrase and:
   1. **Check connection**: Sheet and Gemini should both say `ok`.
   2. **Pull feeds now**: seeds 7 to 10 articles from each of Aeon, Noema, Works in Progress, Psyche and Nautilus.
   3. **Classify one article**: confirms Gemini sorting works end to end.

After that, the schedule does the rest: every 10 minutes it classifies 1 to 2 pending articles, and every 6 hours it looks for new posts. Scheduled functions run only on the **published production deploy**.

## How the free-tier limits are handled

- **Gemini:** calls go through one queue with at least `GEMINI_DELAY_MS` between them. HTTP 429 is retried with 5 s, 10 s, 20 s back-off (honouring Google's `retryDelay`); if the time budget runs out the article simply stays pending for the next run. A daily-quota error stops the run without wasting retries.
- **Netlify:** nothing runs long. Each scheduled run has a ~24 s budget (their cutoff is 30 s) and an idle run is about one Sheet call. The Sheet is the queue, so a crash loses nothing.
- **Stuck articles:** each article gets 5 attempts (`classify_attempts`), and the last problem is written to `last_error` in the Sheet.

## Security notes

- The browser only ever talks to `/api/*` on your own site, and every request needs your passphrase (`X-Passphrase`). The Apps Script URL and token and the Gemini key exist only as Netlify environment variables.
- Anyone who finds the raw Apps Script URL still cannot read or write without `APPS_SCRIPT_TOKEN`.
- Fetching article pages refuses localhost and private network addresses.
- Reader HTML is sanitised server-side (scripts, handlers, iframes, forms and styles removed).

## Development

```bash
npm install
npm test        # 50 tests: Code.gs against an in-memory Sheets fake, Gemini retries, RSS, extraction, API
```

## The reading app

Open your Netlify address, enter `APP_PASSPHRASE`, and you are in.

- **Library**: shelves by category, search, sort, To read / Finished / Archive. Tap ⋯ on a card to change status or category, save offline, or open the original.
- **Reader**: tap an article. It goes full screen (Esc or the back arrow to leave), the top bar hides as you scroll and returns when you scroll up or tap. **Aa** sets text size, typeface, width, spacing and theme.
- **Highlights**: select text, pick a colour (or the note icon). Tap a highlight to change colour, add a note or delete it. The list icon shows every highlight on the piece plus a notes box for the whole article.
- **Highlights page**: every highlight in one searchable place, filterable by colour, with copy-as-Markdown.
- **Dark mode**: the moon button, or Settings → Auto to follow your device.
- **Offline**: articles you open are kept on the device, as is the library list. Highlights and notes made offline are sent when you are back online.
- **Install it**: Chrome/Edge: Install app. iPhone: Share → Add to Home Screen (this also gives true full screen on iPhone). Android Chrome then lists it in the Share sheet, so you can send links straight to your library. On a laptop, drag the bookmarklet from Settings to your bookmarks bar.

### Try the interface without any setup

`npm install && npm run preview`, then open http://localhost:8888 (passphrase `demo`). It uses made-up articles.
