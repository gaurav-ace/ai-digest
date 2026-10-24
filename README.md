# The Signal: daily AI & system design digest

A static site that scans trusted AI and engineering sources every day, picks the stories that matter, and publishes clear deep-dive explainers. A summary of each day's posts goes to a Discord channel.

```
cron-job.org at 06:45 IST → GitHub Actions (GitHub's own cron is a late fallback; Discord summary ~07:00 IST)
  └─ scripts/digest.mjs
       1. Scan    ~24 RSS feeds (config/sources.json), last 36h, skip already-seen URLs
       2. Rank    the AI picks up to 4 items with real technical substance (structured JSON)
       3. Write   the AI reads each full article and writes a structured deep-dive
                  (Claude first, Gemini as automatic backup; see "AI providers" below)
       4. Save    Markdown files go to src/content/posts/, committed to the repo
  └─ astro build → GitHub Pages
  └─ scripts/notify-discord.mjs → Discord webhook (runs after deploy, so links work)
```

## One-time setup

1. **Push this folder to a new GitHub repo**, with `main` as the default branch.
2. **Turn on Pages:** Settings → Pages → Source: **GitHub Actions**.
3. **Add repository secrets** under Settings → Secrets and variables → Actions:
   - `CLAUDE_CODE_OAUTH_TOKEN` (optional): run `claude setup-token` and paste the token as one line. This uses your Claude Pro/Max subscription.
   - `GEMINI_API_KEY` (optional): from https://aistudio.google.com/apikey.
   - At least one of the two is required. With both, Claude is used first and Gemini is the backup.
   - `DISCORD_WEBHOOK_URL`: in Discord, go to Channel settings → Integrations → Webhooks → New Webhook → Copy URL.
4. **Run it once by hand:** Actions → *Daily digest* → **Run workflow**. After that it runs every day.

### On-time daily trigger (recommended)

GitHub's built-in scheduler is best-effort. It was observed starting this workflow about 5 hours late at 06:45 IST. An external scheduler starts it on time:

1. **Create a GitHub token:** Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate. Set *Repository access* to **Only select repositories → ai-digest**, and *Permissions → Repository → Actions* to **Read and write**. Pick the longest expiry and set a reminder to renew it.
2. **Create a job on [cron-job.org](https://cron-job.org)** (free):
   - URL: `https://api.github.com/repos/gaurav-ace/ai-digest/actions/workflows/daily-digest.yml/dispatches`
   - Schedule: every day at **06:45**, time zone **Asia/Kolkata**
   - Advanced → Request method: **POST**
   - Headers: `Authorization: Bearer <your token>`, `Accept: application/vnd.github+json`, `Content-Type: application/json`
   - Request body: `{"ref":"main","inputs":{"scheduled":"true"}}`
3. Click **Test run**. A `204` response means GitHub accepted it, and a run appears under Actions.

If the external call ever fails, GitHub's own (late) cron still runs the digest the same day. The `gate` job makes sure only the first trigger of the day does any work.

The site URL and base path are detected automatically for GitHub Pages. For a custom domain, add `public/CNAME`.

## Local development

```bash
npm install
npm run dev            # http://localhost:4321
npm run feeds:check    # health-check every source
npm run digest:dry     # scan feeds and list today's candidates (no API calls, no writes)
npm run digest         # real run with your logged-in Claude Code (add `-- --max 1` for a quick test)
```

## Customising

| What | Where |
|---|---|
| Sources | `config/sources.json` (`weight: 2` = preferred) |
| Posts per day, lookback, model | `config/digest.json` |
| Editorial voice and post structure | `WRITER_SYSTEM` and the selection prompt in `scripts/digest.mjs` |
| Categories | `CATEGORIES` in both `scripts/digest.mjs` and `src/content.config.ts` |
| Site name and tagline | `src/lib/site.ts` |
| Colours and typography | tokens at the top of `src/styles/global.css` |
| Schedule | `cron` in `.github/workflows/daily-digest.yml` |

The three `sample-*` posts in `src/content/posts/` show the format. Delete them once real posts arrive.

## AI providers

Set in `config/digest.json` → `"providers": ["claude", "gemini"]`. They are tried in order, and any provider without credentials is skipped. If a provider fails during a run (expired token, usage limit, outage), the rest of that run uses the next one. Each post records which model wrote it.

| Provider | Credential | How it runs | Models (`config/digest.json`) |
|---|---|---|---|
| `claude` | `CLAUDE_CODE_OAUTH_TOKEN` (or your local `claude` login) | Claude Code CLI (`claude -p`) on your Pro/Max subscription, counts toward plan limits | `claude.model`: `sonnet` (or `opus`) |
| `gemini` | `GEMINI_API_KEY` | Gemini API; the article text is fetched and passed in | `gemini-flash-latest` to rank, `gemini-pro-latest` to write, flash as fallback |

- **Stop using Claude:** delete the `CLAUDE_CODE_OAUTH_TOKEN` secret. Nothing else changes.
- **Make Gemini primary:** set `"providers": ["gemini", "claude"]`.
- **One-off local run with a specific provider:** `LLM_PROVIDERS=gemini GEMINI_API_KEY=... npm run digest -- --max 1`.
- On the Gemini free tier, Google may use your prompts to improve its products. That's fine for public blog posts, but worth knowing.

## Notes
- **Accuracy:** posts are AI-written from the original source and always link back to it. The writer is told not to invent numbers and to say when a source is thin. You can still review posts in the repo, and revert any commit.
- **Dedupe:** `data/seen.json` tracks scanned URLs for 60 days, so stories aren't repeated.
