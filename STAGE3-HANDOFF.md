# Handoff — Interactive Audiobook (resuming at Stage 3 debugging)

Read `interactive-audiobook-mvp-plan.md` first — it's the source of truth for the whole project (goal, stages, load-bearing decisions). This file only covers the current state and the immediate task.

## Current state
- **Stages 0–3 are built.** Stage 0 (scaffold) and Stage 1 (ingestion) were verified working. Stages 2 (narration/TTS) and 3 (Realtime Q&A) were added by another agent and are **not yet fully verified**.
- Stack as built: React + Vite + TS frontend, Convex backend (`determined-pig-815`), Respan gateway for text LLM calls, ElevenLabs for narration TTS, OpenAI Realtime (WebRTC) for spoken Q&A.
- Convex tables live: `articles`, `segments`, `sessions`. (`qaTurns` from Stage 4 not added yet.)

## THE IMMEDIATE BUG (what to fix first)
On "Start narration", `audio:prefetchAhead` throws:
```
ElevenLabs TTS request failed (401): {"code":"quota_exceeded",
"message":"You have 30 credits remaining, while 82 credits are required..."}
```
**This is NOT a code bug.** `convex/audio.ts::synthesizeAudio` calls ElevenLabs and correctly surfaces the error. The ElevenLabs account is simply **out of TTS credits**. (ElevenLabs returns HTTP 401 for quota exhaustion; the `code: quota_exceeded` field disambiguates it from an auth failure — the key itself is valid.)

Fix options (pick one — confirm with the user):
1. **Top up / upgrade the ElevenLabs account** (or use a fresh account with free credits). No code change.
2. **Switch narration TTS to OpenAI `gpt-4o-mini-tts`** (recommended — the user already has OpenAI credits; the MVP plan lists this as the sanctioned Stage 2 alternative). Contained change in `convex/audio.ts::synthesizeAudio`:
   - `POST https://api.openai.com/v1/audio/speech` with `Authorization: Bearer $OPENAI_API_KEY`, body `{ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "mp3" }`.
   - The response is raw MP3 bytes (not JSON+base64 like ElevenLabs) — wrap directly in a `Blob({ type: "audio/mpeg" })` and keep the existing `ctx.storage.store(...)` + `storeSegmentAudioId` flow unchanged.
   - Drop the ElevenLabs-only `previous_text`/`next_text`/`with-timestamps` bits. Highlight-sync is optional for MVP, so losing timestamps is fine.

## SECURITY — do this
`.env.example` currently contains the user's **real** OpenAI, Respan, and ElevenLabs API keys (it is NOT gitignored). The keys are already in the Convex deployment env, so the file copies are redundant and a leak risk. **Rotate all three keys and scrub `.env.example` back to blank placeholders.** Never put real secrets in that file.

## Environment (all set on the Convex deployment, not the frontend)
- `RESPAN_API_KEY` — Respan gateway (base `https://api.respan.ai/api`), used by `convex/ingest.ts` cleaning pass.
- `OPENAI_API_KEY` — used two ways: (a) Realtime ephemeral tokens in `convex/realtime.ts`; (b) as a per-request `credential_override` in the Respan cleaning call so the LLM leg bills the user's own OpenAI account (Respan free tier — no Team plan / credits needed).
- `ELEVENLABS_API_KEY` (+ optional `ELEVENLABS_VOICE_ID`) — narration TTS in `convex/audio.ts`. Becomes unused if you switch to OpenAI TTS.
- `VITE_CONVEX_URL` — frontend, auto-written to `.env.local` by `npx convex dev`.

## Load-bearing decisions (do not refactor away — see plan)
Persistent Realtime session with silent reconnect · push-to-talk gating (mic only while key held; key = `KeyQ`) · ephemeral tokens + WebRTC · paragraph-level grounding context injected on key-down · position-aware prefetch queue (fill ahead of `currentIndex`) · gapless Web Audio scheduling · Respan on text calls only · LLM cleans / `Intl.Segmenter` splits.

## Known open item (unresolved)
**"Voice Cursor" sponsor requirement** — still not slotted into the design. OpenAI Realtime subsumes STT for Q&A, so there's no natural place for it. If it's mandatory, the fit is swapping the Realtime path for a cascaded STT→LLM→TTS loop with Voice Cursor doing STT (trades away the low-latency full-duplex feel). Confirm with the user / sponsors before committing.

## STAGE 3 REALTIME BUG — root cause & fix (current blocker)
Symptom: hold push-to-talk (`KeyQ`) → UI shows Realtime "loading" → assistant never replies. TTS/narration now works (ElevenLabs topped up).

Root cause: the WebRTC connection establishes, but **nothing triggers a model response**, and grounding never arrives. Three concrete defects in `src/App.tsx` (+ `convex/realtime.ts`):

1. **No response is ever requested (the hang).** `endPushToTalk` only calls `pc.removeTrack(...)`. For push-to-talk you must, on key-up, send over the data channel:
   ```js
   sendRealtimeEvent({ type: "input_audio_buffer.commit" });
   sendRealtimeEvent({ type: "response.create" });
   ```
   And the session must be configured for manual turns. Either configure at token creation in `getRealtimeClientSecret` (body `{ session: { type: "realtime", model: REALTIME_MODEL, ... } }`) or, simpler, send a `session.update` in `dataChannel.onopen`:
   ```js
   dataChannel.onopen = () => sendRealtimeEvent({
     type: "session.update",
     session: {
       type: "realtime",
       instructions: "<task: answer only from the provided article context>",
       turn_detection: null            // manual push-to-talk
       // + audio output config as needed
     }
   });
   ```
   ⚠️ Verify exact field names against the CURRENT Realtime event reference — the 2.1 models renamed several session/audio fields. Do not trust memory; read the docs.

2. **Grounding context is dropped on the first turn.** `beginPushToTalk` calls `sendRealtimeText(context)` immediately after creating the connection, but `sendRealtimeEvent` no-ops unless `dataChannel.readyState === "open"`, which isn't true yet on first key-press. Fix: queue the grounding and flush it in `dataChannel.onopen`, or send it as a `conversation.item.create` (input_text) only once the channel is confirmed open. Inject the surrounding paragraph(s) via `buildGroundingContext()` on every key-down (cheap re-injection survives reconnects — see plan).

3. **Use `track.enabled`, not `removeTrack`.** Key-up calls `pc.removeTrack(...)`, which implies a renegotiation that never happens and destabilizes the connection. Per the plan ("toggle the audio stream, not the connection"): add the mic track once for the session and toggle `track.enabled = true/false` on key-down/up.

Also recommended (plan alignment, not strictly the bug): open ONE persistent Realtime session when narration starts and leave it idle, instead of lazily creating it inside `beginPushToTalk`; add silent reconnect (60-min hard cap). And parse inbound data-channel events (`response.*`, `error`) to drive UI + surface server errors that are currently only `console.log`ged.

## Suggested order of work
1. Unblock TTS (option 1 or 2 above) so narration actually plays.
2. Verify Stage 2 "Done when": full article plays gaplessly, `currentIndex` advances.
3. Verify Stage 3 "Done when": hold `KeyQ` → ask → grounded low-latency spoken answer → release → narration resumes; follow-ups work.
4. Scrub/rotate secrets.
5. Then Stages 4–5 (loop polish; Respan groundedness judge) — enhancements only after 0–3 are solid.

## How to run
- `npx convex dev` (one terminal, keep running) + `npm run dev` (frontend).
- Smoke-test ingestion headlessly: `npx convex run ingest:loadArticle '{"rawText":"...\n\n..."}'`.
