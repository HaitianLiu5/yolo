// What one track's decoder last did, for the telemetry of a failure
// (Agent Note 2026-10-11-device-telemetry): the decoder's state, the packets
// it was given and the frames it gave back, and the last packet. "Decoding
// error." is the same message from Chrome's video and audio decoders, and
// says nothing of where it happened.
//
// It wraps the decoder factory of one Mediabunny sample sink, which is
// Mediabunny's internal: without that shape the probe stays empty. It only
// counts and reads, and nothing it does can throw into playback.

const round3 = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);

export class DecoderProbe {
  constructor(now = () => performance.now()) {
    this.now = now;
    // The decoder of the newest iterator: a seek or restart closes the
    // older one.
    this.current = null;
  }

  // `sink` is a CanvasSink, an AudioBufferSink, or the sample sink itself.
  attach(sink) {
    const sampleSink = sink?._videoSampleSink ?? sink?._audioSampleSink ?? sink;
    const create = sampleSink?._createDecoder;
    if (typeof create !== "function") return false;
    const probe = this;
    sampleSink._createDecoder = async function createProbedDecoder(onSample, onError) {
      const record = {
        startedAt: probe.now(),
        packets: 0,
        frames: 0,
        lastPacketTimestamp: null,
        lastPacketKey: null,
        lastPacketBytes: null,
        lastFrameTimestamp: null,
        reportedError: false,
        wrapper: null,
      };
      const counted = (sample) => {
        try {
          record.frames += 1;
          record.lastFrameTimestamp = sample?.timestamp ?? null;
        } catch {}
        return onSample(sample);
      };
      // The decoder's own error (WebCodecs' error callback), as opposed to
      // one from reading packets.
      const reported = (error) => {
        record.reportedError = true;
        return onError(error);
      };
      const wrapper = await create.call(this, counted, reported);
      try {
        const decode = wrapper?.decode;
        if (typeof decode === "function") {
          wrapper.decode = function probedDecode(packet) {
            try {
              record.packets += 1;
              record.lastPacketTimestamp = packet?.timestamp ?? null;
              record.lastPacketKey = packet?.type === "key";
              record.lastPacketBytes = packet?.byteLength ?? packet?.data?.byteLength ?? null;
            } catch {}
            return decode.call(this, packet);
          };
        }
        record.wrapper = wrapper;
        probe.current = record;
      } catch {}
      return wrapper;
    };
    return true;
  }

  describe() {
    const record = this.current;
    if (!record) return null;
    const decoder = record.wrapper?.decoder ?? null;
    return {
      // True when the decoder itself reported the error.
      reportedError: record.reportedError,
      // WebCodecs closes a decoder on its error, and Mediabunny closes it
      // once its iterator ends, so this is mostly "closed".
      decoderState: decoder?.state ?? (record.wrapper?.customDecoder ? "custom" : null),
      decodeQueueSize: Number.isFinite(decoder?.decodeQueueSize) ? decoder.decodeQueueSize : null,
      decoderAgeMs: Math.round(this.now() - record.startedAt),
      packets: record.packets,
      frames: record.frames,
      // The bad packet lies after the last frame out and at or before the
      // last packet in.
      lastPacketTimestamp: round3(record.lastPacketTimestamp),
      lastPacketKey: record.lastPacketKey,
      lastPacketBytes: record.lastPacketBytes,
      lastFrameTimestamp: round3(record.lastFrameTimestamp),
    };
  }
}

// The first frame of an error's stack, with the script's file name in place
// of its URL: Mediabunny gives a decoder's error the stack of the wrapper
// that made the decoder, which names it unless the build minified the name.
export function firstStackFrame(error) {
  const lines = String(error?.stack || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const frame = lines.find((line) => line.startsWith("at ") || line.includes("@"));
  return frame ? frame.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s()]*\/([^\s/()]*)/gi, "$1").slice(0, 200) : null;
}
