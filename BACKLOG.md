# Backlog — Interactive Audiobook

Deferred work and enhancement ideas, so nothing gets lost between sessions.
Source of truth for scope/stages is `interactive-audiobook-mvp-plan.md`.

## Requested next (2026-07-18)

### Deepen Respan usage (sponsor story) — ✅ Stage 5 DONE (2026-07-18)
**Shipped:** async groundedness judge. `qa.logTurn` schedules `qa.judgeTurn`
(off critical path); it pulls the answer + the current/previous paragraph the
assistant was grounded on, sends it through **Respan** (`chat/completions`,
`openai/gpt-4o-mini`, BYOK credential_override), and writes a 0–1
`groundednessScore` back via `setGroundednessScore`. UI already renders it (live
via the reactive `listBySession`); the eval also lands in the Respan dashboard.
Now Respan is used in two places: ingestion cleaning + Stage 5 judge.

**Still open:** delete the dead `realtime.answerQuestion` text path (unused since
voice-only) and the now-unused sentence-level TTS functions
(`prefetchAhead`, `getPlaybackSegments`, `storeSegmentAudioId`,
`fetchSegmentsForPrefetch`). Tune the judge prompt / add a reason column if
useful for the demo.

### Small slide deck (demo/pitch)
Short deck: problem → demo flow (paste → narrate → hold-Q → grounded answer →
resume) → architecture (Convex / Respan / ElevenLabs / OpenAI Realtime) →
sponsor fit → what's next. Decide format (Markdown/Marp vs. slides tool).

### UI overhaul — simple, minimalistic
Current UI is a bare functional layout (`src/index.css` + `src/App.tsx`). Want a
clean, minimal restyle. Decide: light/dark, accent color, typography.

## New ideas (2026-07-18)

### TTS: paragraph-level chunking for better prosody — ✅ DONE (2026-07-18)
**Was:** narration generated sentence-by-sentence sounded monotonous — prosody
reset at every boundary.

**Shipped:** narration is now generated + played **one paragraph at a time**
(all a paragraph's sentences joined) so ElevenLabs reads with full-paragraph
context. New `paragraphAudio` table, `audio.getParagraphView` +
`audio.prefetchParagraphsAhead`. Sentence `segments` stay the grounding unit;
`currentIndex` and playback advance a paragraph at a time.

**Trade chosen:** whole paragraph (well under ElevenLabs' ~10k-char limit). Kept
it simple — no `with-timestamps` sub-sentence mapping. Consequence: **resume
after a Q&A returns to the paragraph start**, not the exact interrupted
sentence. Feels natural (re-establishes context) but if long paragraphs make
re-hearing annoying, add exact resume by saving `audio.currentTime` on pause and
seeking on resume (no timestamp math needed since it's one file per paragraph).

### Realtime Q&A: conversation memory across turns/sessions — ✗ CANCELLED (2026-07-18)
User decision: not needed — the live Realtime session already remembers its own
turns, which is sufficient. (Left below for context if reconnect-survival ever
matters.)
**Question raised:** are we feeding the assistant's own past answers back to it?

**Current behavior (clarification):** the persistent Realtime session *does*
retain its own turn history while it's alive — so within one live session it
already remembers earlier questions **and** its own answers (that's why
follow-ups work). What's **lost** is history after a **reconnect** (60-min cap
or a dropped connection) or if we tear the session down and reopen it.

**Idea:** keep a durable memory of past Q&A and re-inject it so context survives
reconnects and reopening — "ephemeral while live, but restorable."

**Notes:**
- We already have the durable store: the **`qaTurns` table** (built in Stage 4).
- Proposal: on key-down — especially right after a silent reconnect or a fresh
  session — re-inject a compact "conversation so far" (the last N Q&A pairs from
  `qaTurns`) alongside the current-paragraph grounding context.
- **Depends on Stage 4 Piece 2b** (voice transcription): without transcripts,
  spoken Q&A turns aren't in `qaTurns`, so there'd be nothing to re-inject.
  Natural ordering: finish 2b → then build this memory feature on top.
- **Decide:**
  - How many past turns to re-inject (recency window, e.g. last 3–4).
  - Inject full Q+A text vs. a short summary (token budget).
  - Scope: this article's session only, or all history for the article.
  - Persisted vs. ephemeral (qaTurns makes "persisted" nearly free).

## Known limitations (Stage 4 voice loop)
- **Rapid barge-in can mis-pair a logged turn.** The question transcript and
  answer transcript are accumulated in refs per turn; interrupting mid-answer to
  ask a follow-up can associate the logged question with the next turn's answer.
  Robust fix: correlate by Realtime item/response id instead of shared refs.
- **Recap silently skips in the first ~2s after load.** The "back to the
  article" clips are pre-generated on article load; asking a question before they
  finish caching means the resume falls through to direct narration (no lead-in).

## Known deferred work (tracked from earlier stages)

### Stage 3 gaps (functional loop works; these are load-bearing polish)
- **Persistent idle session at narration start.** Connection is currently
  created lazily on the first key-press, so Q1 pays cold-start latency. Plan
  wants it opened idle when "Start narration" is pressed.
- **Silent reconnect + 60-min cap.** `onconnectionstatechange` tears down on
  drop but never reconnects — a drop mid-session is fatal until reload.

### Stage 2 load-bearing decision not yet implemented
- **Gapless Web Audio scheduling.** Playback currently chains `<audio>` elements
  (audible seams possible). Plan calls for decoding to `AudioBuffer`s scheduled
  on the `AudioContext` clock. (Related to the paragraph-chunking idea above.)

### Sponsor / scope
- **"Voice Cursor" sponsor requirement — unresolved.** Realtime subsumes STT, so
  there's no natural slot. If mandatory, the fit is a cascaded STT→LLM→TTS loop
  with Voice Cursor doing STT (trades away the low-latency full-duplex feel).
  Confirm with sponsors.

### Security
- **Rotate + scrub API keys in `.env.example`.** Real OpenAI, Respan, and
  ElevenLabs keys were pasted there (not gitignored). Keys belong only in the
  Convex deployment env. Rotate all three and reset the file to blank
  placeholders.
