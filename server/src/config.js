const os = require("node:os");
const path = require("node:path");

const frameDurationMs = Number.parseInt(process.env.AUDIO_FRAME_MS || "20", 10);
const sampleRate = Number.parseInt(process.env.AUDIO_SAMPLE_RATE || "48000", 10);
const channels = Number.parseInt(process.env.AUDIO_CHANNELS || "2", 10);
const bytesPerSample = 2;
const frameSamples = Math.floor((sampleRate * frameDurationMs) / 1000);
const bytesPerFrame = frameSamples * channels * bytesPerSample;

module.exports = {
  app: {
    host: process.env.HOST || "0.0.0.0",
    port: Number.parseInt(process.env.PORT || "4010", 10),
    publicDir: path.join(__dirname, "..", "public"),
    dashboardRefreshMs: 500
  },
  audio: {
    codec: "pcm_s16le",
    channels,
    sampleRate,
    frameDurationMs,
    frameSamples,
    bytesPerSample,
    bytesPerFrame,
    jitterTargetFrames: Number.parseInt(process.env.AUDIO_JITTER_TARGET || "3", 10),
    maxQueueFrames: Number.parseInt(process.env.AUDIO_MAX_QUEUE_FRAMES || "12", 10),
    silenceTimeoutMs: Number.parseInt(process.env.AUDIO_SILENCE_TIMEOUT_MS || "200", 10),
    activityThreshold: Number.parseInt(process.env.AUDIO_ACTIVITY_THRESHOLD || "250", 10)
  },
  output: {
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    ffplayPath: process.env.FFPLAY_PATH || "ffplay",
    platform: process.env.AUDIO_OUTPUT_PLATFORM || os.platform()
  }
};
