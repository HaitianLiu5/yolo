// Where each decoded audio buffer goes in the output
// (Agent Note 2026-04-04-canvas-playback-engine). The presentation clock
// counts the samples played, so the output must stay continuous in media
// time: a gap in the source's timestamps becomes silence and an overlap is
// trimmed, or the picture drifts against the sound until the next seek.

// Gaps and overlaps up to this are left alone: one AAC frame lasts about 21 ms.
export const AUDIO_GAP_TOLERANCE_SECONDS = 0.02;
// A larger jump is a broken or reset timeline, not a gap to fill: the output
// re-anchors to the source instead of playing seconds of silence.
export const AUDIO_GAP_FILL_MAX_SECONDS = 10;

/**
 * Places one buffer after the output so far.
 * @param {{ timestamp: number, frames: number, sampleRate: number }} buffer
 * @param {number} outputEnd  The media time where the output so far ends;
 *   for the first buffer, the time playback starts at.
 * @param {{ first?: boolean }} [options]  The first buffer after a start or
 *   seek is trimmed to the exact start, and that is not a discontinuity.
 * @returns {{ silenceFrames: number, startFrame: number, skip: boolean,
 *   outputEnd: number, discontinuity: "gap" | "overlap" | "jump" | null }}
 *   Write `silenceFrames` of silence, then the buffer from `startFrame`
 *   (nothing when `skip`); the output then ends at `outputEnd`.
 */
export function placeAudioBuffer({ timestamp, frames, sampleRate }, outputEnd, { first = false } = {}) {
  const duration = frames / sampleRate;
  const gap = timestamp - outputEnd;
  if (gap > AUDIO_GAP_FILL_MAX_SECONDS) {
    return { silenceFrames: 0, startFrame: 0, skip: false, outputEnd: timestamp + duration, discontinuity: "jump" };
  }
  if (gap > AUDIO_GAP_TOLERANCE_SECONDS) {
    const silenceFrames = Math.round(gap * sampleRate);
    return { silenceFrames, startFrame: 0, skip: false, outputEnd: outputEnd + silenceFrames / sampleRate + duration, discontinuity: "gap" };
  }
  if (gap < -AUDIO_GAP_TOLERANCE_SECONDS || (first && gap < 0)) {
    const discontinuity = first ? null : "overlap";
    const startFrame = Math.round(-gap * sampleRate);
    if (startFrame >= frames) return { silenceFrames: 0, startFrame: frames, skip: true, outputEnd, discontinuity };
    return { silenceFrames: 0, startFrame, skip: false, outputEnd: outputEnd + (frames - startFrame) / sampleRate, discontinuity };
  }
  return { silenceFrames: 0, startFrame: 0, skip: false, outputEnd: outputEnd + duration, discontinuity: null };
}

// A silent buffer of the shape AudioRingBuffer.writeAudioBuffer() reads.
export function silentAudioBuffer(frames, sampleRate) {
  const silence = new Float32Array(frames);
  return { length: frames, numberOfChannels: 1, sampleRate, duration: frames / sampleRate, getChannelData: () => silence };
}
