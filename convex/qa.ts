import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

// Log one answered Q&A turn. Called from the frontend after an answer is
// produced (text path now; voice path once transcripts are captured).
export const logTurn = mutation({
  args: {
    sessionId: v.id("sessions"),
    askedAtIndex: v.number(),
    question: v.string(),
    answer: v.string(),
    source: v.union(v.literal("voice"), v.literal("text")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("qaTurns", args);
  },
});

// Most-recent-first list of turns for a session (drives the Q&A history UI).
export const listBySession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("qaTurns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .collect();
  },
});

// Stage 5 hook: the async Respan judge patches the groundedness score back onto
// a turn once it has evaluated the transcript. Internal — not called from the UI.
export const setGroundednessScore = internalMutation({
  args: {
    turnId: v.id("qaTurns"),
    groundednessScore: v.number(),
  },
  handler: async (ctx, { turnId, groundednessScore }) => {
    await ctx.db.patch(turnId, { groundednessScore });
  },
});
