import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT = "mp3_22050_32";
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Valid premade ElevenLabs voice
const VOICE_ENV = process.env.ELEVENLABS_VOICE_ID;

async function getApiKey(): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error(
      "ELEVENLABS_API_KEY is not set on the Convex deployment. Run: npx convex env set ELEVENLABS_API_KEY <key>",
    );
  }
  return key;
}

async function fetchVoiceId(): Promise<string> {
  if (VOICE_ENV) {
    return VOICE_ENV;
  }

  return DEFAULT_VOICE_ID;
}

async function synthesizeAudio(
  text: string,
  voiceId: string,
  previousText?: string,
  nextText?: string,
): Promise<Blob> {
  const apiKey = await getApiKey();
  const body: Record<string, unknown> = {
    text,
    model_id: DEFAULT_MODEL,
    output_format: DEFAULT_OUTPUT_FORMAT,
  };

  if (previousText) {
    body.previous_text = previousText;
  }
  if (nextText) {
    body.next_text = nextText;
  }

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS request failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as {
    audio_base64?: string;
  };

  if (!data.audio_base64) {
    throw new Error("ElevenLabs TTS response did not include audio_base64.");
  }

  const base64Data = data.audio_base64;
  const buffer = typeof Buffer !== "undefined" && typeof Buffer.from === "function"
    ? Buffer.from(base64Data, "base64")
    : (() => {
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i += 1) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
      })();

  return new Blob([buffer], { type: "audio/mpeg" });
}

export const findRecapClip = internalQuery({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    return await ctx.db
      .query("recapClips")
      .withIndex("by_text", (q) => q.eq("text", text))
      .first();
  },
});

export const storeRecapClip = internalMutation({
  args: { text: v.string(), audioStorageId: v.id("_storage") },
  handler: async (ctx, { text, audioStorageId }) => {
    await ctx.db.insert("recapClips", { text, audioStorageId });
  },
});

// Return a playable URL for a short narrator-voice recap line, synthesizing and
// caching it on first request so later calls (and later sessions) are instant.
export const getRecapClip = action({
  args: { text: v.string() },
  handler: async (ctx, { text }): Promise<string | null> => {
    const existing = await ctx.runQuery(internal.audio.findRecapClip, { text });
    if (existing) {
      return await ctx.storage.getUrl(existing.audioStorageId);
    }

    const voiceId = await fetchVoiceId();
    const audioBlob = await synthesizeAudio(text, voiceId);
    const audioStorageId = await ctx.storage.store(audioBlob);
    await ctx.runMutation(internal.audio.storeRecapClip, { text, audioStorageId });
    return await ctx.storage.getUrl(audioStorageId);
  },
});

export const getPlaybackSegments = query({
  args: {
    articleId: v.id("articles"),
    startIndex: v.number(),
    count: v.number(),
  },
  handler: async (ctx, { articleId, startIndex, count }) => {
    const segments = await ctx.db
      .query("segments")
      .withIndex("by_article_index", (q) => q.eq("articleId", articleId))
      .filter((q) => q.gte(q.field("index"), startIndex))
      .order("asc")
      .take(count);

    return await Promise.all(
      segments.map(async (segment) => ({
        ...segment,
        audioUrl: segment.audioStorageId
          ? await ctx.storage.getUrl(segment.audioStorageId)
          : null,
      })),
    );
  },
});

export const fetchSegmentsForPrefetch = internalQuery({
  args: {
    articleId: v.id("articles"),
    startIndex: v.number(),
    count: v.number(),
  },
  handler: async (ctx, { articleId, startIndex, count }) => {
    return await ctx.db
      .query("segments")
      .withIndex("by_article_index", (q) => q.eq("articleId", articleId))
      .filter((q) => q.gte(q.field("index"), startIndex))
      .order("asc")
      .take(count);
  },
});

export const storeSegmentAudioId = internalMutation({
  args: {
    segmentId: v.id("segments"),
    audioStorageId: v.id("_storage"),
  },
  handler: async (ctx, { segmentId, audioStorageId }) => {
    await ctx.db.patch(segmentId, { audioStorageId });
    return true;
  },
});

export const prefetchAhead = action({
  args: {
    articleId: v.id("articles"),
    currentIndex: v.number(),
    ahead: v.optional(v.number()),
  },
  handler: async (ctx, { articleId, currentIndex, ahead = 3 }) => {
    const segments = await ctx.runQuery(internal.audio.fetchSegmentsForPrefetch, {
      articleId,
      startIndex: currentIndex,
      count: ahead + 1,
    });

    if (segments.length === 0) {
      return [];
    }

    const voiceId = await fetchVoiceId();
    const generated: Array<{ index: number; audioStorageId: Id<"_storage"> }> = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.audioStorageId) {
        continue;
      }

      const previousText = i > 0 ? segments[i - 1].text : undefined;
      const nextText = i + 1 < segments.length ? segments[i + 1].text : undefined;
      const audioBlob = await synthesizeAudio(segment.text, voiceId, previousText, nextText);
      const audioStorageId = await ctx.storage.store(audioBlob);
      await ctx.runMutation(internal.audio.storeSegmentAudioId, {
        segmentId: segment._id,
        audioStorageId,
      });
      generated.push({ index: segment.index, audioStorageId });
    }

    return generated;
  },
});

