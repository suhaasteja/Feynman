import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type IngestReport = {
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

type RealtimeStatus = "idle" | "connecting" | "ready" | "error";

const REALTIME_MODEL = "gpt-realtime-2.1-mini";
const PUSH_TO_TALK_KEY = "KeyQ";
const REALTIME_INSTRUCTIONS =
  "You are a helpful assistant answering questions about an article the user is listening to. " +
  "Answer ONLY using the article context provided in the conversation. If the answer is not in that " +
  "context, say you don't know. Keep answers brief and natural for speech.";
const REALTIME_VOICE = "alloy";
// Transcribes the user's spoken question so voice Q&A turns can be logged
// (and later judged for groundedness in Stage 5).
const INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

// Short narrator-voice lead-ins played the instant a Q&A answer ends, just
// before the article narration resumes — bridges the voice switch with no dead
// air (they're pre-generated and cached). One is picked at random per return.
const RECAP_ENABLED = true;
const NARRATION_RECAP_LINES = [
  "Okay, back to the article.",
  "Alright, picking up where we left off.",
  "Now, back to where we were.",
];
// Deliberate pause after a Q&A answer finishes, before the recap + narration
// resume, so the hand-off feels natural instead of snapping back instantly.
const RESUME_DELAY_MS = 1500;

export default function App() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestReport | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentAudioUrl, setCurrentAudioUrl] = useState<string | null>(null);

  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("idle");
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [pushToTalkActive, setPushToTalkActive] = useState(false);
  const [pendingResume, setPendingResume] = useState(false);

  const loadArticle = useAction(api.ingest.loadArticle);
  const createSession = useMutation(api.sessions.create);
  const advanceSession = useMutation(api.sessions.advance);
  const updateSessionStatus = useMutation(api.sessions.updateStatus);
  const getRealtimeClientSecret = useAction(api.realtime.getRealtimeClientSecret);
  const prefetchParagraphs = useAction(api.audio.prefetchParagraphsAhead);
  const getRecapClip = useAction(api.audio.getRecapClip);
  const logQaTurn = useMutation(api.qa.logTurn);
  const segments = useQuery(
    api.articles.getSegments,
    result ? { articleId: result.articleId } : "skip",
  );

  const session = useQuery(
    api.sessions.getByArticle,
    result ? { articleId: result.articleId } : "skip",
  );

  // The current paragraph's audio + boundaries. Narration now plays one
  // paragraph at a time (generated with full-paragraph context for prosody).
  const paragraphView = useQuery(
    api.audio.getParagraphView,
    result && session
      ? { articleId: result.articleId, currentIndex: session.currentIndex }
      : "skip",
  );

  const qaTurns = useQuery(
    api.qa.listBySession,
    session ? { sessionId: session._id } : "skip",
  );

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recapAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  // Pre-generated recap clip URLs; whether narration was actually playing when
  // interrupted (so we don't recap a cold push-to-talk); and a fresh mirror of
  // `playing` for the once-created data-channel handler.
  const recapUrlsRef = useRef<string[]>([]);
  const wasNarratingRef = useRef(false);
  const playingRef = useRef(false);
  // Pending "resume after buffer" timer, so it can be cancelled on barge-in.
  const resumeTimeoutRef = useRef<number | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localSenderRef = useRef<RTCRtpSender | null>(null);
  const remoteStreamRef = useRef<MediaStream>(new MediaStream());
  const reconnectTimeoutRef = useRef<number | null>(null);
  // Events queued while the data channel is still opening (flushed on open).
  const pendingEventsRef = useRef<object[]>([]);
  // Read by the persistent data-channel handler (which would otherwise see
  // stale React state): whether the user is currently holding push-to-talk, and
  // whether the assistant's audio is currently playing (for barge-in).
  const pushToTalkActiveRef = useRef(false);
  const assistantSpeakingRef = useRef(false);
  // Whether the model is still *generating* a response. Distinct from
  // assistantSpeakingRef (audio still *playing*) — generation usually finishes
  // before playback does, so cancelling must be gated on this to avoid the
  // "response_cancel_not_active" error.
  const responseActiveRef = useRef(false);
  // Voice Q&A logging (Stage 4). Refs so the once-created data-channel handler
  // always sees fresh values. Transcripts accumulate across a turn and are
  // written to qaTurns when the response completes.
  const sessionIdRef = useRef<Id<"sessions"> | null>(null);
  const currentIndexRef = useRef(0);
  const askedAtIndexRef = useRef(0);
  const pendingQuestionRef = useRef("");
  const pendingAnswerRef = useRef("");

  const extractRealtimeToken = (data: any) => {
    const token =
      data?.token ?? data?.client_secret?.value ?? data?.client_secret ?? data?.client_secret_value;
    if (!token || typeof token !== "string") {
      throw new Error("Realtime client secret response did not include a token.");
    }
    return token;
  };

  const cleanupRealtimeConnection = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (localSenderRef.current && pcRef.current) {
      pcRef.current.removeTrack(localSenderRef.current);
      localSenderRef.current = null;
    }

    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    const remoteStream = remoteStreamRef.current;
    remoteStream.getTracks().forEach((track) => remoteStream.removeTrack(track));

    setRealtimeStatus("idle");
  }, []);

  const waitForIceGatheringComplete = (pc: RTCPeerConnection) => {
    return new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const handler = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", handler);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", handler);
    });
  };

  const sendRealtimeEvent = (event: object) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState === "open") {
      channel.send(JSON.stringify(event));
    } else {
      // Channel not open yet (e.g. first key-press) — queue and flush on open.
      pendingEventsRef.current.push(event);
    }
  };

  const sendRealtimeText = (text: string) => {
    sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
  };

  const resumeNarration = useCallback(async () => {
    if (session) {
      await updateSessionStatus({ sessionId: session._id, status: "narrating" });
    }
    setPlaying(true);
  }, [session, updateSessionStatus]);

  // Keep session identifiers fresh for the persistent data-channel handler.
  useEffect(() => {
    sessionIdRef.current = session?._id ?? null;
    currentIndexRef.current = session?.currentIndex ?? 0;
  }, [session]);

  const pauseNarration = useCallback(async () => {
    if (session) {
      await updateSessionStatus({ sessionId: session._id, status: "answering" });
    }
    setPlaying(false);
    audioRef.current?.pause();
    // Cancel a pending post-answer resume buffer (e.g. barge-in during it).
    if (resumeTimeoutRef.current) {
      window.clearTimeout(resumeTimeoutRef.current);
      resumeTimeoutRef.current = null;
    }
    // Also stop any recap lead-in that may be mid-play (e.g. barge-in during
    // the recap) and clear its handler so it can't trigger a stale resume.
    if (recapAudioRef.current) {
      recapAudioRef.current.onended = null;
      recapAudioRef.current.pause();
    }
  }, [session, updateSessionStatus]);

  // Keep a fresh mirror of `playing` for handlers that run outside React render.
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // Pre-generate + cache the recap clips once the article is loaded, so the
  // "back to the article" lead-in is instantly playable when a Q&A ends.
  useEffect(() => {
    if (!result || !RECAP_ENABLED) return;
    let cancelled = false;
    Promise.all(NARRATION_RECAP_LINES.map((line) => getRecapClip({ text: line })))
      .then((urls) => {
        if (!cancelled) {
          recapUrlsRef.current = urls.filter((url): url is string => Boolean(url));
        }
      })
      .catch((err) => console.error("Recap prefetch failed:", err));
    return () => {
      cancelled = true;
    };
  }, [result, getRecapClip]);

  // Play a cached recap clip, then resume article narration when it ends — the
  // clever bit: narration only restarts *after* the lead-in finishes, so there's
  // no overlap and no dead air. Falls back to a direct resume if unavailable.
  const resumeAfterAnswer = useCallback(async () => {
    const recapEl = recapAudioRef.current;
    const urls = recapUrlsRef.current;
    if (RECAP_ENABLED && wasNarratingRef.current && recapEl && urls.length > 0) {
      const url = urls[Math.floor(Math.random() * urls.length)];
      recapEl.src = url;
      recapEl.onended = () => {
        recapEl.onended = null;
        resumeNarration().catch((err) => console.error("Resume failed:", err));
      };
      try {
        await recapEl.play();
        return; // narration resumes on the recap's "ended" event
      } catch {
        recapEl.onended = null; // playback blocked — fall through to direct resume
      }
    }
    await resumeNarration();
  }, [resumeNarration]);

  const resumeAfterAnswerRef = useRef(resumeAfterAnswer);
  useEffect(() => {
    resumeAfterAnswerRef.current = resumeAfterAnswer;
  }, [resumeAfterAnswer]);

  const buildGroundingContext = useCallback(() => {
    if (!session || !segments?.length) return "";
    const currentSegment = segments.find((segment) => segment.index === session.currentIndex);
    if (!currentSegment) return "";

    const currentParagraphId = currentSegment.paragraphId;
    const previousParagraphId = currentParagraphId - 1;

    const lines = segments
      .filter(
        (segment) =>
          segment.paragraphId === previousParagraphId || segment.paragraphId === currentParagraphId,
      )
      .map((segment) => segment.text);

    return lines.join("\n");
  }, [segments, session]);

  const createRealtimeConnection = useCallback(async (initialStream?: MediaStream) => {
    if (pcRef.current) {
      return pcRef.current;
    }

    setRealtimeStatus("connecting");
    setRealtimeError(null);

    const clientSecretResponse = await getRealtimeClientSecret();
    const token = extractRealtimeToken(clientSecretResponse);

    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    const onRemoteTrack = (event: RTCTrackEvent) => {
      console.log("ontrack event", {
        streams: event.streams?.length,
        track: event.track?.kind,
        trackId: event.track?.id,
      });

      const stream = remoteStreamRef.current;
      if (event.streams && event.streams.length > 0) {
        event.streams[0].getTracks().forEach((track) => {
          stream.addTrack(track);
          console.log("Added remote stream track", track.kind, track.id);
        });
      } else if (event.track) {
        stream.addTrack(event.track);
        console.log("Added remote track", event.track.kind, event.track.id);
      }

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.play().catch((err) => {
          console.warn("Remote audio play failed", err);
        });
      }
    };

    pc.ontrack = onRemoteTrack;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setRealtimeStatus("ready");
      }
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setRealtimeStatus("error");
        setRealtimeError("Realtime connection lost.");
        cleanupRealtimeConnection();
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        setRealtimeStatus("error");
        setRealtimeError("Realtime ICE connection failed.");
        cleanupRealtimeConnection();
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.onmessage = (messageEvent) => {
        console.log("Realtime message from server:", messageEvent.data);
      };
    };

    const dataChannel = pc.createDataChannel("oai-events");
    dataChannel.onopen = () => {
      console.log("Realtime data channel open");
      // Configure the session: manual push-to-talk turns (no server VAD),
      // grounded-answer instructions, and the assistant voice.
      dataChannel.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: REALTIME_INSTRUCTIONS,
            audio: {
              input: {
                // Disable server VAD — we drive turns manually (push-to-talk).
                turn_detection: null,
                // Transcribe the spoken question so the turn can be logged.
                transcription: { model: INPUT_TRANSCRIPTION_MODEL },
              },
              output: { voice: REALTIME_VOICE },
            },
          },
        }),
      );
      // Flush anything queued before the channel opened (e.g. grounding text).
      const queued = pendingEventsRef.current;
      pendingEventsRef.current = [];
      for (const event of queued) {
        dataChannel.send(JSON.stringify(event));
      }
    };
    dataChannel.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.log("Realtime data event (unparsed):", event.data);
        return;
      }
      if (msg.type === "error") {
        console.error("Realtime server error (full):", JSON.stringify(msg.error, null, 2));
        setRealtimeError(
          msg.error?.message ?? JSON.stringify(msg.error) ?? "Realtime server error.",
        );
      } else if (msg.type === "response.created") {
        responseActiveRef.current = true;
      } else if (msg.type === "conversation.item.input_audio_transcription.completed") {
        // Final transcript of the user's spoken question for this turn.
        pendingQuestionRef.current = msg.transcript ?? "";
      } else if (
        msg.type === "response.output_audio_transcript.delta" ||
        msg.type === "response.audio_transcript.delta"
      ) {
        // Assistant's answer text, streamed. (Accept GA + legacy event names.)
        pendingAnswerRef.current += msg.delta ?? "";
      } else if (
        msg.type === "response.output_audio_transcript.done" ||
        msg.type === "response.audio_transcript.done"
      ) {
        // Authoritative full answer transcript.
        if (msg.transcript) {
          pendingAnswerRef.current = msg.transcript;
        }
      } else if (msg.type === "output_audio_buffer.started") {
        assistantSpeakingRef.current = true;
      } else if (msg.type === "output_audio_buffer.stopped") {
        // The assistant's spoken answer finished *playing* (not just
        // generating) — now it's safe to resume narration without overlap.
        assistantSpeakingRef.current = false;
        // Guard: if the user is already holding Q for a follow-up (barge-in),
        // do NOT resume narration — the mic is live and narration would talk
        // over their new question. The resume happens after THAT turn's answer.
        if (pushToTalkActiveRef.current) {
          console.log("Assistant audio stopped, but user is mid-follow-up — not resuming");
        } else {
          console.log(`Assistant audio finished — resuming after ${RESUME_DELAY_MS}ms buffer`);
          // Hold a beat before the recap + narration so the return isn't abrupt.
          if (resumeTimeoutRef.current) {
            window.clearTimeout(resumeTimeoutRef.current);
          }
          resumeTimeoutRef.current = window.setTimeout(() => {
            resumeTimeoutRef.current = null;
            // If a new question started during the buffer, don't resume.
            if (pushToTalkActiveRef.current) return;
            resumeAfterAnswerRef.current().catch((err) => console.error("Resume failed:", err));
          }, RESUME_DELAY_MS);
        }
      } else if (msg.type === "response.done") {
        responseActiveRef.current = false;
        console.log("Realtime response complete (generation)");
        // Log the completed voice turn. Skip cancelled/incomplete responses
        // (e.g. barge-in) so we don't record interrupted answers.
        const status = msg.response?.status;
        const sessionId = sessionIdRef.current;
        if (status === "completed" && sessionId) {
          const question = pendingQuestionRef.current.trim();
          const answer = pendingAnswerRef.current.trim();
          if (question || answer) {
            logQaTurn({
              sessionId,
              askedAtIndex: askedAtIndexRef.current,
              question: question || "(question not transcribed)",
              answer: answer || "(answer not transcribed)",
              source: "voice",
            }).catch((err) => console.error("Log Q&A turn failed:", err));
          }
        }
        pendingQuestionRef.current = "";
        pendingAnswerRef.current = "";
      }
    };
    dataChannelRef.current = dataChannel;

    if (initialStream) {
      const track = initialStream.getAudioTracks()[0];
      if (track) {
        localSenderRef.current = pc.addTrack(track, initialStream);
      }
    }

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const requestUrl = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(
      REALTIME_MODEL,
    )}`;
    const sdpResponse = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
      },
      body: pc.localDescription?.sdp || "",
    });

    if (!sdpResponse.ok) {
      const text = await sdpResponse.text().catch(() => "");
      throw new Error(`Realtime connection failed (${sdpResponse.status}): ${text}`);
    }

    const sdpResult = await sdpResponse.text();
    const answerSdp = sdpResult;
    if (!answerSdp || typeof answerSdp !== "string") {
      throw new Error("Realtime call response did not contain an SDP answer.");
    }

    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    setRealtimeStatus("ready");
    return pc;
  }, [cleanupRealtimeConnection, extractRealtimeToken, getRealtimeClientSecret]);

  const beginPushToTalk = useCallback(async () => {
    if (pushToTalkActive) {
      return;
    }

    setPushToTalkActive(true);
    pushToTalkActiveRef.current = true;
    // Record where in the article this question is being asked, whether
    // narration was actually playing (gates the recap on resume), and start a
    // clean transcript buffer for the new turn.
    askedAtIndexRef.current = currentIndexRef.current;
    wasNarratingRef.current = playingRef.current;
    pendingQuestionRef.current = "";
    pendingAnswerRef.current = "";

    // Barge-in: interrupt a previous answer so it doesn't keep playing while we
    // capture the follow-up. Two independent stages to stop:
    //   1. response.cancel — only if the model is STILL generating (otherwise
    //      the API rejects it with "response_cancel_not_active").
    //   2. output_audio_buffer.clear — flush audio already buffered for playback
    //      (this is the piece still audible after generation finished).
    // The output_audio_buffer.stopped this triggers is suppressed by the
    // pushToTalkActiveRef guard above, so narration won't resume mid-follow-up.
    if (responseActiveRef.current) {
      sendRealtimeEvent({ type: "response.cancel" });
      responseActiveRef.current = false;
    }
    if (assistantSpeakingRef.current) {
      sendRealtimeEvent({ type: "output_audio_buffer.clear" });
      assistantSpeakingRef.current = false;
    }

    try {
      if (!localStreamRef.current) {
        localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        const existingTrack = localStreamRef.current.getAudioTracks()[0];
        if (!existingTrack || existingTrack.readyState === "ended") {
          localStreamRef.current.getTracks().forEach((track) => track.stop());
          localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      }

      const stream = localStreamRef.current;
      const track = stream.getAudioTracks()[0];
      if (!track) {
        throw new Error("Could not capture microphone audio.");
      }

      const pc = await createRealtimeConnection(stream);
      await pauseNarration();

      // Add the mic track to the connection exactly once; thereafter toggle
      // track.enabled per push-to-talk so the WebRTC connection stays stable
      // across turns (plan: "toggle the audio stream, not the connection").
      if (!localSenderRef.current) {
        localSenderRef.current = pc.addTrack(track, stream);
      }
      track.enabled = true;

      // Re-inject grounding on every key-down (cheap; survives reconnects).
      // Queued automatically if the data channel is still opening.
      const contextText = buildGroundingContext();
      if (contextText) {
        sendRealtimeText(`Article context for the next question:\n${contextText}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRealtimeError(message);
      setPushToTalkActive(false);
      pushToTalkActiveRef.current = false;
      console.error("Push-to-talk failed:", message);
    }
  }, [buildGroundingContext, createRealtimeConnection, pauseNarration, pushToTalkActive]);

  const endPushToTalk = useCallback(async () => {
    if (!pushToTalkActive) {
      return;
    }
    setPushToTalkActive(false);
    pushToTalkActiveRef.current = false;

    // Stop capturing but keep the connection and track alive for the next turn.
    const track = localSenderRef.current?.track;
    if (track) {
      track.enabled = false;
    }

    // Commit the captured mic audio and ask the model to respond. Narration
    // resumes when the "response.done" event arrives (see data-channel handler).
    sendRealtimeEvent({ type: "input_audio_buffer.commit" });
    sendRealtimeEvent({ type: "response.create" });
  }, [pushToTalkActive]);

  useEffect(() => {
    const element = remoteAudioRef.current;
    if (!element) return;

    element.srcObject = remoteStreamRef.current;
    element.autoplay = true;
    element.setAttribute("playsinline", "true");

    const onEnded = async () => {
      if (pendingResume) {
        setPendingResume(false);
        await resumeNarration();
      }
    };

    const onPlay = () => {
      console.log("Remote audio playing");
    };

    const onError = (event: Event) => {
      console.error("Remote audio error", event);
    };

    element.addEventListener("ended", onEnded);
    element.addEventListener("play", onPlay);
    element.addEventListener("error", onError);
    return () => {
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("error", onError);
    };
  }, [pendingResume, resumeNarration]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== PUSH_TO_TALK_KEY || event.repeat) return;
      beginPushToTalk().catch((err) => {
        console.error(err);
      });
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== PUSH_TO_TALK_KEY) return;
      endPushToTalk().catch((err) => {
        console.error(err);
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [beginPushToTalk, endPushToTalk]);

  useEffect(() => {
    return () => {
      cleanupRealtimeConnection();
    };
  }, [cleanupRealtimeConnection]);

  async function onLoad() {
    setStatus("loading");
    setError(null);
    setResult(null);
    try {
      const res = (await loadArticle({ rawText: text })) as IngestReport;
      setResult(res);
      setStatus("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }

  async function onStartNarration() {
    if (!result) return;
    setStatus("loading");
    setError(null);

    try {
      const sessionResult = await createSession({ articleId: result.articleId });
      if (sessionResult) {
        await updateSessionStatus({ sessionId: sessionResult._id, status: "narrating" });
      }
      setPlaying(true);
      setStatus("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }

  function onStopNarration() {
    setPlaying(false);
    setCurrentAudioUrl(null);
    audioRef.current?.pause();
    // Stopping is a deliberate exit — cancel any recap/pending resume and don't
    // let a later answer trigger a resume.
    wasNarratingRef.current = false;
    if (resumeTimeoutRef.current) {
      window.clearTimeout(resumeTimeoutRef.current);
      resumeTimeoutRef.current = null;
    }
    if (recapAudioRef.current) {
      recapAudioRef.current.onended = null;
      recapAudioRef.current.pause();
    }
  }

  // A paragraph's audio finished — advance to the first segment of the next
  // paragraph, or stop at the end of the article.
  async function onAdvance() {
    if (!result || !session) return;
    const next = paragraphView?.nextIndex;
    if (next == null) {
      setPlaying(false);
      setCurrentAudioUrl(null);
      return;
    }
    await advanceSession({ sessionId: session._id, nextIndex: next });
  }

  useEffect(() => {
    if (!result || !session || !playing) return;
    prefetchParagraphs({ articleId: result.articleId, currentIndex: session.currentIndex, ahead: 2 }).catch(() => {
      // ignore transient prefetch failures; playback retries on the next paragraph.
    });
  }, [result, session?.currentIndex, playing, prefetchParagraphs]);

  useEffect(() => {
    if (!playing || !paragraphView?.audioUrl) {
      setCurrentAudioUrl(null);
      return;
    }
    setCurrentAudioUrl(paragraphView.audioUrl);
  }, [paragraphView, playing]);

  useEffect(() => {
    if (!playing || !currentAudioUrl) return;
    const player = audioRef.current;
    if (!player) return;
    player.load();
    player.play().catch(() => {
      /* autoplay may be blocked until user interacts */
    });
  }, [currentAudioUrl, playing]);

  const currentParagraphText = paragraphView?.text;

  return (
    <main className="app">
      <h1>Feynman - Interactive Audiobook</h1>

      <section className="ingest">
        <textarea
          className="article-input"
          placeholder="Paste article text here…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
        />
        <button
          className="load-btn"
          disabled={text.trim().length === 0 || status === "loading"}
          onClick={onLoad}
        >
          {status === "loading" ? "Cleaning & splitting…" : "Load article"}
        </button>
      </section>

      {status === "error" && error && (
        <section className="error-box">
          <strong>Ingestion failed</strong>
          <pre>{error}</pre>
        </section>
      )}

      {result && (
        <section className="result">
          <h2>Ingested</h2>
          <p>
            {result.paragraphCount} paragraphs → <strong>{result.totalSegments} segments</strong>
          </p>

          <div className="playback-controls">
            <button className="play-btn" onClick={onStartNarration} disabled={playing || status === "loading"}>
              Start narration
            </button>
            <button className="stop-btn" onClick={onStopNarration} disabled={!playing}>
              Stop narration
            </button>
          </div>

          {session && (
            <div className="session-state">
              <p>
                Session status: <strong>{session.status}</strong>
                {typeof paragraphView?.paragraphId === "number"
                  ? <> • paragraph <strong>{paragraphView.paragraphId + 1}</strong></>
                  : null}
              </p>
            </div>
          )}

          <div className="realtime-state">
            <p>
              Realtime status: <strong>{realtimeStatus}</strong>{realtimeError ? ` • ${realtimeError}` : ""}
            </p>
          </div>

          <div className="audio-status">
            {playing ? (
              currentAudioUrl ? (
                <p>Now narrating paragraph {(paragraphView?.paragraphId ?? 0) + 1}…</p>
              ) : (
                <p>Generating audio for this paragraph…</p>
              )
            ) : (
              <p>Playback is paused. Start narration to hear the audio.</p>
            )}
          </div>

          <audio ref={audioRef} src={currentAudioUrl ?? undefined} onEnded={onAdvance} controls style={{ display: "none" }} />
          <audio ref={recapAudioRef} hidden />
          <audio ref={remoteAudioRef} autoPlay hidden />

          <section className="push-to-talk">
            <h3>Hold to ask aloud</h3>
            <p>Hold <strong>Q</strong> or press-and-hold the button, speak your question, then release.</p>
            <button
              className={`push-btn ${pushToTalkActive ? "active" : ""}`}
              onPointerDown={() => beginPushToTalk().catch((err) => console.error(err))}
              onPointerUp={() => endPushToTalk().catch((err) => console.error(err))}
              onPointerLeave={() => {
                if (pushToTalkActive) {
                  endPushToTalk().catch((err) => console.error(err));
                }
              }}
              onTouchEnd={() => endPushToTalk().catch((err) => console.error(err))}
            >
              {pushToTalkActive ? "Listening… release to answer" : "Hold to ask"}
            </button>
            <p className="push-hint">
              {pushToTalkActive ? "Microphone is live." : "Push-to-talk audio only flows while the key is held."}
            </p>
          </section>

          {currentParagraphText && (
            <section className="current-segment">
              <h3>Current paragraph</h3>
              <blockquote>{currentParagraphText}</blockquote>
            </section>
          )}

          {qaTurns && qaTurns.length > 0 && (
            <section className="qa-history">
              <h3>Q&amp;A history</h3>
              <ol className="qa-turns">
                {qaTurns.map((turn) => (
                  <li key={turn._id} className={`qa-turn source-${turn.source}`}>
                    <p className="qa-turn-meta">
                      <span className="qa-turn-source">{turn.source}</span> • asked at segment{" "}
                      {turn.askedAtIndex + 1}
                      {typeof turn.groundednessScore === "number"
                        ? ` • groundedness ${Math.round(turn.groundednessScore * 100)}%`
                        : ""}
                    </p>
                    <p className="qa-turn-q"><strong>Q:</strong> {turn.question}</p>
                    <p className="qa-turn-a"><strong>A:</strong> {turn.answer}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <h3>Fidelity report</h3>
          <table className="fidelity">
            <thead>
              <tr>
                <th>¶</th>
                <th>Fidelity</th>
                <th>Outcome</th>
                <th>Sentences</th>
              </tr>
            </thead>
            <tbody>
              {result.report.map((r) => (
                <tr key={r.paragraphId} className={`outcome-${r.outcome}`}>
                  <td>{r.paragraphId}</td>
                  <td>{r.fidelity === null ? "—" : `${Math.round(r.fidelity * 100)}%`}</td>
                  <td>{r.outcome}</td>
                  <td>{r.sentenceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Segments (verbatim check)</h3>
          <ol className="segments">
            {segments === undefined && <li className="muted">loading…</li>}
            {segments?.map((s) => (
              <li key={s._id} data-p={s.paragraphId}>
                {s.text}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
