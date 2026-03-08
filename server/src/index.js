const http = require("node:http");
const os = require("node:os");
const express = require("express");
const { Server } = require("socket.io");
const { WebSocketServer } = require("ws");

const config = require("./config");
const { decodeAudioFrame, decodeHelloMessage } = require("./protocol/audioProtocol");
const { DeviceRegistry } = require("./services/deviceRegistry");
const { OutputManager } = require("./audio/outputManager");
const { MixerEngine } = require("./audio/mixer");
const { ControlGateway } = require("./gateways/controlGateway");
const { createLogger } = require("./utils/logger");

const logger = createLogger("server");
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*"
  }
});

const registry = new DeviceRegistry();
const outputManager = new OutputManager(config.output);
outputManager.refreshOutputs();
const mixer = new MixerEngine({
  audioConfig: config.audio,
  registry,
  outputManager
});
const controlGateway = new ControlGateway({
  io,
  registry,
  outputManager,
  mixer
});
const audioWss = new WebSocketServer({ noServer: true });
const audioConnections = new Map();
const localHostName = os.hostname().toLowerCase();
const localWindowsDeviceId = `windows-${localHostName}`;

app.use(express.json());
app.use(express.static(config.app.publicDir));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    generatedAt: new Date().toISOString()
  });
});

app.get("/api/config", (_request, response) => {
  response.json({
    audio: config.audio,
    output: outputManager.getState()
  });
});

controlGateway.attach();

audioWss.on("connection", (socket, request) => {
  let deviceId = null;
  let helloReceived = false;
  const remoteAddress = request?.socket?.remoteAddress || "";

  const handshakeTimeout = setTimeout(() => {
    if (!helloReceived) {
      socket.close(1008, "hello timeout");
    }
  }, 5000);

  socket.on("message", (raw, isBinary) => {
    try {
      if (!helloReceived) {
        if (isBinary) {
          throw new Error("Expected hello JSON before binary frames");
        }

        const hello = decodeHelloMessage(raw);
        if (
          hello.codec !== config.audio.codec ||
          Number(hello.sampleRate) !== config.audio.sampleRate ||
          Number(hello.channels) !== config.audio.channels ||
          Number(hello.frameSamples) !== config.audio.frameSamples
        ) {
          throw new Error("Audio format mismatch with server configuration");
        }

        const clientHostName = String(hello.machineName || "").trim().toLowerCase();
        const clientDeviceId = String(hello.deviceId || "").trim().toLowerCase();
        const isLocalSocket =
          remoteAddress === "::1" ||
          remoteAddress === "::ffff:127.0.0.1" ||
          remoteAddress === "127.0.0.1";
        const clientIsLocalWindowsLoopback =
          config.output.platform === "win32" &&
          hello.platform === "windows" &&
          (
            isLocalSocket ||
            clientHostName === localHostName ||
            clientDeviceId === localWindowsDeviceId
          );

        if (clientIsLocalWindowsLoopback && process.env.ALLOW_LOCAL_LOOPBACK !== "1") {
          hello.suppressPlayback = true;
          logger.warn("Suppressing playback for local Windows loopback source to avoid recursive audio", {
            deviceId: hello.deviceId,
            machineName: hello.machineName || null
          });
        }

        helloReceived = true;
        clearTimeout(handshakeTimeout);
        deviceId = hello.deviceId;

        const previousSocket = audioConnections.get(deviceId);
        if (previousSocket && previousSocket !== socket) {
          logger.warn("Replacing existing audio connection for device", { deviceId });
          previousSocket.close(1012, "replaced by a newer connection");
        }

        audioConnections.set(deviceId, socket);
        mixer.registerSource(hello);
        controlGateway.broadcastState();

        socket.send(
          JSON.stringify({
            type: "ready",
            serverTimeMs: Date.now(),
            frameDurationMs: config.audio.frameDurationMs
          })
        );
        logger.info("Audio source connected", {
          deviceId: hello.deviceId,
          name: hello.name,
          platform: hello.platform
        });
        return;
      }

      if (!isBinary) {
        return;
      }

      const frame = decodeAudioFrame(raw, config.audio.bytesPerFrame);
      mixer.pushFrame(deviceId, frame);
    } catch (error) {
      logger.warn("Audio socket error", error.message);
      socket.send(JSON.stringify({ type: "error", message: error.message }));
    }
  });

  socket.on("close", () => {
    clearTimeout(handshakeTimeout);
    if (deviceId && audioConnections.get(deviceId) === socket) {
      audioConnections.delete(deviceId);
      mixer.disconnectSource(deviceId);
      controlGateway.broadcastState();
      logger.info("Audio source disconnected", { deviceId });
    }
  });
});

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/audio") {
    socket.destroy();
    return;
  }

  audioWss.handleUpgrade(request, socket, head, (ws) => {
    audioWss.emit("connection", ws, request);
  });
});

setInterval(() => {
  const snapshot = mixer.getTelemetrySnapshot();
  if (snapshot.changed) {
    controlGateway.broadcastState();
  }
}, config.app.dashboardRefreshMs);

httpServer.listen(config.app.port, config.app.host, () => {
  logger.info("Audio hub server started", {
    host: config.app.host,
    port: config.app.port
  });
});

function shutdown() {
  logger.info("Shutting down");
  mixer.dispose();
  outputManager.dispose();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
