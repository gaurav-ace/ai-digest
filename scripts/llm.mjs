// LLM providers for the digest. Each provider implements:
//   rank({ system, prompt, schema }) -> parsed JSON object
//   write({ system, prompt, url })   -> markdown string
// Providers are tried in the configured order; a provider that fails is skipped for the rest of
// the run (auth errors, usage limits and outages tend to persist), so the next one takes over.
import { spawn } from "node:child_process";
import { GoogleGenAI } from "@google/genai";
import { stripHtml } from "./lib.mjs";

// ---------------------------------------------------------------- Claude (Claude Code CLI)
// Runs on a Claude Pro/Max subscription: local `claude` login, or CLAUDE_CODE_OAUTH_TOKEN in CI.
function claudeProvider({ model }) {
  const call = (prompt, args) =>
    new Promise((resolve, reject) => {
      const proc = spawn(
        "claude",
        ["-p", "--model", model, "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", ...args],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.on("error", reject); // e.g. CLI not installed
      proc.on("close", (code) => {
        try {
          const res = JSON.parse(out);
          if (res.is_error || res.subtype !== "success") {
            const msg = String(res.result ?? res.subtype);
            const hint = /401|authenticat|bearer/i.test(msg)
              ? " (check the CLAUDE_CODE_OAUTH_TOKEN secret: regenerate with `claude setup-token` and paste it as a single line)"
              : "";
            return reject(new Error(`${msg}${hint}`));
          }
          resolve(res);
        } catch {
          reject(new Error(`claude exited ${code}: ${out.slice(0, 500)}`));
        }
      });
      proc.stdin.end(prompt); // prompt via stdin: no argv length limits
    });

  return {
    label: `Claude (${model})`,
    // In CI the CLI only works with a token; locally it uses your `claude` login.
    available: () => !process.env.CI || Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    async rank({ system, prompt, schema }) {
      const res = await call(prompt, ["--system-prompt", system, "--tools", "", "--json-schema", JSON.stringify(schema)]);
      if (!res.structured_output) throw new Error("no structured output returned");
      return res.structured_output;
    },
    async write({ system, prompt }) {
      const res = await call(prompt, [
        "--system-prompt", system,
        "--tools", "WebFetch",
        "--allowedTools", "WebFetch",
        "--permission-mode", "dontAsk",
        "--max-turns", "10",
      ]);
      return String(res.result ?? "");
    },
  };
}

// ---------------------------------------------------------------- Gemini (API key)
function geminiProvider({ rankModel, writeModel, fallbackModel }) {
  let ai;
  let usedModel = writeModel; // reported in the label, so posts credit the model that actually answered
  const client = () => (ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

  // Try the preferred model, then the fallback (e.g. free-tier quota on Pro models).
  async function generate(models, params) {
    let lastErr;
    for (const model of [...new Set(models.filter(Boolean))]) {
      try {
        const res = await client().models.generateContent({ model, ...params });
        if (!res.text) throw new Error(`empty response (finish reason: ${res.candidates?.[0]?.finishReason ?? "unknown"})`);
        usedModel = model;
        return res.text;
      } catch (err) {
        console.warn(`[llm] gemini ${model}: ${err.message}`);
        lastErr = err;
      }
    }
    throw lastErr;
  }

  return {
    get label() {
      return `Gemini (${usedModel})`;
    },
    available: () => Boolean(process.env.GEMINI_API_KEY),
    async rank({ system, prompt, schema }) {
      const text = await generate([rankModel, fallbackModel], {
        contents: prompt,
        config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: withoutAdditionalProps(schema) },
      });
      return JSON.parse(text);
    },
    async write({ system, prompt, url }) {
      // Hand Gemini the article text directly; fall back to its URL-reading tool if extraction fails.
      const article = await fetchArticleText(url);
      return generate([writeModel, fallbackModel], {
        contents: article
          ? `${prompt}\n\nFull text of the original article (extracted from ${url}):\n<article>\n${article}\n</article>`
          : `${prompt}\n\nRead the original article at ${url} before writing.`,
        config: { systemInstruction: system, ...(article ? {} : { tools: [{ urlContext: {} }] }) },
      });
    },
  };
}

/** Gemini's schema support is a subset of JSON Schema; `additionalProperties` is optional for us. */
function withoutAdditionalProps(schema) {
  if (Array.isArray(schema)) return schema.map(withoutAdditionalProps);
  if (schema && typeof schema === "object") {
    const { additionalProperties, ...rest } = schema;
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, withoutAdditionalProps(v)]));
  }
  return schema;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Best-effort readable text from an article page; null if it looks too thin to be the article. */
async function fetchArticleText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ai-sys-design-digest/0.1)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    let html = await res.text();
    html = html.replace(/<(script|style|noscript|svg|nav|header|footer|form|aside)\b[\s\S]*?<\/\1>/gi, " ");
    const main = html.match(/<article\b[\s\S]*<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*<\/main>/i)?.[0] ?? html;
    const text = stripHtml(main.replace(/<\/(p|h[1-6]|li|tr|pre|div)>/gi, "\n"))
      .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1).replace(/^x/, "0x"))) : m));
    return text.length > 1500 ? text.slice(0, 150_000) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- router
export function createLLM(cfg) {
  const all = { claude: claudeProvider(cfg.claude), gemini: geminiProvider(cfg.gemini) };
  const order = (process.env.LLM_PROVIDERS?.split(",") ?? cfg.providers)
    .map((s) => s.trim())
    .filter((name) => all[name]?.available());
  const failed = new Set();

  // `check` validates/transforms the output; throwing there also falls through to the next provider.
  async function run(task, args, check = (v) => v) {
    let lastErr;
    for (const name of order) {
      if (failed.has(name)) continue;
      try {
        return { value: check(await all[name][task](args)), provider: all[name].label };
      } catch (err) {
        console.warn(`[llm] ${all[name].label} ${task} failed: ${err.message}`);
        failed.add(name);
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("No LLM provider available: set CLAUDE_CODE_OAUTH_TOKEN and/or GEMINI_API_KEY");
  }

  return {
    providers: order.map((n) => all[n].label),
    rank: (args, check) => run("rank", args, check),
    write: (args, check) => run("write", args, check),
  };
}
