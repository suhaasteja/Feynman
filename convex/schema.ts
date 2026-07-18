import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Data model grows stage by stage (see the MVP plan). Stage 1 introduces
// `articles` + `segments`; the `sessions` and `qaTurns` tables arrive in
// Stages 2 and 4.
export default defineSchema({
  articles: defineTable({
    title: v.string(),
    status: v.union(
      v.literal("processing"),
      v.literal("ready"),
      v.literal("error"),
    ),
    totalSegments: v.number(),
  }),

  // One row per sentence/clause, in reading order. Doubles as the
  // grounding-context source for Stage 3.
  segments: defineTable({
    articleId: v.id("articles"),
    index: v.number(),
    text: v.string(),
    paragraphId: v.number(),
    audioStorageId: v.optional(v.id("_storage")),
  }).index("by_article_index", ["articleId", "index"]),

  sessions: defineTable({
    articleId: v.id("articles"),
    currentIndex: v.number(),
    status: v.union(
      v.literal("narrating"),
      v.literal("paused"),
      v.literal("answering"),
    ),
  }).index("by_article", ["articleId"]),

  // One row per answered question. `askedAtIndex` records where in the article
  // the user interrupted. `source` distinguishes the spoken (Realtime) path from
  // the typed fallback. `groundednessScore` is filled in asynchronously by the
  // Stage 5 Respan judge. `_creationTime` (built in) serves as createdAt.
  qaTurns: defineTable({
    sessionId: v.id("sessions"),
    askedAtIndex: v.number(),
    question: v.string(),
    answer: v.string(),
    source: v.union(v.literal("voice"), v.literal("text")),
    groundednessScore: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),

  // Cached narrator-voice "back to the article" clips, keyed by phrase so we
  // synthesize each line at most once. Pre-generated so the recap can play as a
  // gapless lead-in the instant a Q&A answer ends (Stage 4).
  recapClips: defineTable({
    text: v.string(),
    audioStorageId: v.id("_storage"),
  }).index("by_text", ["text"]),

  // One TTS clip per *paragraph* (all its sentences joined), so narration is
  // generated with full-paragraph context and reads with natural cross-sentence
  // prosody instead of flat sentence-by-sentence clips (Stage 2 "prosody escape
  // hatch"). Sentence `segments` stay the position/grounding unit; playback and
  // `currentIndex` advance a paragraph at a time.
  paragraphAudio: defineTable({
    articleId: v.id("articles"),
    paragraphId: v.number(),
    audioStorageId: v.id("_storage"),
  }).index("by_article_paragraph", ["articleId", "paragraphId"]),
});
