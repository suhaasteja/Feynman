# Interactive Audiobook — MVP Build Plan
**Goal:** Paste an article → it's read aloud (TTS) → user holds a key to interrupt and ask a spoken question → an OpenAI Realtime session answers with low latency using the article as context → narration resumes where it left off.

**Required sponsor stack:** Convex (backend/state/storage), Respan (LLM gateway + evals), plus a voice layer (OpenAI Realtime API for Q&A, a TTS provider for narration).

* * *
## MVP principles — read before building
This is an MVP. The point of the initial phase is a **working end-to-end pipeline**, not a polished product. Deliberately keep it simple:

- **Single article at a time.** No library, no multi-doc.
  
- **Paste raw text.** No URL fetching / readability extraction yet.
  
- **No auth.** One implicit local user for now.
  
- **No RAG / vector search.** The article fits in context, so inject text directly (see Stage 3). Do **not** stand up embeddings or a vector index in the MVP.
  
- **One narration voice, one Q&A voice.**
  
- **Push-to-talk, not VAD.** Mic audio only flows while the key is held.
  
- Prefer boring, working code over abstractions. No premature generalization.
  

Each stage below has a **Done when** line. Get that working and verified before moving to the next stage.

* * *
## Standing instruction for Claude Code — tool discovery (do this per tool, before coding against it)
The developer does **not** know the current syntax/APIs of these tools, and some (OpenAI Realtime, Respan) change and rename things between versions. For **each** external tool you're about to integrate — **Convex, Respan, the OpenAI Realtime API, and the TTS provider** — do this first, at the stage where it's introduced:

