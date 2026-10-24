// Writes the next unwritten lessons from config/curriculum.json into src/content/guides/.
//
//   node scripts/guide.mjs              write the next 2 lessons
//   node scripts/guide.mjs --max 4      write the next 4
//   node scripts/guide.mjs --slug what-is-rag   (re)write one specific lesson
//   node scripts/guide.mjs --weekly     CI mode: only acts on Sundays (IST)
//
// Lessons are picked round-robin across tracks (lesson 1 of every track, then lesson 2, ...),
// so every track gets started early. Uses the same providers as the digest (scripts/llm.mjs).
import fs from "node:fs/promises";
import path from "node:path";
import { createLLM } from "./llm.mjs";
import { ROOT, LATEST_FILE, DIGEST_TZ, readJson, writeJson, todayISO } from "./lib.mjs";

const GUIDES_DIR = path.join(ROOT, "src/content/guides");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

if (process.argv.includes("--weekly")) {
  const weekday = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: DIGEST_TZ });
  if (weekday !== "Sunday") {
    console.log(`[guide] weekly mode: today is ${weekday} (IST), lessons are written on Sundays`);
    process.exit(0);
  }
}

const cfg = await readJson(path.join(ROOT, "config/digest.json"), {});
const { tracks } = await readJson(path.join(ROOT, "config/curriculum.json"), { tracks: [] });
await fs.mkdir(GUIDES_DIR, { recursive: true });
const written = new Set((await fs.readdir(GUIDES_DIR)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));

// Round-robin order: [t1.l1, t2.l1, t3.l1, ..., t1.l2, t2.l2, ...]
const queue = [];
for (let i = 0; i < Math.max(...tracks.map((t) => t.lessons.length)); i++) {
  for (const track of tracks) if (track.lessons[i]) queue.push({ track, lesson: track.lessons[i], order: i + 1 });
}

const onlySlug = arg("--slug");
const todo = onlySlug
  ? queue.filter((q) => q.lesson.slug === onlySlug)
  : queue.filter((q) => !written.has(q.lesson.slug)).slice(0, Number(arg("--max") ?? 2));
if (todo.length === 0) {
  console.log(onlySlug ? `[guide] no lesson with slug "${onlySlug}"` : "[guide] curriculum complete, nothing to write");
  process.exit(0);
}

const llm = createLLM(cfg);
console.log(`[guide] providers: ${llm.providers.join(" -> ") || "none"}`);

const SYSTEM = `You write lessons for the "Learn" section of an engineering site. Readers are working software engineers who want a solid, practical understanding of AI concepts. Many work on data infrastructure (storage, replication, migration, backup), so analogies from distributed systems and storage are welcome where they genuinely fit.

Write the lesson body in GitHub-flavored Markdown using exactly these sections, in order:

## Key ideas
3-5 bullets. Each is one standalone sentence a reader should remember.

## The big idea
The concept in plain English in 2-4 short paragraphs, with one good analogy.

## Why it matters
What problem this solves, where engineers meet it in practice, and what goes wrong without it.

## How it works
The mechanism step by step. Define every term the first time it appears. Include at least one diagram as a fenced \`\`\`mermaid block (flowchart or sequenceDiagram; short node labels; quote labels containing punctuation). Use tables for comparisons and small, correct code or pseudocode where it clarifies. Use ### subsections for distinct parts.

## A worked example
One concrete, realistic scenario walked through end to end, with numbers where useful (sizes, latencies, costs) and the arithmetic shown.

## Common pitfalls and misconceptions
Bulleted: what people get wrong and what to do instead.

## How it connects
How this relates to the other lessons in the track and to real systems engineers build.

## Check your understanding
3-5 questions that test understanding, not recall. Format each as:
**1. Question text?**
<details><summary>Show answer</summary>

Answer in 2-4 sentences.

</details>

## Further reading
3-6 links to authoritative sources: original papers, official documentation, well-known engineering write-ups. Use your search tool and include only links you have confirmed exist, with a one-line note on each. Prefer primary sources.

Rules: be accurate; where something is debated or changing fast, say so instead of overstating. No top-level # title and no front matter (the site adds those). Aim for a 10-15 minute read with short paragraphs. Output only the Markdown body, starting with "## Key ideas".`;

