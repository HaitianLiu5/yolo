import { YoloError } from "./errors.js";

// A position in a video as an agent or a person writes it: seconds (754 or
// "754.5"), "mm:ss", or "hh:mm:ss", each with optional fractions
// (Agent Note 2026-10-13-video-frames).

const CLOCK = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/;
const SECONDS = /^\d+(?:\.\d+)?$/;

const invalid = (value) => new YoloError("invalid_request", `time must be seconds or "hh:mm:ss", not ${JSON.stringify(value)}`);

export function parseTimestamp(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw invalid(value);
    return value;
  }
  const text = String(value ?? "").trim();
  if (SECONDS.test(text)) return Number(text);
  const clock = CLOCK.exec(text);
  if (!clock) throw invalid(value);
  const [, hours, minutes, seconds] = clock;
  // "1:75" is a typo, not 2:15; the first field may be any size ("90:00").
  if (Number(seconds) >= 60 || (hours !== undefined && Number(minutes) >= 60)) throw invalid(value);
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

// "m:ss", "h:mm:ss" from an hour on, or with `millis` "12:34.500"; a
// negative or unreadable value is 0:00.
export function formatTimestamp(seconds, { millis = false } = {}) {
  const total = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(total);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  const fraction = millis ? `.${String(Math.round((total - whole) * 1000) % 1000).padStart(3, "0")}` : "";
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}${fraction}` : `${minutes}:${rest}${fraction}`;
}
