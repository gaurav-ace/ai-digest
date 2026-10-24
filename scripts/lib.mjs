import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const POSTS_DIR = path.join(ROOT, "src/content/posts");
export const SEEN_FILE = path.join(ROOT, "data/seen.json");
export const LATEST_FILE = path.join(ROOT, "data/latest-digest.json");

export const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

export const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");

const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": "ai-sys-design-digest/0.1 (+https://github.com)" },
});

/** Fetch one feed; never throws — a dead feed shouldn't kill the daily run. */
export async function fetchFeed(source) {
  try {
    const feed = await withTimeout(parser.parseURL(source.url), 30_000, `feed timed out after 30s`);
    return {
      source,
      ok: true,
      items: (feed.items ?? []).map((it) => ({
        source: source.name,
        kind: source.kind,
        weight: source.weight ?? 1,
        title: (it.title ?? "").trim(),
        url: it.link ?? it.guid ?? "",
        published: new Date(it.isoDate ?? it.pubDate ?? 0).toISOString(),
        snippet: stripHtml(it.contentSnippet ?? it.summary ?? it.content ?? "").slice(0, 500),
      })),
    };
  } catch (err) {
    return { source, ok: false, error: String(err.message ?? err), items: [] };
  }
}

/** Reject if `promise` hasn't settled within `ms` — no network call may stall the daily run. */
export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms))),
  ]).finally(() => clearTimeout(timer));
}

export const stripHtml = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export const slugify = (s) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 70).replace(/-+$/, "");

// The digest's "day" is the reader's day (IST): runs start around 01:45 IST, when the UTC date is still yesterday.
export const DIGEST_TZ = "Asia/Kolkata";
export const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: DIGEST_TZ }); // YYYY-MM-DD
