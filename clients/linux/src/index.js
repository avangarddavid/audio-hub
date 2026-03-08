const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const WebSocket = require("ws");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
const FRAME_SAMPLES = Math.floor((SAMPLE_RATE * FRAME_DURATION_MS) / 1000);
const BYTES_PER_FRAME = FRAME_SAMPLES * CHANNELS * 2;
const DEFAULT_CAPTURE_LATENCY_MS = 10;

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      continue;
    }

    const normalizedKey = key.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[normalizedKey] = next;
      index += 1;
    } else {
      args[normalizedKey] = true;
    }
  }

  return args;
}

function toAudioWebSocketUrl(server) {
  const normalized = server.replace(/\/$/, "");
  return normalized.replace(/^http/i, "ws") + "/audio";
}

function detectPulseMonitorSource() {
  if (process.env.AUDIO_HUB_PULSE_SOURCE) {
    return process.env.AUDIO_HUB_PULSE_SOURCE;
  }

  const result = spawnSync("pactl", ["get-default-sink"], {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0) {
    return "default";
  }

  const sinkName = result.stdout.trim();
  return sinkName ? `${sinkName}.monitor` : "default";
}

function commandExists(command) {
  const probe = spawnSync(command, ["--help"], {
    windowsHide: true,
    stdio: "ignore"
  });

  return probe.status === 0 || probe.error?.code !== "ENOENT";
}

class LinuxAudioHubClient {
  constructor(options) {
    this.options = options;
    this.ws = null;
    this.capture = null;
    this.sequence = 0;
    this.pendingPcm = Buffer.alloc(0);
    this.reconnectTimer = null;
  }

  start() {
    this.#connectWebSocket();
    this.#startCapture();
  }

  stop() {
    clearTimeout(this.reconnectTimer);

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.capture) {
      this.capture.kill("SIGTERM");
      this.capture = null;
    }
  }

  #connectWebSocket() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.ws = new WebSocket(this.options.audioUrl);

    this.ws.on("open", () => {
      const hello = {
        type: "hello",
        deviceId: this.options.deviceId,
        name: this.options.name,
        platform: "linux",
        codec: "pcm_s16le",
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        frameSamples: FRAME_SAMPLES
      };

      console.log(`[linux-client] connected to ${this.options.audioUrl}`);
      this.ws.send(JSON.stringify(hello));
    });

    this.ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        return;
      }

      try {
        const message = JSON.parse(raw.toString("utf8"));
        if (message.type === "error") {
          console.error(`[linux-client] server error: ${message.message}`);
        }
      } catch (error) {
        console.error(`[linux-client] invalid server message: ${error.message}`);
      }
    });

    this.ws.on("close", () => {
      console.warn("[linux-client] socket closed, reconnecting in 3s");
      this.ws = null;
      this.reconnectTimer = setTimeout(() => this.#connectWebSocket(), 3000);
    });

    this.ws.on("error", (error) => {
      console.error(`[linux-client] websocket error: ${error.message}`);
    });
  }

  #startCapture() {
    const backend = this.options.captureBackend === "auto"
      ? (commandExists("parec") ? "parec" : "ffmpeg")
      : this.options.captureBackend;

    if (backend === "parec") {
      const parecArgs = [
        "--device",
        this.options.pulseSource,
        "--format=s16le",
        `--rate=${SAMPLE_RATE}`,
        `--channels=${CHANNELS}`,
        `--latency-msec=${this.options.captureLatencyMs}`
      ];

      console.log(
        `[linux-client] capture backend: parec, source=${this.options.pulseSource}, latency=${this.options.captureLatencyMs}ms`
      );
      this.capture = spawn("parec", parecArgs, {
        stdio: ["ignore", "pipe", "pipe"]
      });
    } else {
      const ffmpegArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-thread_queue_size",
        "32",
        "-f",
        "pulse",
        "-i",
        this.options.pulseSource,
        "-ac",
        String(CHANNELS),
        "-ar",
        String(SAMPLE_RATE),
        "-f",
        "s16le",
        "-flush_packets",
        "1",
        "pipe:1"
      ];

      console.log(`[linux-client] capture backend: ffmpeg, source=${this.options.pulseSource}`);
      this.capture = spawn(this.options.ffmpegPath, ffmpegArgs, {
        stdio: ["ignore", "pipe", "pipe"]
      });
    }

    this.capture.stdout.on("data", (chunk) => {
      this.pendingPcm = Buffer.concat([this.pendingPcm, chunk]);

      while (this.pendingPcm.length >= BYTES_PER_FRAME) {
        const frame = this.pendingPcm.subarray(0, BYTES_PER_FRAME);
        this.pendingPcm = this.pendingPcm.subarray(BYTES_PER_FRAME);
        this.#sendAudioFrame(frame);
      }
    });

    this.capture.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        console.error(`[linux-client] ffmpeg: ${message}`);
      }
    });

    this.capture.on("exit", (code) => {
      console.warn(`[linux-client] ffmpeg exited with code ${code}`);
      this.capture = null;
    });

    this.capture.on("error", (error) => {
      console.error(`[linux-client] failed to start ffmpeg: ${error.message}`);
    });
  }

  #sendAudioFrame(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const packet = Buffer.allocUnsafe(12 + payload.length);
    packet.writeBigUInt64LE(BigInt(Date.now()), 0);
    packet.writeUInt32LE(this.sequence, 8);
    payload.copy(packet, 12);

    this.sequence = (this.sequence + 1) >>> 0;
    this.ws.send(packet, { binary: true });
  }
}

const args = parseArgs(process.argv.slice(2));
const serverUrl = args.server || process.env.AUDIO_HUB_SERVER || "http://127.0.0.1:4010";
const client = new LinuxAudioHubClient({
  name: args.name || process.env.AUDIO_HUB_NAME || os.hostname(),
  deviceId: args["device-id"] || process.env.AUDIO_HUB_DEVICE_ID || `linux-${os.hostname()}`,
  audioUrl: toAudioWebSocketUrl(serverUrl),
  pulseSource: args.source || detectPulseMonitorSource(),
  ffmpegPath: args.ffmpeg || process.env.FFMPEG_PATH || "ffmpeg",
  captureBackend: args.backend || process.env.AUDIO_HUB_CAPTURE_BACKEND || "auto",
  captureLatencyMs: Number.parseInt(
    args["latency-ms"] || process.env.AUDIO_HUB_CAPTURE_LATENCY_MS || String(DEFAULT_CAPTURE_LATENCY_MS),
    10
  )
});

client.start();

process.on("SIGINT", () => {
  client.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  client.stop();
  process.exit(0);
});
