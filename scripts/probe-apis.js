import { execSync } from "child_process";

function getEnvVar(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execSync(`npx convex env get ${name}`, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function probe() {
  const openaiKey = getEnvVar("OPENAI_API_KEY");
  const elevenLabsKey = getEnvVar("ELEVENLABS_API_KEY");
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "alloy";

  if (!openaiKey) {
    console.error("Missing OPENAI_API_KEY. Set it locally or in Convex.");
    process.exit(1);
  }
  if (!elevenLabsKey) {
    console.error("Missing ELEVENLABS_API_KEY. Set it locally or in Convex.");
    process.exit(1);
  }

  console.log("Probing OpenAI realtime client secret endpoint...");
  const realtimeRes = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
  });
  console.log("OpenAI realtime status:", realtimeRes.status);
  console.log(await realtimeRes.text().then((t) => t.slice(0, 1000)));

  console.log("\nProbing OpenAI responses endpoint with gpt-4o-mini...");
  const responsesRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-4o-mini", input: "Hello from probe script." }),
  });
  console.log("OpenAI responses status:", responsesRes.status);
  console.log(await responsesRes.text().then((t) => t.slice(0, 1000)));

  console.log("\nProbing ElevenLabs voices endpoint...");
  const voicesRes = await fetch("https://api.elevenlabs.io/v1/voices", {
    method: "GET",
    headers: {
      "xi-api-key": elevenLabsKey,
      "Content-Type": "application/json",
    },
  });
  console.log("ElevenLabs voices status:", voicesRes.status);
  console.log(await voicesRes.text().then((t) => t.slice(0, 1000)));

  console.log(`\nProbing ElevenLabs TTS with voice id '${voiceId}'...`);
  const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`, {
    method: "POST",
    headers: {
      "xi-api-key": elevenLabsKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "Probe audio test.", model_id: "eleven_multilingual_v2", output_format: "mp3_22050_32" }),
  });
  console.log("ElevenLabs TTS status:", ttsRes.status);
  console.log(await ttsRes.text().then((t) => t.slice(0, 1000)));
}

probe().catch((err) => {
  console.error(err);
  process.exit(1);
});
