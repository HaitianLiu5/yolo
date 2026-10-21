// The canvas engine's audio output (Agent Note 2026-04-04-canvas-playback-engine):
// it plays the PCM the main thread writes into the shared ring
// (audio-ring-buffer.js), and the media frames it played are the clock for
// the whole player. This file is loaded as it is, without a bundler, so it
// imports nothing and repeats the ring's header layout.
const READ_INDEX = 0;
const AVAILABLE_FRAMES = 2;
const RUNNING = 3;
const CONSUMED_FRAMES = 4;
const UNDERRUN_COUNT = 5;
const NEEDS_BUFFERING = 6;
const ENDED = 7;
const RATE_MILLI = 8;
const RESETS = 9;

// A playback speed other than 1 stretches the sound in time and keeps its
// pitch, as a <video> element does: WSOLA, the overlap-add of windows
// placed where the sound continues best, with Chromium's own sizes (20 ms
// windows, a search of 15 ms each way). The clock still counts media frames,
// so the picture and everything timed by it follow at any speed. At 1 the
// ring is copied out as it is.
const WINDOW_SECONDS = 0.02;
const SEARCH_SECONDS = 0.015;
// The search compares every 4th place on every 2nd sample, then every place
// around the best: a few percent of the work of a full search.
const COARSE_PLACE_STEP = 4;
const COARSE_SAMPLE_STEP = 2;

class AudioOutputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions;
    this.header = new Int32Array(config.headerBuffer);
    this.audio = new Float32Array(config.audioBuffer);
    this.capacityFrames = config.capacityFrames;
    this.channels = config.channels;
    this.resets = Atomics.load(this.header, RESETS);

    const rate = Number(globalThis.sampleRate) || 48_000;
    this.hop = Math.max(64, Math.round((rate * WINDOW_SECONDS) / 2));
    this.search = Math.round(rate * SEARCH_SECONDS);
    // A periodic Hann window: its halves, a hop apart, add up to one.
    this.window = new Float32Array(this.hop * 2);
    for (let index = 0; index < this.window.length; index += 1) {
      this.window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / this.window.length);
    }
    this.tail = Array.from({ length: this.channels }, () => new Float32Array(this.hop));
    // Output made ahead: less than a hop more than one render quantum.
    this.pending = Array.from({ length: this.channels }, () => new Float32Array(this.hop + 4096));
    this.frame = new Float32Array(this.hop * 2);
    this.template = new Float32Array(this.hop);
    this.region = new Float32Array(this.search * 2 + this.hop * 2);
    // While stretching: positions in frames from where the ring's read
    // index stood when it began.
    this.stretch = null;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frameCount = output[0]?.length || 0;

    for (const channel of output) channel.fill(0);
    // A reset (a seek, a restart) starts a new timeline in the ring.
    const resets = Atomics.load(this.header, RESETS);
    if (resets !== this.resets) {
      this.resets = resets;
      this.stretch = null;
    }
    if (!frameCount || Atomics.load(this.header, RUNNING) !== 1) return true;

    const milli = Atomics.load(this.header, RATE_MILLI);
    const rate = milli > 0 && milli !== 1000 ? milli / 1000 : 1;
    if (rate === 1 && !this.stretch) {
      const available = Atomics.load(this.header, AVAILABLE_FRAMES);
      if (available < frameCount && !this.ended()) return this.underrun(available);
      this.copy(output, 0, Math.min(available, frameCount));
      return true;
    }
    this.stretched(output, frameCount, rate);
    return true;
  }

  ended() {
    return Atomics.load(this.header, ENDED) === 1;
  }

  underrun(available) {
    if (Atomics.compareExchange(this.header, NEEDS_BUFFERING, 0, 1) === 0) {
      Atomics.add(this.header, UNDERRUN_COUNT, 1);
      this.port.postMessage({ type: "underrun", availableFrames: available });
    }
    return true;
  }

  // The ring as it is, from its read index: `frames` into the output at `at`.
  copy(output, at, frames) {
    let readIndex = Atomics.load(this.header, READ_INDEX);
    for (let frame = 0; frame < frames; frame++) {
      const sourceOffset = ((readIndex + frame) % this.capacityFrames) * this.channels;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][at + frame] = this.audio[sourceOffset + Math.min(channel, this.channels - 1)];
      }
    }
    readIndex = (readIndex + frames) % this.capacityFrames;
    Atomics.store(this.header, READ_INDEX, readIndex);
    Atomics.sub(this.header, AVAILABLE_FRAMES, frames);
    Atomics.add(this.header, CONSUMED_FRAMES, frames);
  }

  // Frees what the ring holds before `position` (stretch positions). Only
  // this thread moves the read index, outside a reset.
  release(position) {
    const stretch = this.stretch;
    const frames = position - stretch.read;
    if (frames <= 0) return;
    stretch.readIndex = (stretch.readIndex + frames) % this.capacityFrames;
    Atomics.store(this.header, READ_INDEX, stretch.readIndex);
    Atomics.sub(this.header, AVAILABLE_FRAMES, frames);
    stretch.read = position;
  }

  // `length` frames from a stretch position the ring still holds into
  // `target`: one channel's, or the channels' mix for channel -1.
  gather(channel, position, length, target) {
    const stretch = this.stretch;
    const { audio, capacityFrames, channels } = this;
    let index = (stretch.readIndex + position - stretch.read) % capacityFrames;
    for (let frame = 0; frame < length; frame++) {
      const offset = index * channels;
      if (channel >= 0) {
        target[frame] = audio[offset + channel];
      } else {
        let sum = 0;
        for (let each = 0; each < channels; each++) sum += audio[offset + each];
        target[frame] = sum / channels;
      }
      index += 1;
      if (index === capacityFrames) index = 0;
    }
  }

  stretched(output, frameCount, rate) {
    let stretch = this.stretch;
    if (!stretch) {
      const available = Atomics.load(this.header, AVAILABLE_FRAMES);
      if (available < this.hop * 2 + this.search) {
        if (!this.ended()) return this.underrun(available);
        // The last of the sound plays as it is.
        this.copy(output, 0, Math.min(available, frameCount));
        return true;
      }
      stretch = this.begin();
    }
    while (stretch.pendingFrames < frameCount && rate !== 1) {
      if (!this.synthesize(rate)) break;
    }
    if (stretch.pendingFrames < frameCount && rate !== 1 && !this.ended()) {
      return this.underrun(Atomics.load(this.header, AVAILABLE_FRAMES));
    }
    const emitted = Math.min(stretch.pendingFrames, frameCount);
    for (let channel = 0; channel < output.length; channel++) {
      output[channel].set(this.pending[Math.min(channel, this.channels - 1)].subarray(0, emitted));
    }
    if (emitted > 0) {
      for (const pending of this.pending) pending.copyWithin(0, emitted, stretch.pendingFrames);
      const media = (stretch.pendingMedia * emitted) / stretch.pendingFrames;
      stretch.pendingMedia -= media;
      stretch.pendingFrames -= emitted;
      this.advanceClock(stretch.clock + media);
    }
    if (emitted < frameCount) {
      // Back at 1 (or at the end): the sound goes on as it is from where
      // the last window's falling half left it, which that half already
      // fades out, and the clock takes that place.
      const resume = stretch.actual + this.hop;
      this.advanceClock(resume);
      this.release(resume);
      this.stretch = null;
      const available = Atomics.load(this.header, AVAILABLE_FRAMES);
      if (available < frameCount - emitted && !this.ended()) this.underrun(available);
      this.copy(output, emitted, Math.min(available, frameCount - emitted));
    }
    return true;
  }

  // The clock counts whole media frames; `clock` is the stretch position
  // now played.
  advanceClock(clock) {
    const stretch = this.stretch;
    stretch.clock = clock;
    const whole = Math.floor(clock);
    if (whole !== stretch.counted) {
      Atomics.add(this.header, CONSUMED_FRAMES, whole - stretch.counted);
      stretch.counted = whole;
    }
  }

  // The first window fades in under the falling half of one placed a hop
  // before the read index, so the sound goes on without a seam.
  begin() {
    const hop = this.hop;
    this.stretch = {
      read: 0,
      readIndex: Atomics.load(this.header, READ_INDEX),
      actual: -hop,
      nominal: -hop,
      pendingFrames: 0,
      pendingMedia: 0,
      clock: 0,
      counted: 0,
    };
    for (let channel = 0; channel < this.channels; channel++) {
      const tail = this.tail[channel];
      this.gather(channel, 0, hop, tail);
      for (let index = 0; index < hop; index++) tail[index] *= this.window[hop + index];
    }
    return this.stretch;
  }

  // One more hop of output: the next window goes where the sound after the
  // last one continues best, near where the speed puts it.
  synthesize(rate) {
    const stretch = this.stretch;
    const { hop, search } = this;
    const size = hop * 2;
    const nominal = stretch.nominal + hop * rate;
    const center = Math.round(nominal);
    const end = stretch.read + Atomics.load(this.header, AVAILABLE_FRAMES);
    const low = Math.max(stretch.read, center - search);
    let high = center + search;
    if (high + size > end) {
      if (!this.ended()) return false;
      high = end - size;
    }
    if (high < low) return false;

    const placed = this.bestPlace(stretch.actual + hop, low, high);
    const at = stretch.pendingFrames;
    const { frame, window } = this;
    for (let channel = 0; channel < this.channels; channel++) {
      const pending = this.pending[channel];
      const tail = this.tail[channel];
      this.gather(channel, placed, size, frame);
      for (let index = 0; index < hop; index++) {
        pending[at + index] = tail[index] + window[index] * frame[index];
        tail[index] = window[hop + index] * frame[hop + index];
      }
    }
    stretch.pendingFrames += hop;
    stretch.pendingMedia += hop * rate;
    stretch.actual = placed;
    stretch.nominal = nominal;
    // The ring keeps what the next window's search and its template need.
    this.release(Math.max(stretch.read, Math.min(placed + hop, Math.floor(nominal) - search)));
    return true;
  }

  // Where in [low, high] a hop of sound is most like the one at `from`
  // (normalized cross-correlation of the channels' mix).
  bestPlace(from, low, high) {
    const span = high - low;
    this.gather(-1, from, this.hop, this.template);
    this.gather(-1, low, span + this.hop, this.region);
    let best = 0;
    let bestScore = -Infinity;
    for (let offset = 0; offset <= span; offset += COARSE_PLACE_STEP) {
      const value = this.similarity(offset, COARSE_SAMPLE_STEP);
      if (value > bestScore) [best, bestScore] = [offset, value];
    }
    const coarse = best;
    bestScore = -Infinity;
    for (let offset = Math.max(0, coarse - COARSE_PLACE_STEP + 1); offset <= Math.min(span, coarse + COARSE_PLACE_STEP - 1); offset++) {
      const value = this.similarity(offset, 1);
      if (value > bestScore) [best, bestScore] = [offset, value];
    }
    return low + best;
  }

  similarity(offset, step) {
    const { hop, template, region } = this;
    let dot = 0;
    let energy = 0;
    for (let index = 0; index < hop; index += step) {
      const value = region[offset + index];
      dot += template[index] * value;
      energy += value * value;
    }
    return dot / Math.sqrt(energy + 1e-9);
  }
}

registerProcessor("yolo-audio-output-v1", AudioOutputProcessor);