const REQUIRED = ["## Key ideas", "## The big idea", "## How it works", "## Check your understanding"];
const yamlStr = (s) => JSON.stringify(String(s));
const newGuides = [];

for (const { track, lesson, order } of todo) {
  console.log(`[guide] writing ${track.title} ${order}/${track.lessons.length}: ${lesson.title}`);
  // Only link to lessons that exist (or are being written in this run), so links never 404.
  const linkable = track.lessons
    .filter((l) => l.slug !== lesson.slug && (written.has(l.slug) || todo.some((q) => q.lesson.slug === l.slug)))
    .map((l) => `- ${l.title}: link as [${l.title}](../${l.slug}/)`);
  const prompt =
    `Track: ${track.title} (${track.description})\n` +
    `This lesson: ${order} of ${track.lessons.length}, level ${lesson.level}\n` +
    `Title: ${lesson.title}\nSummary: ${lesson.summary}\nMust cover: ${lesson.covers}\n\n` +
    `Full track outline (stay within this lesson's scope; refer to others instead of re-teaching them):\n` +
    track.lessons.map((l, i) => `${i + 1}. ${l.title}`).join("\n") +
    (linkable.length ? `\n\nLessons you may link to with relative links:\n${linkable.join("\n")}` : "");

  try {
    const draft = await llm.teach({ system: SYSTEM, prompt }, (md) => {
      const start = md.indexOf("## Key ideas");
      const body = start === -1 ? md : md.slice(start);
      const missing = REQUIRED.filter((h) => !body.includes(h));
      if (missing.length) throw Object.assign(new Error(`lesson missing sections: ${missing.join(", ")}`), { output: true });
      return body.trim();
    });

    // Key ideas go to front matter (rendered as a highlight card); the body starts at "The big idea".
    const m = draft.value.match(/## Key ideas\s*\n([\s\S]*?)(?=\n## )/);
    const keyIdeas = (m?.[1] ?? "").split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
    const body = m ? draft.value.replace(m[0], "").trim() : draft.value;

    const frontmatter = [
      "---",
      `title: ${yamlStr(lesson.title)}`,
      `summary: ${yamlStr(lesson.summary)}`,
      `track: ${yamlStr(track.id)}`,
      `order: ${order}`,
      `level: ${yamlStr(lesson.level)}`,
      `tags: [${lesson.tags.map(yamlStr).join(", ")}]`,
      `updated: ${todayISO()}`,
      `writer: ${yamlStr(draft.provider)}`,
      `keyIdeas:`,
      ...keyIdeas.map((k) => `  - ${yamlStr(k)}`),
      "---",
      "",
    ].join("\n");
    await fs.writeFile(path.join(GUIDES_DIR, `${lesson.slug}.md`), frontmatter + body + "\n");
    written.add(lesson.slug);
    newGuides.push({ slug: lesson.slug, title: lesson.title, track: track.title });
    console.log(`[guide]   done via ${draft.provider}`);
  } catch (err) {
    console.error(`[guide] failed for ${lesson.slug}: ${err.message}`);
  }
}

// Let the Discord summary announce new lessons alongside today's digest.
if (newGuides.length && process.argv.includes("--weekly")) {
  const latest = await readJson(LATEST_FILE, {});
  const base = latest.date === todayISO() ? latest : { date: todayISO(), posts: [] };
  await writeJson(LATEST_FILE, { ...base, guides: [...(base.guides ?? []), ...newGuides] });
}
console.log(`[guide] wrote ${newGuides.length} lesson(s)`);
process.exit(0);
