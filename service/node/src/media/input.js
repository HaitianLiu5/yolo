import { isAbsolute, normalize } from "node:path";
import { YoloError } from "@useyolo/core";

// The Input a source plugin's prepare() or refresh() returns, checked and
// reduced to the fields the media pipeline reads
// (Agent Note 2026-10-11-node-media-pipeline).

const MAX_ALTERNATES = 8;
const TRACK_FIELDS = ["url", "headers", "cacheKey", "codec", "width", "height", "fps", "kbps"];

function checkUrl(value, where) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) throw new YoloError("resolve_failed", `${where} must be an http(s) URL`);
  return value;
}

// Other URLs of the same bytes, in the order to try them. Invalid entries
// and repeats are dropped rather than failing the stream.
function alternatesOf(value, primary) {
  if (!Array.isArray(value)) return [];
  const urls = value.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url) && url !== primary);
  return [...new Set(urls)].slice(0, MAX_ALTERNATES);
}

// Validate the Input a plugin returned
// (Agent Note 2026-10-11-node-media-pipeline).
export function normalizeInput(input, where = "input") {
  if (!input || typeof input !== "object") throw new YoloError("resolve_failed", `${where} is missing`);
  const headers = input.headers && typeof input.headers === "object" ? { ...input.headers } : null;
  const cacheKey = typeof input.cacheKey === "function" ? input.cacheKey : null;
  if (input.type === "file") {
    const url = checkUrl(input.url, `${where}.url`);
    return { type: "file", url, headers, cacheKey, cache: input.cache !== false, alternates: alternatesOf(input.alternates, url) };
  }
  if (input.type === "hls") {
    return {
      type: "hls",
      url: checkUrl(input.url, `${where}.url`),
      headers,
      cacheKey,
      cache: input.cache !== false,
      manifest: typeof input.manifest === "string" ? input.manifest : null,
      maxBandwidth: Number(input.maxBandwidth) > 0 ? Number(input.maxBandwidth) : null,
      trimToStart: input.trimToStart === true,
      live: typeof input.live?.parse === "function" ? input.live : null,
      transcoder: input.transcoder === true,
    };
  }
  if (input.type === "split") {
    const track = (value, name) => {
      if (!value || typeof value !== "object") throw new YoloError("resolve_failed", `${where}.${name} is missing`);
      const picked = Object.fromEntries(TRACK_FIELDS.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
      const url = checkUrl(value.url, `${where}.${name}.url`);
      return { ...picked, url, cacheKey: typeof value.cacheKey === "function" ? value.cacheKey : null, alternates: alternatesOf(value.alternates, url) };
    };
    return { type: "split", video: track(input.video, "video"), audio: track(input.audio, "audio"), transcode: input.transcode === true };
  }
  if (input.type === "local") {
    // A file on the node's own disk (Agent Note 2026-10-26-folder-source).
    // The source registry has already checked that it lies under one of the
    // source's roots.
    const path = input.path;
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || normalize(path) !== path) {
      throw new YoloError("resolve_failed", `${where}.path must be an absolute, normalized path`);
    }
    const audio = Number.isInteger(input.audio) && input.audio >= 0 ? input.audio : null;
    return { type: "local", path, audio };
  }
  throw new YoloError("resolve_failed", `${where}.type must be file, hls, split or local`);
}
