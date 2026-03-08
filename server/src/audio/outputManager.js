const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const { createLogger } = require("../utils/logger");

class OutputManager {
  constructor(config) {
    this.config = config;
    this.logger = createLogger("output");
    this.outputs = [];
    this.selectedOutputId = "default";
    this.player = null;
  }

  refreshOutputs() {
    const platform = this.config.platform || os.platform();

    if (platform === "linux") {
      this.outputs = this.#readPulseSinks();
    } else {
      this.outputs = [{ id: "default", name: "Default system output", isDefault: true }];
    }

    if (!this.outputs.length) {
      this.outputs = [{ id: "default", name: "Default system output", isDefault: true }];
    }

    const currentExists = this.outputs.some((output) => output.id === this.selectedOutputId);
    if (!currentExists) {
      const preferred = this.outputs.find((output) => output.isDefault) || this.outputs[0];
      this.selectedOutputId = preferred.id;
    }

    return this.outputs;
  }

  getState() {
    return {
      outputs: this.outputs,
      selectedOutputId: this.selectedOutputId
    };
  }

  setOutput(outputId) {
    if (!this.outputs.some((output) => output.id === outputId)) {
      throw new Error(`Unknown output device: ${outputId}`);
    }

    if (this.selectedOutputId === outputId) {
      return;
    }

    this.selectedOutputId = outputId;
    if (this.player) {
      this.logger.info("Restarting playback process for new output", { outputId });
      this.#stopPlayer();
      this.#startPlayer();
    }
  }

  write(frameBuffer) {
    if (!this.player) {
      this.#startPlayer();
    }

    if (!this.player?.stdin?.writable) {
      return;
    }

    try {
      const accepted = this.player.stdin.write(frameBuffer);
      if (!accepted) {
        this.logger.warn("Playback process backpressure detected, dropping frame");
      }
    } catch (error) {
      this.logger.warn("Playback write failed", error.message);
      this.#stopPlayer();
    }
  }

  dispose() {
    this.#stopPlayer();
  }

  #readPulseSinks() {
    const sinks = spawnSync("pactl", ["list", "short", "sinks"], {
      encoding: "utf8",
      windowsHide: true
    });
    const defaultSink = spawnSync("pactl", ["get-default-sink"], {
      encoding: "utf8",
      windowsHide: true
    });

    if (sinks.status !== 0) {
      this.logger.warn("Unable to list PulseAudio sinks, using default output");
      return [];
    }

    const defaultSinkName = defaultSink.status === 0 ? defaultSink.stdout.trim() : "";
    return sinks.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [id, name, driver, format, state, ...rest] = line.split(/\t+/);
        return {
          id: name,
          name: `${name} (${state || driver || format || id})`,
          driver,
          format,
          state,
          details: rest.join(" "),
          isDefault: name === defaultSinkName
        };
      });
  }

  #startPlayer() {
    const platform = this.config.platform || os.platform();
    const args = [];
    let command = this.config.ffmpegPath;

    if (platform === "linux") {
      args.push(
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        "pipe:0",
        "-f",
        "pulse",
        "-device",
        this.selectedOutputId,
        "audio-hub-output"
      );
    } else {
      command = this.config.ffplayPath;
      args.push(
        "-nodisp",
        "-autoexit",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ch_layout",
        "stereo",
        "-i",
        "pipe:0"
      );
    }

    this.logger.info("Starting playback process", {
      platform,
      command,
      outputId: this.selectedOutputId
    });

    this.player = spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true
    });

    this.player.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.logger.warn("Playback stderr", message);
      }
    });

    this.player.stdin.on("error", (error) => {
      this.logger.warn("Playback stdin error", error.message);
    });

    this.player.on("exit", (code, signal) => {
      this.logger.warn("Playback process exited", { code, signal });
      this.player = null;
    });

    this.player.on("error", (error) => {
      this.logger.error("Playback process failed", error.message);
      this.player = null;
    });
  }

  #stopPlayer() {
    if (!this.player) {
      return;
    }

    this.player.stdin.destroy();
    this.player.kill("SIGTERM");
    this.player = null;
  }
}

module.exports = { OutputManager };
