import rss from "@astrojs/rss";
import { getPosts, SITE } from "../lib/site";

export async function GET(context) {
  const posts = await getPosts();
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return rss({
    title: SITE.name,
    description: SITE.description,
    site: new URL(base + "/", context.site),
    items: posts.slice(0, 50).map((p) => ({
      title: p.data.title,
      description: p.data.summary,
      pubDate: p.data.date,
      link: `${base}/posts/${p.id}/`,
      categories: [p.data.category, ...p.data.tags],
    })),
  });
}
