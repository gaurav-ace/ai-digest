import { getCollection, type CollectionEntry } from "astro:content";
import curriculum from "../../config/curriculum.json";

export type Guide = CollectionEntry<"guides">;
export type Lesson = (typeof curriculum.tracks)[number]["lessons"][number];
export type Track = (typeof curriculum.tracks)[number];

export const TRACKS: Track[] = curriculum.tracks;

export const LEVEL_TONE: Record<string, string> = { Beginner: "emerald", Intermediate: "sky", Advanced: "violet" };

/** Written lessons keyed by slug (the guide's file name). */
export async function getGuideMap() {
  const guides = await getCollection("guides");
  return new Map(guides.map((g) => [g.id, g]));
}

/** Each track's lessons in curriculum order, paired with the written guide when it exists. */
export async function getTracks() {
  const written = await getGuideMap();
  return TRACKS.map((track) => ({
    ...track,
    items: track.lessons.map((lesson, i) => ({ lesson, n: i + 1, guide: written.get(lesson.slug) })),
  }));
}
