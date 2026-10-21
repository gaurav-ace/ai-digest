import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

export const CATEGORIES = [
  "AI Research",
  "AI Engineering",
  "System Design",
  "Infrastructure",
  "Databases",
  "Data Storage",
  "Data Mobility",
  "Security",
] as const;

const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    date: z.coerce.date(),
    category: z.enum(CATEGORIES),
    tags: z.array(z.string()).default([]),
    importance: z.number().int().min(1).max(5).default(3),
    source: z.object({
      name: z.string(),
      url: z.string().url(),
      title: z.string().optional(),
      published: z.string().optional(),
    }),
    takeaways: z.array(z.string()).default([]),
    writer: z.string().optional(),
    sample: z.boolean().default(false),
  }),
});

export const collections = { posts };
