import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";

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
    const turnId = await ctx.db.insert("qaTurns", args);
    // Stage 5: grade groundedness asynchronously (off the critical path) via
    // Respan, so the score shows up in the Respan dashboard + the UI.
    await ctx.scheduler.runAfter(0, internal.qa.judgeTurn, { turnId });
    return turnId;
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

// --- Stage 5: async groundedness judge (via Respan) ----------------------
// An LLM-as-judge scores whether each answer is supported by the same paragraph
// context the assistant was grounded on. Routed through Respan so the eval
// shows up in the Respan dashboard; runs off the critical path (scheduled from
// logTurn), so it never adds latency to the live Q&A.

const RESPAN_BASE = "https://api.respan.ai/api";
const JUDGE_MODEL = process.env.RESPAN_JUDGE_MODEL ?? "openai/gpt-4o-mini";

// Gather what the judge needs: the Q&A plus the current + previous paragraph at
// the point the question was asked (mirrors the assistant's grounding window).
export const getTurnForJudging = internalQuery({
  args: { turnId: v.id("qaTurns") },
  handler: async (ctx, { turnId }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn) return null;
    const session = await ctx.db.get(turn.sessionId);
    if (!session) return null;

    const segments = await ctx.db
      .query("segments")
      .withIndex("by_article_index", (q) => q.eq("articleId", session.articleId))
      .order("asc")
      .collect();

    const anchor = segments.find((s) => s.index === turn.askedAtIndex) ?? segments[0];
    const contextText = anchor
      ? segments
          .filter(
            (s) =>
              s.paragraphId === anchor.paragraphId ||
              s.paragraphId === anchor.paragraphId - 1,
          )
          .map((s) => s.text)
          .join(" ")
      : "";

    return { question: turn.question, answer: turn.answer, contextText };
  },
});

export const judgeTurn = internalAction({
  args: { turnId: v.id("qaTurns") },
  handler: async (ctx, { turnId }) => {
    const respanKey = process.env.RESPAN_API_KEY;
    if (!respanKey) {
      console.warn("[judgeTurn] RESPAN_API_KEY not set — skipping groundedness eval.");
      return;
    }

    const data = await ctx.runQuery(internal.qa.getTurnForJudging, { turnId });
    if (!data || !data.contextText || !data.answer) return;

    const body: Record<string, unknown> = {
      model: JUDGE_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You grade whether an assistant's ANSWER is grounded in the provided SOURCE text about an article. " +
            'Reply ONLY with JSON: {"score": <float 0-1>, "reason": "<brief>"}. ' +
            "score=1 means every claim in the answer is directly supported by the source. " +
            "score=0 means the answer is unsupported or contradicts the source. " +
            'If the answer declines because the source lacks the info (e.g. "I don\'t know"), that is a correct refusal: score=1.',
        },
        {
          role: "user",
          content: `SOURCE:\n${data.contextText}\n\nQUESTION:\n${data.question}\n\nANSWER:\n${data.answer}`,
        },
      ],
    };
    // Bill the LLM leg to our own OpenAI account (same BYOK pattern as ingest).
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      body.credential_override = { [JUDGE_MODEL]: { api_key: openaiKey } };
    }

    let score: number | null = null;
    try {
      const res = await fetch(`${RESPAN_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${respanKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        console.warn(`[judgeTurn] Respan call failed (${res.status}): ${detail}`);
        return;
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as { score?: number };
      if (typeof parsed.score === "number" && isFinite(parsed.score)) {
        score = Math.max(0, Math.min(1, parsed.score));
      }
    } catch (err) {
      console.warn("[judgeTurn] groundedness eval error:", err);
      return;
    }

    if (score !== null) {
      await ctx.runMutation(internal.qa.setGroundednessScore, {
        turnId,
        groundednessScore: score,
      });
    }
  },
});
