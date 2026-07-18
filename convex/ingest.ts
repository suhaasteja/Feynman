"use node";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

type IngestResult = {
  articleId: Id<"articles">;
  totalSegments: number;
  paragraphCount: number;
  report: {
    paragraphId: number;
    fidelity: number | null;
    outcome: "cleaned" | "fallback" | "dropped";
    sentenceCount: number;
  }[];
};

// --- Config ---------------------------------------------------------------
const RESPAN_BASE = "https://api.respan.ai/api";
// Cheap, fast, good instruction-follower for the cleaning pass. Provider-
// prefixed so the per-request credential override below can be keyed by it.
// Override with `npx convex env set RESPAN_MODEL <id>` for a different model.
const CLEANING_MODEL = process.env.RESPAN_MODEL ?? "openai/gpt-4o-mini";
// A cleaned paragraph must keep at least this fraction of its words as an
// ordered subsequence of the original, or we discard the LLM output and fall
// back to the raw paragraph. Catches silent rewrites/paraphrases.
const FIDELITY_THRESHOLD = 0.9;
// How many paragraph-cleaning calls to run at once.
const CONCURRENCY = 5;

const CLEANING_SYSTEM_PROMPT = `You are a text-cleaning tool that prepares scraped article text to be read aloud by a text-to-speech narrator.

You will receive ONE paragraph. Remove only non-prose scrape artifacts:
- footnote/citation markers and bracketed reference numbers (e.g. [1], [12])
- figure/table captions and figure numbers
- inline URLs and "read more"/navigation cruft
- markdown/formatting symbols (#, *, _, backticks, pipe tables)

Rules, strictly:
- Preserve every sentence of actual prose EXACTLY as written. Do not rewrite, summarize, paraphrase, translate, reorder, or add any words.
- Do not "improve" grammar or style. Verbatim except for the junk above.
- Output ONLY the cleaned paragraph text. No preamble, no quotes, no explanation.
- If the entire paragraph is non-prose that would not read aloud (e.g. a bare table or nav bar), output an empty string.`;

// --- Public action --------------------------------------------------------
export const loadArticle = action({
  args: { rawText: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, { rawText, title }): Promise<IngestResult> => {
    const apiKey = process.env.RESPAN_API_KEY;
    if (!apiKey) {
      throw new Error(
        "RESPAN_API_KEY is not set on the Convex deployment. Run: npx convex env set RESPAN_API_KEY <key>",
      );
    }

    // 1. Deterministic paragraph split — assigns paragraphId, no LLM.
    const paragraphs = splitParagraphs(rawText);
    if (paragraphs.length === 0) {
      throw new Error("No paragraphs found in the pasted text.");
    }

    // Optional: route the Respan call through our own OpenAI account via a
    // per-request credential override (avoids needing Respan credits or the
    // dashboard BYOK plan). Harmless if unset — Respan uses its own routing.
    const openaiKey = process.env.OPENAI_API_KEY;

    // 2. LLM cleaning pass per paragraph, concurrency-limited.
    const cleaned = await mapWithConcurrency(
      paragraphs,
      CONCURRENCY,
      (p) => cleanParagraph(p, apiKey, openaiKey),
    );

    // 3. Fidelity check + 4. sentence split, in original order.
    const segments: { index: number; text: string; paragraphId: number }[] = [];
    const report: {
      paragraphId: number;
      fidelity: number | null;
      outcome: "cleaned" | "fallback" | "dropped";
      sentenceCount: number;
    }[] = [];

    let index = 0;
    for (let p = 0; p < paragraphs.length; p++) {
      const original = paragraphs[p];
      let text = cleaned[p].trim();
      let outcome: "cleaned" | "fallback" | "dropped" = "cleaned";
      let fidelity: number | null = null;

      if (text.length === 0) {
        // LLM judged the whole paragraph as non-prose junk — drop it.
        report.push({ paragraphId: p, fidelity: null, outcome: "dropped", sentenceCount: 0 });
        continue;
      }

      fidelity = similarityRatio(text, original);
      if (fidelity < FIDELITY_THRESHOLD) {
        // Suspected rewrite — trust the original over the LLM.
        text = original;
        outcome = "fallback";
      }

      const sentences = splitSentences(text);
      for (const s of sentences) {
        segments.push({ index: index++, text: s, paragraphId: p });
      }
      report.push({ paragraphId: p, fidelity, outcome, sentenceCount: sentences.length });
    }

    if (segments.length === 0) {
      throw new Error("Cleaning produced no readable segments.");
    }

    const articleId: Id<"articles"> = await ctx.runMutation(internal.articles.create, {
      title: title?.trim() || deriveTitle(rawText),
      segments,
    });

    return {
      articleId,
      totalSegments: segments.length,
      paragraphCount: paragraphs.length,
      report,
    };
  },
});

// --- Helpers --------------------------------------------------------------

function splitParagraphs(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

async function cleanParagraph(
  paragraph: string,
  respanKey: string,
  openaiKey?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: CLEANING_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: CLEANING_SYSTEM_PROMPT },
      { role: "user", content: paragraph },
    ],
  };
  // Per-request BYOK: execute on our own OpenAI account, keyed by model id.
  if (openaiKey) {
    body.credential_override = { [CLEANING_MODEL]: { api_key: openaiKey } };
  }

  const res = await fetch(`${RESPAN_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${respanKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Respan cleaning call failed (${res.status}): ${detail.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

// Sentence boundaries come from Intl.Segmenter — never from the LLM.
function splitSentences(text: string): string[] {
  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const out: string[] = [];
  for (const { segment } of seg.segment(text)) {
    const s = segment.trim();
    if (s.length > 0) out.push(s);
  }
  return out;
}

// Fraction of the cleaned text's words that appear, in order, in the original.
// ~1.0 for a faithful subset (junk removed); drops sharply for paraphrases.
function similarityRatio(cleaned: string, original: string): number {
  const a = tokenize(cleaned);
  const b = tokenize(original);
  if (a.length === 0) return 0;
  return lcsLength(a, b) / a.length;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function lcsLength(a: string[], b: string[]): number {
  // O(a*b) DP with a rolling row; paragraphs are small so this is fine.
  const prev = new Array(b.length + 1).fill(0);
  const curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function deriveTitle(raw: string): string {
  const firstLine = raw.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return "Untitled article";
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
