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

// One compact card for the whole day: a coloured marker per category, linked headline,
// then category · source · importance. Most important stories first.
const MARKERS = {
  "AI Research": "🟪",
  "AI Engineering": "🟦",
  "System Design": "🔷",
  Infrastructure: "🟫",
  Databases: "🟨",
  "Data Storage": "🟧",
  "Data Mobility": "🟩",
  Security: "🟥",
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const meter = (n) => "▰".repeat(n) + "▱".repeat(5 - n);
// Keep link text from breaking markdown.
const linkText = (s) => s.replace(/[\[\]]/g, "");

const day = new Date(date).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
const items = [...posts].sort((a, b) => b.importance - a.importance).slice(0, 12);
const lines = items.map((p) => {
  const href = siteUrl ? `${siteUrl}/posts/${p.slug}/` : p.sourceUrl;
  return (
    `${MARKERS[p.category] ?? "⬜"} **[${linkText(clip(p.title, 95))}](${href})**\n` +
    `${p.category} · ${p.source} · \`${meter(p.importance)}\``
  );
});

const payload = {
  username: "The Signal",
  embeds: [
    {
      title: `📡 Daily digest · ${day}`,
      ...(siteUrl && { url: `${siteUrl}/` }),
      description: lines.join("\n\n"),
      color: 0x4f46e5,
      footer: { text: `${posts.length} deep-dive${posts.length > 1 ? "s" : ""} · AI, systems & storage${siteUrl ? " · tap a headline to read" : ""}` },
    },
  ],
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
