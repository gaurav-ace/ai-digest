// Posts today's digest summary to a Discord channel via webhook.
// Env: DISCORD_WEBHOOK_URL (required), SITE_URL (e.g. https://you.github.io/ai-digest)
import { LATEST_FILE, readJson } from "./lib.mjs";

const webhook = process.env.DISCORD_WEBHOOK_URL;
const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "");
if (!webhook) {
  console.log("[discord] DISCORD_WEBHOOK_URL not set, skipping");
  process.exit(0);
}

const { date, posts = [] } = await readJson(LATEST_FILE, {});
if (posts.length === 0) {
  console.log("[discord] no new posts today, skipping");
  process.exit(0);
}

const COLORS = {
  "AI Research": 0x8b5cf6,
  "AI Engineering": 0x6366f1,
  "System Design": 0x0ea5e9,
  Infrastructure: 0x14b8a6,
  Databases: 0xf59e0b,
  "Data Storage": 0xf97316,
  "Data Mobility": 0x10b981,
  Security: 0xef4444,
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const stars = (n) => "●".repeat(n) + "○".repeat(5 - n);

const payload = {
  username: "The Signal",
  content: `## 📡 Daily digest · ${new Date(date).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}\n` +
    `${posts.length} new deep-dive${posts.length > 1 ? "s" : ""} on AI, system design & storage${siteUrl ? ` · [open the site](${siteUrl}/)` : ""}`,
  embeds: posts.slice(0, 10).map((p) => ({
    title: clip(p.title, 256),
    url: siteUrl ? `${siteUrl}/posts/${p.slug}/` : p.sourceUrl,
    description: clip(p.summary, 400),
    color: COLORS[p.category] ?? 0x64748b,
    fields: [
      { name: "Category", value: p.category, inline: true },
      { name: "Importance", value: stars(p.importance), inline: true },
      { name: "Source", value: `[${p.source}](${p.sourceUrl})`, inline: true },
    ],
  })),
  allowed_mentions: { parse: [] },
};

const res = await fetch(webhook, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
if (!res.ok) {
  console.error(`[discord] ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`[discord] posted ${posts.length} item(s)`);
