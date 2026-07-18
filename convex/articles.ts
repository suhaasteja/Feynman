import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// Called by the ingest action once paragraphs are cleaned and split into
// ordered segments. Internal — the frontend goes through the action, not here.
export const create = internalMutation({
  args: {
    title: v.string(),
    segments: v.array(
      v.object({
        index: v.number(),
        text: v.string(),
        paragraphId: v.number(),
      }),
    ),
  },
  handler: async (ctx, { title, segments }) => {
    const articleId = await ctx.db.insert("articles", {
      title,
      status: "ready",
      totalSegments: segments.length,
    });
    for (const s of segments) {
      await ctx.db.insert("segments", {
        articleId,
        index: s.index,
        text: s.text,
        paragraphId: s.paragraphId,
      });
    }
    return articleId;
  },
});

export const getSegments = query({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    return await ctx.db
      .query("segments")
      .withIndex("by_article_index", (q: any) => q.eq("articleId", articleId))
      .collect();
  },
});

export const get = query({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    return await ctx.db.get(articleId);
  },
});