1. **Check for an official MCP server** (search the MCP registry and the tool's own docs). If one exists, connect it and use it to read the live API surface.
  
2. **If no MCP exists, web-search the official docs** and read the current API reference before writing integration code. Do not rely on memory.
  
3. **Confirm exact current values at build time:** model IDs, Realtime API event names, SDK package versions, and pricing-relevant flags. (E.g. the Realtime event names shifted with the 2.1 models — verify, don't assume.)
  

Note any tool where the live docs differ from what's written in this plan, and follow the docs.
### Tool discovery — resolved (researched 2026-07-18)
Initial discovery is done; re-verify only if something errors or looks stale. A project `.mcp.json` is checked in with all three MCP servers pre-configured (Convex, Respan, ElevenLabs) — they activate once the API keys from Stage 0 are in the environment.

**Convex**

- Official MCP: `npx -y convex@latest mcp start` — [https://docs.convex.dev/ai/convex-mcp-server](https://docs.convex.dev/ai/convex-mcp-server)
  
- Useful flags: `--project-dir <path>`; production access requires `--dangerously-enable-production-deployments` (don't).
  

**Respan**

- Gateway is OpenAI-compatible; base URL `https://api.respan.ai/api`, auth via `RESPAN_API_KEY`. Quickstart: [https://www.respan.ai/docs/documentation/features/gateway/gateway-quickstart](https://www.respan.ai/docs/documentation/features/gateway/gateway-quickstart)
  
- Official MCP (logs/traces/prompts — useful for Stage 5): hosted HTTP endpoint `https://mcp.respan.ai/api/mcp` with bearer token from platform.respan.ai. Docs: [https://www.respan.ai/docs/documentation/resources/mcp](https://www.respan.ai/docs/documentation/resources/mcp) · repo: [https://github.com/respanai/respan-mcp](https://github.com/respanai/respan-mcp)
  

**OpenAI Realtime API**

- Current models: `gpt-realtime-2.1` and `gpt-realtime-2.1-mini` (released 2026-07-06; configurable reasoning + tool use).
  
- Browser flow: backend mints an ephemeral token via `POST /v1/realtime/client_secrets` → browser connects over **WebRTC via** `/v1/realtime/calls` (POST SDP with the ephemeral token). Docs: [https://developers.openai.com/api/docs/guides/realtime-webrtc](https://developers.openai.com/api/docs/guides/realtime-webrtc) and [https://platform.openai.com/docs/guides/realtime](https://platform.openai.com/docs/guides/realtime)
  
- **Hard limit: 60-minute max session length** (no server-side keepalive param). Token `expires_in` only gates connection start, not session lifetime.
  

**ElevenLabs**

- TTS with timestamps: `POST /v1/text-to-speech/:voice_id/with-timestamps` (non-streaming) or `.../stream/with-timestamps` (streamed JSON chunks: `audio_base64` + character-level `alignment` times). Docs: [https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
  
- Official MCP: `uvx elevenlabs-mcp` with `ELEVENLABS_API_KEY` env var — [https://github.com/elevenlabs/elevenlabs-mcp](https://github.com/elevenlabs/elevenlabs-mcp)
  

* * *
## Tech stack
- **Frontend:** React (Vite) or Next.js — pick one, don't overthink it. Needs Web Audio + keyboard events + a **WebRTC** connection to the Realtime API (OpenAI's recommended browser transport — gives mic capture and echo cancellation for free; see Stage 3).
  
- **Backend/state/storage:** Convex (functions, actions for external API calls, file storage for cached audio, reactive queries for playback position).
  
- **LLM text calls (cleaning pass + async judge):** routed through **Respan** (OpenAI-compatible gateway → observability).
  
- **Narration TTS:** ElevenLabs (recommended — high quality + word/sentence timestamps for optional highlight sync) _or_ OpenAI `gpt-4o-mini-tts` (fewer vendors, simpler). Either is fine for MVP.
  
- **Q&A voice:** OpenAI Realtime API (`gpt-realtime-2.1-mini` — **verified current** as of 2026-07-18; released 2026-07-06 alongside `gpt-realtime-2.1`).
  

**Secrets/env needed:** `OPENAI_API_KEY`, `RESPAN_API_KEY` (+ base URL), TTS provider key (e.g. `ELEVENLABS_API_KEY`), Convex deployment. Set these up in Stage 0.

* * *
## Data model (Convex tables)
Introduce tables as the stages need them; here's the full target so you can see where it's going.

- `articles` — `{ title, status, totalSegments }`
  
- `segments` — the main narration table, one row per sentence/clause in order: `{ articleId, index, text, paragraphId, audioStorageId? }` — index on `(articleId, index)`. Doubles as the grounding-context source.
  
- `sessions` — playback position: `{ articleId, currentIndex, status }` where status ∈ `narrating | paused | answering`. `currentIndex` is the single source of truth for "where the user is."
  
- `qaTurns` — Q&A log for follow-ups + evals: `{ sessionId, askedAtIndex, question, answer, groundednessScore?, createdAt }`. (Introduced in Stage 4/5.)
  

* * *
## STAGE 0 — Scaffolding
**Goal:** App runs, Convex is wired up, secrets are in place.

- Initialize the frontend and a Convex project; connect them.
  
- **[Tool discovery]** Connect the **Convex MCP** (or read Convex docs) so you use current schema/function syntax.
  
- Set up all env vars/secrets listed above (even ones used later).
  
- Empty UI shell with a textarea + a "Load article" button (non-functional placeholder is fine).
  

**Done when:** the app builds, connects to Convex, and a trivial Convex query/mutation round-trips from the UI.

* * *
## STAGE 1 — Ingestion: article → cleaned, ordered segments
**Goal:** Paste raw article text → store it as clean, ordered, paragraph-tagged segments.

- **[Tool discovery — resolved]** Respan gateway: OpenAI-compatible, base URL `https://api.respan.ai/api`, auth `RESPAN_API_KEY` (see resolved section above).
  
- Add `articles` and `segments` tables.
  
- Convex **action** that takes pasted text and processes it. **Don't ask the LLM to echo the whole article back** — full-article echo fails quietly (paraphrases despite prompt constraints, drops sentences, hits output-token limits). Instead:
  
  1. **Split into paragraphs deterministically** (blank-line split) — this assigns `paragraphId` without any LLM involvement.
    
  2. **LLM cleaning pass through Respan, per paragraph (or small batches):** strip scraped junk (footnote markers, figure captions, URLs, markdown symbols, nav cruft, tables that don't read aloud). Small inputs/outputs keep the rewrite risk and token limits bounded. **Prompt constraint stands:** normalize/clean only — no rewriting, summarizing, or paraphrasing.
    
  3. **Fidelity check per paragraph:** cheap similarity/diff ratio of cleaned vs. original (junk removal aside, the text should be near-identical). Below threshold → flag or fall back to the original paragraph. This catches silent rewrites.
    
  4. **Sentence-split deterministically with** `Intl.Segmenter` (built into JS, no library) — the LLM never decides segment boundaries.
    
- Write the resulting segments (ordered `index`, `paragraphId`) to Convex.
  

**Done when:** pasting an article populates `segments` in the DB — ordered, cleaned, paragraph-tagged — and it reads as verbatim article text, not a summary. Spot-check the fidelity scores.

* * *
## STAGE 2 — Narration: TTS playback with position tracking
**Goal:** Hear the article read start to finish; track where we are.

- **[Tool discovery — resolved]** ElevenLabs endpoints + timestamp format are in the resolved section above (`/v1/text-to-speech/:voice_id/with-timestamps`).
  
- Add the `sessions` table (`currentIndex`, `status`).
  
- **Position-aware prefetch queue** (this is your caching strategy — the queue _is_ lazy+prefetch):
  
  - A worker generates TTS for segments `[currentIndex … currentIndex+3]`, storing each in Convex file storage keyed by segment (`audioStorageId`).
    
  - Generate **in order, ahead of the playhead** — never on-demand at the playhead. Segment-generation is faster than segment-playback, so the buffer stays ahead and playback has no gaps.
    
- Frontend player: play segments in order; as each finishes, bump `sessions.currentIndex` (reactive → syncs across devices for free).
  
- **Gapless playback = Web Audio scheduling, not sequential** `<audio>` **elements.** Decode each segment to an `AudioBuffer` and schedule its start on the `AudioContext` clock so segments butt up sample-accurately. Naive element-per-segment playback produces audible seams even with a full buffer.
  
- **Prosody escape hatch:** per-sentence TTS calls lose cross-sentence intonation. If narration sounds choppy at segment boundaries, switch TTS generation to **per paragraph** while keeping per-sentence position tracking via the ElevenLabs character timestamps (that's what they're for).
  

**Done when:** paste → press play → the whole article plays smoothly with no audible gaps, and `currentIndex` advances correctly. (Text highlight-sync is optional; skip for MVP unless trivial.)

* * *
## STAGE 3 — Interrupt + Q&A via a persistent Realtime session
**Goal:** Hold a key → ask a spoken question → get a low-latency grounded answer → resume.

- **[Tool discovery — mostly resolved]** Model IDs, endpoints, and transport are in the resolved section above. Still read the current event reference for the exact session/response event names before coding.
  
- **Browser auth = ephemeral tokens.** Never ship `OPENAI_API_KEY` to the frontend. A Convex action mints an ephemeral token via `POST /v1/realtime/client_secrets`; the browser uses it to connect.
  
- **Transport = WebRTC** (`/v1/realtime/calls`, POST SDP with the ephemeral token) — OpenAI's recommended browser transport. It handles mic capture and gives browser echo cancellation, which does real work for the gating below.
  
- **Open ONE persistent Realtime session** when the reading session starts, and leave it **idle**. Do not open/close per question — that setup cost kills the latency you want. "Toggle" = start/stop piping mic audio, **not** the connection.
  
- **Plan for reconnects:** sessions have a **hard 60-minute cap** and can drop while idle. Reconnect silently in the background when the connection dies. Grounding context survives this for free (it's re-injected on every key-down); only in-session conversation history is lost — acceptable for MVP, note it and move on.
  
- **Guard the idle session:** since it's always open, ensure **no audio enters it except while the key is held.** Otherwise it hears the narration and answers the narrator. Second echo path: the user holding the key while the _assistant's own answer_ is still playing (follow-ups) — WebRTC's echo cancellation mostly covers this; ducking/pausing answer audio on key-down covers the rest.
  
- **Push-to-talk handlers:**
  
  - **Key down:** pause TTS at the current segment → read `currentIndex` → pull the **surrounding paragraph** (expand from the current sentence via `paragraphId`, plus the previous paragraph) and inject it as context into the open session → start streaming mic audio in.
    
  - **Key up:** stop the mic stream → resume TTS from the **start of the interrupted sentence**.
    
- Because the session persists and retains history, follow-up questions ("what about the second point?") work with no extra wiring.
  

**Done when:** during playback you can hold the key, ask a question about the article, hear a correct low-latency spoken answer grounded in the text, release, and have narration resume cleanly. Follow-up questions also work.

> **This is the end of the core MVP pipeline.** Stages 4–5 are enhancements — do them only once 0–3 are solid.

* * *
## STAGE 4 — Loop polish (enhancement)
**Goal:** Make the interrupt→answer→resume transition seamless.

- **Repoint the queue on resume:** generated audio is stored permanently in Convex file storage, so nothing is "evicted" — resuming into already-generated segments is instant, no regeneration needed. The actual work: on key-up, repoint the prefetch worker at `[resumeIndex … resumeIndex+3]` so it stops filling wherever it was and stays ahead of the playhead. (This matters most if the user seeks ahead of generated audio.)
  
- Optional **TTS recap** in the narrator voice on return ("to recap… now, back to the article"). Mind the voice switch: the Realtime answer voice ≠ the TTS narrator voice — either pick tonally similar voices, or frame them intentionally as "assistant" vs "narrator."
  
- Add the `qaTurns` table and log each Q&A turn (question, answer, `askedAtIndex`).
  

**Done when:** interrupting and resuming feels smooth, with no dead air on return.

* * *
## STAGE 5 — Respan groundedness judge (enhancement / sponsor demo)
**Goal:** Show Respan doing real evaluation work.

- **Async, off the critical path:** after a Q&A turn is logged, run an **LLM-as-judge via Respan** on the transcript — "is this answer supported by the injected paragraph?" — and write `groundednessScore` back to `qaTurns`.
  
- Do **not** put the judge synchronously before speaking; that adds latency to the live loop. It runs in the background.
  
- Surface a simple Respan dashboard / view of accuracy / groundedness across turns.
  

**Done when:** each answered question gets an async groundedness score visible in Respan.

* * *
## Load-bearing decisions (don't lose these under refactoring)
1. **Persistent Realtime session** — toggle the audio stream, not the connection — **with silent reconnect** (60-min hard cap; context re-injection on key-down makes reconnects cheap).
  
2. **Paragraph-level context**, expanded from the current position — not 3 bare sentences, not per-query retrieval.
  
3. **No RAG in MVP** — whole-article/paragraph text injected directly.
  
4. **Position-aware prefetch queue** — fill ahead of `currentIndex`, repoint on resume.
  
5. **Respan sits on the text calls only** (cleaning pass + async judge) — the Realtime connection won't route through it, and that's fine.
  
6. **Push-to-talk gating** — mic audio flows only while the key is held.
  
7. **Ephemeral tokens + WebRTC for the browser↔Realtime leg** — API key stays server-side; WebRTC supplies echo cancellation.
  
8. **LLM cleans, code splits** — segment boundaries come from `Intl.Segmenter`, never from the LLM; per-paragraph fidelity check guards verbatim narration.
  
9. **Gapless playback via Web Audio scheduling** — buffers on the `AudioContext` clock, not chained `<audio>` elements.
  

* * *
## Open item to confirm
- **"Voice Cursor" sponsor requirement:** confirm whether it's a _required_ tool and where it slots in. In the current design, the OpenAI Realtime API subsumes STT for the Q&A, so there's no natural place for a separate dictation/STT tool. If it's mandatory, the likely fit is swapping the Realtime path for a cascaded STT→LLM→TTS loop where Voice Cursor does the STT — but that trades away the low-latency full-duplex feel. Resolve this before Stage 3.
