const { createLogger } = require("../utils/logger");

class ControlGateway {
  constructor({ io, registry, outputManager, mixer }) {
    this.io = io;
    this.registry = registry;
    this.outputManager = outputManager;
    this.mixer = mixer;
    this.logger = createLogger("control");
  }

  attach() {
    this.io.on("connection", (socket) => {
      socket.emit("dashboard:state", this.buildState());

      socket.on("source:set-volume", ({ deviceId, volume }) => {
        this.registry.setVolume(deviceId, volume);
        this.broadcastState();
      });

      socket.on("source:set-mute", ({ deviceId, muted }) => {
        this.registry.setMuted(deviceId, muted);
        this.broadcastState();
      });

      socket.on("output:select", ({ outputId }) => {
        try {
          this.outputManager.setOutput(outputId);
          this.broadcastState();
        } catch (error) {
          socket.emit("dashboard:error", { message: error.message });
        }
      });

      socket.on("outputs:refresh", () => {
        this.outputManager.refreshOutputs();
        this.broadcastState();
      });
    });
  }

  buildState() {
    return {
      generatedAt: new Date().toISOString(),
      sources: this.registry.listSources(),
      output: this.outputManager.getState()
    };
  }

  broadcastState() {
    this.io.emit("dashboard:state", this.buildState());
    this.mixer.clearTelemetryFlag();
  }
}

module.exports = { ControlGateway };
