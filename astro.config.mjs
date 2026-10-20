import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// SITE_URL: full origin, e.g. https://username.github.io
// BASE_PATH: "/repo-name" for GitHub project pages, "/" for a custom domain or user page.
export default defineConfig({
  site: process.env.SITE_ORIGIN ?? "http://localhost:4321",
  base: process.env.BASE_PATH ?? "/",
  trailingSlash: "always",
  integrations: [sitemap()],
  markdown: {
    syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
    shikiConfig: { themes: { light: "github-light", dark: "github-dark-dimmed" } },
  },
});
