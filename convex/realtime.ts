"use node";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";

const OPENAI_BASE = "https://api.openai.com/v1";

async function getOpenAIKey(): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set on the Convex deployment. Run: npx convex env set OPENAI_API_KEY <key>",
    );
  }
  return key;
}

function extractResponseText(response: any): string {
  if (!response?.choices?.[0]?.message?.content) return "";
  return response.choices[0].message.content;
}

export const getRealtimeClientSecret = action({
  args: {},
  handler: async () => {
    const key = await getOpenAIKey();
    const res = await fetch(`${OPENAI_BASE}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI realtime client secret request failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    const token =
      data?.value ?? data?.token ?? data?.client_secret?.value ?? data?.client_secret;
    if (!token || typeof token !== "string") {
      throw new Error("OpenAI realtime client secret response did not include a usable token.");
    }
    return { token };
  },
});

export const answerQuestion = action({
  args: {
    articleId: v.id("articles"),
    question: v.string(),
  },
  handler: async (ctx, { articleId, question }) => {
    console.log(`[answerQuestion] Starting with articleId: ${articleId}, question: ${question}`);
    
    const segments = await ctx.runQuery(api.articles.getSegments, { articleId });
    console.log(`[answerQuestion] Retrieved ${segments?.length || 0} segments`);

    if (!segments || segments.length === 0) {
      throw new Error("No article segments found.");
    }

    const articleText = segments.map((segment) => segment.text).join("\n");
    console.log(`[answerQuestion] Article text length: ${articleText.length}`);
    
    const contextText = `Article text:\n${articleText}`;
    const prompt = `${contextText}\n\nAnswer the following question using only the article text above. If the answer cannot be found in the article, say "I don't know."\n\nQuestion: ${question}\nAnswer:`;

    const key = await getOpenAIKey();
    console.log(`[answerQuestion] Calling OpenAI API...`);
    
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI question answer request failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    console.log(`[answerQuestion] OpenAI response:`, JSON.stringify(data, null, 2));
    
    const answerText = extractResponseText(data);
    console.log(`[answerQuestion] Extracted answer: "${answerText}"`);
    
    return answerText || "I couldn't generate an answer.";
  },
});
