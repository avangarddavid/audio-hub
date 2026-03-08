function decodeHelloMessage(raw) {
  const hello = JSON.parse(raw.toString("utf8"));
  const requiredFields = ["deviceId", "name", "platform", "sampleRate", "channels", "frameSamples", "codec"];

  for (const field of requiredFields) {
    if (!hello[field] && hello[field] !== 0) {
      throw new Error(`Missing hello field: ${field}`);
    }
  }

  return hello;
}

function decodeAudioFrame(buffer, expectedPayloadBytes) {
  if (buffer.length < 12) {
    throw new Error("Frame is too small");
  }

  const captureTimeMs = Number(buffer.readBigUInt64LE(0));
  const sequence = buffer.readUInt32LE(8);
  const payload = buffer.subarray(12);

  if (expectedPayloadBytes && payload.length !== expectedPayloadBytes) {
    throw new Error(`Unexpected payload size ${payload.length}, expected ${expectedPayloadBytes}`);
  }

  return {
    captureTimeMs,
    sequence,
    payload
  };
}

module.exports = {
  decodeHelloMessage,
  decodeAudioFrame
};
