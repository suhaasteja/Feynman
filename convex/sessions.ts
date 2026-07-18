import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export const create = mutation({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }): Promise<{
    _id: Id<"sessions">;
    articleId: Id<"articles">;
    currentIndex: number;
    status: "narrating" | "paused" | "answering";
  } | null> => {
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .first();

    if (existing) {
      return existing;
    }

    const sessionId = await ctx.db.insert("sessions", {
      articleId,
      currentIndex: 0,
      status: "paused",
    });

    return await ctx.db.get(sessionId);
  },
});

export const getByArticle = query({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    return await ctx.db
      .query("sessions")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .first();
  },
});

export const advance = mutation({
  args: { sessionId: v.id("sessions"), nextIndex: v.number() },
  handler: async (ctx, { sessionId, nextIndex }) => {
    await ctx.db.patch(sessionId, { currentIndex: nextIndex });
    return await ctx.db.get(sessionId);
  },
});

export const updateStatus = mutation({
  args: {
    sessionId: v.id("sessions"),
    status: v.union(
      v.literal("narrating"),
      v.literal("paused"),
      v.literal("answering"),
    ),
  },
  handler: async (ctx, { sessionId, status }) => {
    await ctx.db.patch(sessionId, { status });
    return await ctx.db.get(sessionId);
  },
});
