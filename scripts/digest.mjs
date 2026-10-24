// Daily scan → rank → deep-dive → markdown posts.
//
// LLM providers (see llm.mjs) are tried in the order set in config/digest.json:
//   claude: Claude Code CLI on your Pro/Max subscription (CLAUDE_CODE_OAUTH_TOKEN in CI)
//   gemini: Gemini API (GEMINI_API_KEY)
// Override for one run with LLM_PROVIDERS=gemini (or "gemini,claude").
//
//   node scripts/digest.mjs            full run
//   node scripts/digest.mjs --dry-run  scan feeds + print candidates, no Claude calls, no writes
//   node scripts/digest.mjs --max 1    cap posts for this run
import fs from "node:fs/promises";
import path from "node:path";
import { createLLM } from "./llm.mjs";
import { ROOT, POSTS_DIR, SEEN_FILE, LATEST_FILE, readJson, writeJson, fetchFeed, slugify, todayISO } from "./lib.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const cfg = await readJson(path.join(ROOT, "config/digest.json"), {});
const maxArg = process.argv.indexOf("--max");
if (maxArg !== -1) cfg.maxPostsPerDay = Number(process.argv[maxArg + 1]);
const { sources } = await readJson(path.join(ROOT, "config/sources.json"), { sources: [] });
const CATEGORIES = ["AI Research", "AI Engineering", "System Design", "Infrastructure", "Databases", "Data Storage", "Data Mobility", "Security"];

const llm = createLLM(cfg);
// ---------------------------------------------------------------- 1. scan
const seen = await readJson(SEEN_FILE, {});
const cutoff = Date.now() - cfg.lookbackHours * 3600_000;
const results = await Promise.all(sources.map(fetchFeed));
for (const r of results) if (!r.ok) console.warn(`[feed] ${r.source.name} failed: ${r.error}`);

const candidates = results
  .flatMap((r) => r.items)
  .filter((it) => it.url && it.title && !seen[it.url] && Date.parse(it.published) >= cutoff)
  .sort((a, b) => b.weight - a.weight || b.published.localeCompare(a.published))
  .slice(0, cfg.maxCandidates);

console.log(`[llm] providers: ${llm.providers.join(" -> ") || "none"}`);
console.log(`[scan] ${candidates.length} fresh candidates from ${results.filter((r) => r.ok).length}/${sources.length} feeds`);
if (DRY_RUN) {
  for (const c of candidates) console.log(`  - [${c.source}] ${c.title}\n    ${c.url}`);
  process.exit(0);
}
if (candidates.length === 0) {
  await writeJson(LATEST_FILE, { date: todayISO(), posts: [] });
  console.log("[done] nothing new today");
  process.exit(0);
}

// ---------------------------------------------------------------- 2. rank & select
const selectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["picks"],
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "importance", "category", "title", "summary", "tags", "why"],
        properties: {
          index: { type: "integer", description: "Index of the candidate in the provided list" },
          importance: { type: "integer", description: "1 (minor) to 5 (industry-shifting)" },
          category: {
            type: "string",
            enum: CATEGORIES,
            description: "Data Mobility = replication, migration, backup/recovery, DR, snapshots, cyber-recovery. Data Storage = storage systems and media (block/file/object, arrays, filesystems, SDS).",
          },
          title: { type: "string", description: "Clear, specific headline for our post (not clickbait, <= 90 chars)" },
          summary: { type: "string", description: "2-3 sentence plain-English TL;DR a busy engineer can read in 15 seconds" },
          tags: { type: "array", items: { type: "string" }, description: "3-5 lowercase topic tags, e.g. 'caching', 'llm-inference'" },
          why: { type: "string", description: "One sentence: why this is worth a reader's time today" },
        },
      },
    },
  },
};

const candidateList = candidates
  .map((c, i) => `[${i}] (${c.source}, ${c.kind}, ${c.published.slice(0, 10)}) ${c.title}\n    ${c.snippet}`)
  .join("\n");

const focus = cfg.focus;
const SELECT_SYSTEM =
  "You are the editor of a daily digest for software engineers covering AI, system design and data storage. " +
  "You pick only items with real technical substance: new architectures, research results, production " +
  "post-mortems, scaling lessons, notable model/tool/product releases with technical detail. Skip marketing, " +
  "event announcements, hiring posts, customer stories without engineering content, and near-duplicates " +
  "(if two items cover the same news, keep the more primary source). Vendor posts count when they explain how " +
  "something works (e.g. a replication engine, snapshot or dedupe internals, migration tooling, a recovery " +
  "architecture) or announce a significant capability with technical detail; skip vendor posts that are only positioning." +
  (focus ? ` ${focus.about}` : "");

const focusRule = focus
  ? ` Reserve up to ${focus.slots} of the picks for ${focus.categories.join(" / ")} items (the reader's specialty) when worthy ones exist; ` +
    `favour items about replication, migration, backup/recovery and DR. Do not pad these slots with weak items.`
  : "";

const selection = await llm.rank(
  {
    system: SELECT_SYSTEM,
    schema: selectionSchema,
    prompt:
      `Candidates published in the last ${cfg.lookbackHours} hours:\n\n${candidateList}\n\n` +
      `Pick up to ${cfg.maxPostsPerDay} items, most important first. Only include items with importance >= ${cfg.minImportance}. ` +
      `Returning fewer (or zero) picks is fine on a slow day.` +
      focusRule,
  },
  (out) => {
    if (!Array.isArray(out?.picks)) throw new Error("ranking output has no picks array");
    return out;
  },
);
console.log(`[rank] via ${selection.provider}`);
const picks = selection.value.picks
  .filter((p) => candidates[p.index] && p.importance >= cfg.minImportance)
  .slice(0, cfg.maxPostsPerDay);
