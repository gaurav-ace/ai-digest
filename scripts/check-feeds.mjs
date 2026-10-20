// Quick health check of every source in config/sources.json.
import path from "node:path";
import { ROOT, readJson, fetchFeed } from "./lib.mjs";

const { sources } = await readJson(path.join(ROOT, "config/sources.json"), { sources: [] });
const results = await Promise.all(sources.map(fetchFeed));
for (const r of results) {
  const newest = r.items.map((i) => i.published).sort().at(-1)?.slice(0, 10) ?? "-";
  console.log(`${r.ok ? "OK  " : "FAIL"}  ${r.source.name.padEnd(28)} items=${String(r.items.length).padStart(3)} newest=${newest}${r.ok ? "" : "  " + r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} feeds healthy`);
