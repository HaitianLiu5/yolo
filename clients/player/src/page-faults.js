// Faults for in-car checks and end-to-end tests, read once from the
// address the page opened at, since the player's route drops the query
// (Agent Note 2026-04-04-canvas-playback-engine). `videoStallMs` (with
// `videoStallAt`, default 10 s) holds the canvas engine's picture decoder;
// `decodeErrorAt` makes its decoders fail at that media time, as a broken
// hardware decoder does, `decodeErrorCount` times (default 1) over every
// stream the page plays, on the `decodeErrorTrack` (`video` or `audio`).

export function readPageFaults(search) {
  const params = new URLSearchParams(search);
  const durationMs = Number(params.get("videoStallMs"));
  const stallAt = Number(params.get("videoStallAt"));
  const decodeAt = params.has("decodeErrorAt") ? Number(params.get("decodeErrorAt")) : NaN;
  const decodeCount = Number(params.get("decodeErrorCount"));
  return {
    videoStall: Number.isFinite(durationMs) && durationMs > 0
      ? { durationMs, atSeconds: Number.isFinite(stallAt) && stallAt >= 0 ? stallAt : 10 }
      : null,
    decodeError: Number.isFinite(decodeAt) && decodeAt >= 0
      ? {
        atSeconds: decodeAt,
        remaining: Number.isInteger(decodeCount) && decodeCount > 0 ? decodeCount : 1,
        track: params.get("decodeErrorTrack") === "audio" ? "audio" : "video",
      }
      : null,
  };
}

/** The faults the page opened with. */
export const pageFaults = readPageFaults(globalThis.location?.search ?? "");
