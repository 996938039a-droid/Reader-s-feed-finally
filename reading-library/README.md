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
| `GEMINI_MODEL` | *(optional)* a model ID. Default `gemini-flash-latest`; if it is unavailable the app lists your models and switches to a current Flash model by itself |
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