// --- Paragraph-level narration -------------------------------------------
// Narration is generated one paragraph at a time (all its sentences joined) so
// ElevenLabs has full-paragraph context and reads with natural prosody. The
// sentence `segments` remain the grounding/position unit; the player just plays
// and advances a paragraph at a time.

export const fetchArticleSegments = internalQuery({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    return await ctx.db
      .query("segments")
      .withIndex("by_article_index", (q) => q.eq("articleId", articleId))
      .order("asc")
      .collect();
  },
});

export const getParagraphAudioRows = internalQuery({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    return await ctx.db
      .query("paragraphAudio")
      .withIndex("by_article_paragraph", (q) => q.eq("articleId", articleId))
      .collect();
  },
});

export const storeParagraphAudio = internalMutation({
  args: {
    articleId: v.id("articles"),
    paragraphId: v.number(),
    audioStorageId: v.id("_storage"),
  },
  handler: async (ctx, { articleId, paragraphId, audioStorageId }) => {
    // Guard against a racing prefetch having stored this paragraph already.
    const existing = await ctx.db
      .query("paragraphAudio")
      .withIndex("by_article_paragraph", (q) =>
        q.eq("articleId", articleId).eq("paragraphId", paragraphId),
      )
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("paragraphAudio", { articleId, paragraphId, audioStorageId });
  },
});

// The current paragraph's playable audio plus the boundaries the player needs:
// where this paragraph starts, and the first segment index of the next one (so
// `onEnded` can advance). Drives narration playback + the on-screen text.
export const getParagraphView = query({
  args: { articleId: v.id("articles"), currentIndex: v.number() },
  handler: async (ctx, { articleId, currentIndex }) => {
    const all = await ctx.db
      .query("segments")
      .withIndex("by_article_index", (q) => q.eq("articleId", articleId))
      .order("asc")
      .collect();
    if (all.length === 0) return null;

    const current = all.find((s) => s.index === currentIndex) ?? all[0];
    const paragraphId = current.paragraphId;
    const paraSegs = all.filter((s) => s.paragraphId === paragraphId);
    const firstIndex = paraSegs[0].index;
    const lastIndex = paraSegs[paraSegs.length - 1].index;
    const nextSeg = all.find((s) => s.index === lastIndex + 1);

    const audioRow = await ctx.db
      .query("paragraphAudio")
      .withIndex("by_article_paragraph", (q) =>
        q.eq("articleId", articleId).eq("paragraphId", paragraphId),
      )
      .first();

    return {
      paragraphId,
      firstIndex,
      lastIndex,
      nextIndex: nextSeg ? nextSeg.index : null,
      text: paraSegs.map((s) => s.text).join(" "),
      audioUrl: audioRow ? await ctx.storage.getUrl(audioRow.audioStorageId) : null,
    };
  },
});

// Generate audio for the current paragraph and the next few, skipping any
// already cached. `ahead` counts paragraphs to look past the current one.
export const prefetchParagraphsAhead = action({
  args: {
    articleId: v.id("articles"),
    currentIndex: v.number(),
    ahead: v.optional(v.number()),
  },
  handler: async (ctx, { articleId, currentIndex, ahead = 2 }): Promise<number[]> => {
    const all = await ctx.runQuery(internal.audio.fetchArticleSegments, { articleId });
    if (all.length === 0) return [];

    const current = all.find((s) => s.index === currentIndex) ?? all[0];

    // Distinct paragraph ids from the current paragraph forward, up to ahead+1.
    const paragraphIds: number[] = [];
    for (const s of all) {
      if (s.index < current.index && s.paragraphId !== current.paragraphId) continue;
      if (!paragraphIds.includes(s.paragraphId)) paragraphIds.push(s.paragraphId);
      if (paragraphIds.length >= ahead + 1) break;
    }

    const existing = await ctx.runQuery(internal.audio.getParagraphAudioRows, { articleId });
    const haveAudio = new Set(existing.map((e) => e.paragraphId));

    const voiceId = await fetchVoiceId();
    const generated: number[] = [];

    for (const paragraphId of paragraphIds) {
      if (haveAudio.has(paragraphId)) continue;
      const paraSegs = all.filter((s) => s.paragraphId === paragraphId);
      const text = paraSegs.map((s) => s.text).join(" ").trim();
      if (!text) continue;

      const audioBlob = await synthesizeAudio(text, voiceId);
      const audioStorageId = await ctx.storage.store(audioBlob);
      await ctx.runMutation(internal.audio.storeParagraphAudio, {
        articleId,
        paragraphId,
        audioStorageId,
      });
      generated.push(paragraphId);
    }

    return generated;
  },
});
