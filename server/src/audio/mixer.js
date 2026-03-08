const { createLogger } = require("../utils/logger");

class MixerEngine {
  constructor({ audioConfig, registry, outputManager }) {
    this.audioConfig = audioConfig;
    this.registry = registry;
    this.outputManager = outputManager;
    this.logger = createLogger("mixer");
    this.sources = new Map();
    this.telemetryChanged = false;

    this.tickHandle = setInterval(() => {
      this.#mixTick();
    }, this.audioConfig.frameDurationMs);
  }

  registerSource(meta) {
    const source = {
      meta,
      queue: [],
      lastCaptureTimeMs: 0,
      lastSequence: null
    };

    this.sources.set(meta.deviceId, source);
    this.registry.upsertSource(meta);
    this.telemetryChanged = true;
  }

  pushFrame(deviceId, frame) {
    const source = this.sources.get(deviceId);
    if (!source) {
      return;
    }

    if (source.queue.length >= this.audioConfig.maxQueueFrames) {
      source.queue.shift();
      this.registry.incrementDroppedFrames(deviceId);
    }

    source.queue.push(frame);
    source.lastCaptureTimeMs = frame.captureTimeMs;
    source.lastSequence = frame.sequence;
    this.registry.touchSource(deviceId, {
      queueDepth: source.queue.length,
      lastSequence: frame.sequence,
      lastFrameAt: Date.now(),
      latencyMs: Math.max(0, Date.now() - frame.captureTimeMs)
    });
    this.telemetryChanged = true;
  }

  disconnectSource(deviceId) {
    this.sources.delete(deviceId);
    this.registry.markDisconnected(deviceId);
    this.telemetryChanged = true;
  }

  getTelemetrySnapshot() {
    return {
      sources: this.registry.listSources(),
      changed: this.telemetryChanged
    };
  }

  clearTelemetryFlag() {
    this.telemetryChanged = false;
  }

  dispose() {
    clearInterval(this.tickHandle);
  }

  #mixTick() {
    const {
      bytesPerFrame,
      frameSamples,
      channels,
      jitterTargetFrames,
      silenceTimeoutMs,
      activityThreshold
    } = this.audioConfig;

    const mixed = new Int32Array(frameSamples * channels);
    const now = Date.now();
    let hasConnectedSource = false;

    for (const [deviceId, source] of this.sources.entries()) {
      const registryState = this.registry.getSource(deviceId);
      if (!registryState?.connected) {
        continue;
      }

      hasConnectedSource = true;
      while (source.queue.length > jitterTargetFrames + 2) {
        source.queue.shift();
        this.registry.incrementDroppedFrames(deviceId);
      }

      const frame = source.queue.shift();
      if (!frame && now - registryState.lastFrameAt > silenceTimeoutMs) {
        this.registry.touchSource(deviceId, {
          active: false,
          peakLevel: 0,
          queueDepth: 0,
          latencyMs: 0
        });
        continue;
      }

      if (!frame) {
        this.registry.touchSource(deviceId, {
          active: false,
          peakLevel: 0,
          queueDepth: 0
        });
        continue;
      }

      const payload = frame.payload.subarray(0, bytesPerFrame);
      const sampleCount = Math.floor(payload.length / 2);
      if (registryState.suppressPlayback) {
        this.registry.touchSource(deviceId, {
          active: peakFromPayload(payload) >= activityThreshold,
          peakLevel: peakFromPayload(payload),
          queueDepth: source.queue.length,
          latencyMs: Math.max(0, now - frame.captureTimeMs),
          lastFrameAt: now
        });
        this.telemetryChanged = true;
        continue;
      }

      const volume = registryState.muted ? 0 : registryState.volume;
      let peak = 0;

      for (let index = 0; index < sampleCount; index += 1) {
        const sample = payload.readInt16LE(index * 2);
        const adjusted = Math.round(sample * volume);
        mixed[index] += adjusted;
        peak = Math.max(peak, Math.abs(adjusted));
      }

      this.registry.touchSource(deviceId, {
        active: peak >= activityThreshold,
        peakLevel: peak,
        queueDepth: source.queue.length,
        latencyMs: Math.max(0, now - frame.captureTimeMs),
        lastFrameAt: now
      });
      this.telemetryChanged = true;
    }

    if (!hasConnectedSource) {
      return;
    }

    const outputBuffer = Buffer.allocUnsafe(bytesPerFrame);
    for (let index = 0; index < mixed.length; index += 1) {
      const clipped = Math.max(-32768, Math.min(32767, mixed[index]));
      outputBuffer.writeInt16LE(clipped, index * 2);
    }

    this.outputManager.write(outputBuffer);
  }
}

function peakFromPayload(payload) {
  let peak = 0;
  const sampleCount = Math.floor(payload.length / 2);
  for (let index = 0; index < sampleCount; index += 1) {
    peak = Math.max(peak, Math.abs(payload.readInt16LE(index * 2)));
  }

  return peak;
}

module.exports = { MixerEngine };
