# Handoff prompt — paste this into the new session

Read `interactive-audiobook-mvp-plan.md` in this directory in full before doing anything — it is the single source of truth for this project. Then start building.

Context you'd otherwise have to rediscover:

- **State:** Planning is complete; no code exists yet. Start at **Stage 0** and work strictly stage by stage. Do not start a stage until the previous stage's **"Done when"** line is verified working.
- **Tool discovery is already done** (2026-07-18) and recorded in the plan's "Tool discovery — resolved" section: current model IDs, endpoints, base URLs, and doc links for Convex, Respan, OpenAI Realtime, and ElevenLabs are all verified. Trust that section; only re-research if an API call actually errors or a doc link contradicts it.
- **`.mcp.json` is already configured** in this directory with the Convex, Respan, and ElevenLabs MCP servers. Convex works once the project is initialized; Respan and ElevenLabs activate when `RESPAN_API_KEY` and `ELEVENLABS_API_KEY` are set (Stage 0 sets up all env vars).
- **Respect the plan's "MVP principles" and "Load-bearing decisions" sections** — they encode deliberate choices (persistent Realtime session with silent reconnect, push-to-talk gating, ephemeral tokens + WebRTC, LLM-cleans-code-splits, Web Audio scheduled buffers, no RAG). Do not refactor them away or "improve" on them.
- **Open item:** the "Voice Cursor" sponsor requirement (last section of the plan) is unresolved — ask the user about it before starting Stage 3.
- Keep code boring and direct. No premature abstraction. When a stage is done, state what was verified and how, then move to the next.
