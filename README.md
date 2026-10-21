# The Signal: daily AI & system design digest

A static site that scans trusted AI and engineering sources every day, picks the stories that matter, and publishes clear deep-dive explainers. A summary of each day's posts goes to a Discord channel.

```
GitHub Actions (daily, 06:45 IST / 01:15 UTC; Discord summary ~07:00 IST)
  └─ scripts/digest.mjs
       1. Scan    ~24 RSS feeds (config/sources.json), last 36h, skip already-seen URLs
       2. Rank    Claude picks up to 4 items with real technical substance (structured JSON)
       3. Write   Claude reads each full article (WebFetch) and writes a structured deep-dive
       4. Save    Markdown files go to src/content/posts/, committed to the repo
  └─ astro build → GitHub Pages
  └─ scripts/notify-discord.mjs → Discord webhook (runs after deploy, so links work)
```

## One-time setup

1. **Push this folder to a new GitHub repo**, with `main` as the default branch.
2. **Turn on Pages:** Settings → Pages → Source: **GitHub Actions**.
3. **Add repository secrets** under Settings → Secrets and variables → Actions:
   - `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` on your machine and paste the token it prints. This uses your Claude Pro/Max subscription, so no API key is needed.
   - `DISCORD_WEBHOOK_URL`: in Discord, go to Channel settings → Integrations → Webhooks → New Webhook → Copy URL.
4. **Run it once by hand:** Actions → *Daily digest* → **Run workflow**. After that it runs every day.

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

## Notes

- **How Claude runs:** the pipeline calls the Claude Code CLI (`claude -p`), so it runs on your Claude subscription. Each run is one ranking call plus one writing session per post (about a minute each with Sonnet). This counts toward your plan's usage limits. If you hit them, lower `maxPostsPerDay`.
- **Model:** the default is `sonnet`. You can set `"model": "opus"` in `config/digest.json` if your plan includes it.
- **Accuracy:** posts are AI-written from the original source and always link back to it. The writer is told not to invent numbers and to say when a source is thin. You can still review posts in the repo, and revert any commit.
- **Dedupe:** `data/seen.json` tracks scanned URLs for 60 days, so stories aren't repeated.
