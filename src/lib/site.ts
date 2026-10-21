import { getCollection, type CollectionEntry } from "astro:content";

export const SITE = {
  name: "The Signal",
  tagline: "AI, systems & storage, explained daily.",
  description:
    "A daily digest of the most important AI, system design and data storage news from trusted engineering sources, with clear deep-dive analysis.",
};

export type Post = CollectionEntry<"posts">;

/** Prefix a site-relative path with the configured base (needed for GitHub project pages). */
export const url = (path = "/") => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/${path.replace(/^\//, "")}`;
};

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const CATEGORY_TONE: Record<string, string> = {
  "AI Research": "violet",
  "AI Engineering": "indigo",
  "System Design": "sky",
  Infrastructure: "teal",
  Databases: "amber",
  "Data Storage": "orange",
  "Data Mobility": "emerald",
  Security: "rose",
};

export const readingMinutes = (body = "") => Math.max(1, Math.round(body.split(/\s+/).length / 220));

export const formatDate = (d: Date, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) =>
  d.toLocaleDateString("en-US", { timeZone: "UTC", ...opts });

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** All posts, newest first; within a day, most important first. */
export async function getPosts() {
  const posts = await getCollection("posts");
  return posts.sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime() || b.data.importance - a.data.importance,
  );
}

export function groupByDay(posts: Post[]) {
  const groups = new Map<string, Post[]>();
  for (const p of posts) {
    const k = dayKey(p.data.date);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.entries()];
}

/** Minimal inline markdown (`code`, **bold**) for plain-text front-matter fields. Escapes HTML first. */
export const inlineMd = (s: string) =>
  s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
