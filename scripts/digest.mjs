// Daily scan → rank → deep-dive → markdown posts.
//
// Claude runs through the Claude Code CLI (`claude -p`), so it works with a Claude Pro/Max
// subscription: locally after `claude` login, in CI via CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`).
//
//   node scripts/digest.mjs            full run
//   node scripts/digest.mjs --dry-run  scan feeds + print candidates, no Claude calls, no writes
//   node scripts/digest.mjs --max 1    cap posts for this run
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, POSTS_DIR, SEEN_FILE, LATEST_FILE, readJson, writeJson, fetchFeed, slugify, todayISO } from "./lib.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const cfg = await readJson(path.join(ROOT, "config/digest.json"), {});
const maxArg = process.argv.indexOf("--max");
if (maxArg !== -1) cfg.maxPostsPerDay = Number(process.argv[maxArg + 1]);
const { sources } = await readJson(path.join(ROOT, "config/sources.json"), { sources: [] });
const CATEGORIES = ["AI Research", "AI Engineering", "System Design", "Infrastructure", "Databases", "Security"];

/** Run one headless Claude Code turn; resolves with the parsed `--output-format json` result. */
function claude(prompt, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", "--model", cfg.model, "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", ...args],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      try {
        const res = JSON.parse(out);
        if (res.is_error || res.subtype !== "success") {
          const msg = String(res.result ?? res.subtype);
          const hint = /401|authenticat|bearer/i.test(msg)
            ? " (check the CLAUDE_CODE_OAUTH_TOKEN secret: regenerate with `claude setup-token` and paste it as a single line)"
            : "";
          return reject(new Error(`Claude call failed: ${msg}${hint}`));
        }
        resolve(res);
      } catch {
        reject(new Error(`claude exited ${code}: ${out.slice(0, 500)}`));
      }
    });
    proc.stdin.end(prompt); // prompt via stdin: no argv length limits
  });
}

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
          category: { type: "string", enum: CATEGORIES },
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
  .map((c, i) => `[${i}] (${c.source}, ${c.published.slice(0, 10)}) ${c.title}\n    ${c.snippet}`)
  .join("\n");

const SELECT_SYSTEM =
  "You are the editor of a daily digest for software engineers covering AI and system design. " +
  "You pick only items with real technical substance: new architectures, research results, production " +
  "post-mortems, scaling lessons, notable model/tool releases with technical detail. Skip marketing, " +
  "event announcements, hiring posts, customer stories without engineering content, and near-duplicates " +
  "(if two items cover the same news, keep the more primary source).";

const selection = await claude(
  `Candidates published in the last ${cfg.lookbackHours} hours:\n\n${candidateList}\n\n` +
    `Pick up to ${cfg.maxPostsPerDay} items, most important first. Only include items with importance >= ${cfg.minImportance}. ` +
    `Returning fewer (or zero) picks is fine on a slow day.`,
  ["--system-prompt", SELECT_SYSTEM, "--tools", "", "--json-schema", JSON.stringify(selectionSchema)],
);
const picks = (selection.structured_output?.picks ?? [])
  .filter((p) => candidates[p.index] && p.importance >= cfg.minImportance)
  .slice(0, cfg.maxPostsPerDay);
console.log(`[rank] selected ${picks.length}: ${picks.map((p) => p.index).join(", ")}`);

// ---------------------------------------------------------------- 3. deep-dive per pick
const WRITER_SYSTEM = `You write deep-dive explainers for an engineering digest site. Readers are working software engineers, from mid-level to staff, who want to understand quickly and deeply.

First use the WebFetch tool to read the original article in full. If it links to a paper or a key companion post that is essential, you may fetch that too. Base every factual claim on what you read; if the source is thin, say so instead of inventing detail. Never fabricate numbers, quotes or benchmarks.

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
Concrete, practical lessons an engineer could use in their own systems or ML work.

## Glossary
A short bullet list of key terms with one-line definitions.

Rules: Do not include a top-level # title, front matter, or a "Sources" section (the site adds those). Aim for a 6-10 minute read. Prefer short paragraphs, clear structure and concrete examples over hype. Output only the Markdown body, with no preamble before "## Key takeaways".`;

async function writeDeepDive(item, pick) {
  const res = await claude(
    `Write the deep-dive for this item.\n\nSource: ${item.source}\nOriginal title: ${item.title}\nURL: ${item.url}\n` +
      `Published: ${item.published}\nEditor's angle: ${pick.why}\nFeed snippet: ${item.snippet}`,
    [
      "--system-prompt", WRITER_SYSTEM,
      "--tools", "WebFetch",
      "--allowedTools", "WebFetch",
      "--permission-mode", "dontAsk",
      "--max-turns", "10",
    ],
  );
  // `result` is the final assistant message; drop any preamble before the first section.
  const body = String(res.result ?? "").trim();
  const start = body.indexOf("## Key takeaways");
  if (start === -1) throw new Error("writer output missing '## Key takeaways' section");
  return body.slice(start);
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
    const { takeaways, body } = splitTakeaways(await writeDeepDive(item, pick));
    const slug = `${date}-${slugify(pick.title)}`;
    const frontmatter = [
      "---",
      `title: ${yamlStr(pick.title)}`,
      `summary: ${yamlStr(pick.summary)}`,
      `date: ${date}`,
      `category: ${yamlStr(pick.category)}`,
      `tags: [${pick.tags.map((t) => yamlStr(slugify(t))).join(", ")}]`,
      `importance: ${pick.importance}`,
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