console.log(`[rank] selected ${picks.length}: ${picks.map((p) => p.index).join(", ")}`);

// ---------------------------------------------------------------- 3. deep-dive per pick
const WRITER_SYSTEM = `You write deep-dive explainers for an engineering digest site. Readers are working software engineers, from mid-level to staff, who want to understand quickly and deeply.

First read the original article in full: it is either included below or you fetch it with your web tool (if it links to a paper or key companion post that is essential, you may fetch that too). Base every factual claim on what you read; if the source is thin, say so instead of inventing detail. Never fabricate numbers, quotes or benchmarks.

Then write the post body in GitHub-flavored Markdown using exactly these sections, in order:

## Key takeaways
3-5 bullets. Each bullet is one concrete, standalone insight.

## What happened
The news in plain English: who, what, and the headline result.

## Why it matters
The problem this addresses and who should care. Connect it to the wider industry trend.

## How it works
The technical core. Explain mechanisms step by step and define jargon the first time it appears. Where a diagram helps (data flow, request path, architecture, training pipeline), include one as a fenced \`\`\`mermaid block (flowchart or sequenceDiagram; keep node labels short and quote labels containing punctuation). Use a table when comparing options or numbers.

## Trade-offs and open questions
Costs, limits, failure modes, what's unproven, and how it compares with established alternatives.

## What you can apply
Concrete, practical lessons an engineer could use in their own systems or ML work. For storage, replication, migration, backup or DR topics, be specific about consistency and ordering guarantees, RPO/RTO, bandwidth and change-rate trade-offs, cutover and verification, and failure handling.

## Glossary
A short bullet list of key terms with one-line definitions.

Rules: Do not include a top-level # title, front matter, or a "Sources" section (the site adds those). Aim for a 6-10 minute read. Prefer short paragraphs, clear structure and concrete examples over hype. Output only the Markdown body, with no preamble before "## Key takeaways".`;

async function writeDeepDive(item, pick) {
  return llm.write(
    {
      system: WRITER_SYSTEM,
      url: item.url,
      prompt:
        `Write the deep-dive for this item.\n\nSource: ${item.source}\nOriginal title: ${item.title}\nURL: ${item.url}\n` +
        `Published: ${item.published}\nEditor's angle: ${pick.why}\nFeed snippet: ${item.snippet}`,
    },
    (md) => {
      // Drop any preamble before the first section; reject output that ignored the structure.
      const start = md.indexOf("## Key takeaways");
      if (start === -1) throw new Error("writer output missing '## Key takeaways' section");
      return md.slice(start).trim();
    },
  );
}

/** Pull the Key takeaways bullets into front matter (rendered as a highlight card), drop the section from the body. */
function splitTakeaways(md) {
  const m = md.match(/## Key takeaways\s*\n([\s\S]*?)(?=\n## )/);
  if (!m) return { takeaways: [], body: md };
  const takeaways = m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
  return { takeaways, body: md.replace(m[0], "").trim() };
}

const yamlStr = (s) => JSON.stringify(String(s)); // JSON strings are valid YAML scalars

const date = todayISO();
const written = [];
await fs.mkdir(POSTS_DIR, { recursive: true });

for (const pick of picks) {
  const item = candidates[pick.index];
  try {
    console.log(`[write] ${item.title}`);
    const draft = await writeDeepDive(item, pick);
    const { takeaways, body } = splitTakeaways(draft.value);
    const slug = `${date}-${slugify(pick.title)}`;
    const frontmatter = [
      "---",
      `title: ${yamlStr(pick.title)}`,
      `summary: ${yamlStr(pick.summary)}`,
      `date: ${date}`,
      `category: ${yamlStr(pick.category)}`,
      `tags: [${pick.tags.map((t) => yamlStr(slugify(t))).join(", ")}]`,
      `importance: ${pick.importance}`,
      `writer: ${yamlStr(draft.provider)}`,
      `source:`,
      `  name: ${yamlStr(item.source)}`,
      `  url: ${yamlStr(item.url)}`,
      `  title: ${yamlStr(item.title)}`,
      `  published: ${yamlStr(item.published)}`,
      `takeaways:`,
      ...takeaways.map((t) => `  - ${yamlStr(t)}`),
      "---",
      "",
    ].join("\n");
    await fs.writeFile(path.join(POSTS_DIR, `${slug}.md`), frontmatter + body + "\n");
    seen[item.url] = date;
    console.log(`[write]   done via ${draft.provider}`);
    written.push({ slug, title: pick.title, summary: pick.summary, category: pick.category, importance: pick.importance, source: item.source, sourceUrl: item.url });
  } catch (err) {
    // One bad article shouldn't sink the whole digest.
    console.error(`[write] failed for ${item.url}: ${err.message}`);
  }
}

// Mark every scanned candidate as seen so rejected items aren't re-ranked tomorrow.
for (const c of candidates) seen[c.url] ??= date;
// Keep the dedupe file bounded (~60 days).
const keepAfter = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
for (const [url, d] of Object.entries(seen)) if (d < keepAfter) delete seen[url];

await writeJson(SEEN_FILE, seen);
await writeJson(LATEST_FILE, { date, posts: written });
console.log(`[done] wrote ${written.length} post(s)`);
process.exit(0); // don't let lingering keep-alive sockets hold the CI job open
