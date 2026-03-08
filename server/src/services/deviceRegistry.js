class DeviceRegistry {
  constructor() {
    this.sources = new Map();
  }

  upsertSource(meta) {
    const now = Date.now();
    const existing = this.sources.get(meta.deviceId);
    const next = {
      deviceId: meta.deviceId,
      name: meta.name,
      platform: meta.platform,
      codec: meta.codec,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      frameSamples: meta.frameSamples,
      suppressPlayback: Boolean(meta.suppressPlayback),
      volume: existing?.volume ?? 1,
      muted: existing?.muted ?? false,
      connected: true,
      active: false,
      queueDepth: 0,
      peakLevel: 0,
      latencyMs: 0,
      droppedFrames: existing?.droppedFrames ?? 0,
      lastSequence: existing?.lastSequence ?? null,
      lastFrameAt: now,
      lastSeenAt: now,
      connectedAt: existing?.connectedAt ?? now
    };

    this.sources.set(meta.deviceId, next);
    return next;
  }

  getSource(deviceId) {
    return this.sources.get(deviceId);
  }

  touchSource(deviceId, patch = {}) {
    const current = this.sources.get(deviceId);
    if (!current) {
      return null;
    }

    const next = {
      ...current,
      ...patch,
      lastSeenAt: Date.now()
    };

    this.sources.set(deviceId, next);
    return next;
  }

  setVolume(deviceId, volume) {
    return this.touchSource(deviceId, {
      volume: Math.min(Math.max(Number(volume), 0), 1)
    });
  }

  setMuted(deviceId, muted) {
    return this.touchSource(deviceId, {
      muted: Boolean(muted)
    });
  }

  markDisconnected(deviceId) {
    const current = this.sources.get(deviceId);
    if (!current) {
      return null;
    }

    const next = {
      ...current,
      connected: false,
      active: false,
      queueDepth: 0,
      peakLevel: 0,
      latencyMs: 0,
      lastSeenAt: Date.now()
    };

    this.sources.set(deviceId, next);
    return next;
  }

  incrementDroppedFrames(deviceId, count = 1) {
    const current = this.sources.get(deviceId);
    if (!current) {
      return null;
    }

    return this.touchSource(deviceId, {
      droppedFrames: current.droppedFrames + count
    });
  }

  listSources() {
    return Array.from(this.sources.values()).sort((left, right) => left.name.localeCompare(right.name, "ru"));
  }
}

module.exports = { DeviceRegistry };
