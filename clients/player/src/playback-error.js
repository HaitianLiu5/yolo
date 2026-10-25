// What the error panel says when playback gives up (Agent Note
// 2026-10-11-device-telemetry): one sentence, and the details stay in the
// device events and /diag. Two errors say more. A screen that no media
// path reaches (Agent Note 2026-10-13-media-off-the-worker) gets the reason
// and each fix, since Yolo refuses with `media_unreachable` only while the
// owner has the relay off, and its `details` say why and what fixes it. An
// item its source no longer has under any id Yolo can find (Agent Note
// 2026-10-21-moved-library-items) says so, and trying again cannot play it.

export const FAILED_TEXT = "This video can't play right now.";
export const DEAD_END_TEXT = "No media path reaches this screen.";
export const GONE_TEXT = "This video is no longer in the library.";

const FALLBACK_FIXES = Object.freeze([
  { action: "relay", text: "Turn the relay to Automatic in Settings › Media paths: media then goes through your Cloudflare account when no direct path works" },
  { action: "remote", text: "Or set up Remote direct play in Settings › Media paths" },
]);

// `error` and the errors it wraps, as far as an error wraps another.
function* causes(error) {
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth += 1) yield current;
}

const hasCode = (error, code) => error.code === code || error.apiCode === code;

// The refusal of a screen no path reaches: { reason, fixes: [{ action, text }] }.
function deadEnd(error) {
  for (const current of causes(error)) {
    if (!hasCode(current, "media_unreachable")) continue;
    const refusal = current.code === "media_unreachable" ? current : current.cause ?? current;
    const details = refusal.details && typeof refusal.details === "object" ? refusal.details : null;
    const fixes = Array.isArray(details?.fixes) && details.fixes.length
      ? details.fixes.filter((fix) => typeof fix?.text === "string").map((fix) => ({ action: String(fix.action || ""), text: fix.text }))
      : FALLBACK_FIXES;
    const reason = typeof details?.reason === "string" ? details.reason : String(refusal.message || "").split(". ")[0];
    return { reason, fixes };
  }
  return null;
}

// On a share link's page (Agent Note 2026-10-20-share-links) a `not_found`
// is the link's: Yolo's own words for the friend say whether it expired or
// was revoked.
function goneText(error, share) {
  if (!share) return GONE_TEXT;
  const refusal = [...causes(error)].find((current) => current.name === "ApiError" && current.code === "not_found" && current.message);
  return refusal?.message ?? GONE_TEXT;
}

/**
 * What the panel says for `error`, and whether Try again can help:
 * { kind: "dead_end" | "gone" | "failed", text, reason, fixes, retry }.
 * `share` is a share link's page.
 */
export function describePlaybackError(error, { share = false } = {}) {
  const unreachable = deadEnd(error);
  if (unreachable) return { kind: "dead_end", text: DEAD_END_TEXT, ...unreachable, retry: true };
  if ([...causes(error)].some((current) => hasCode(current, "not_found"))) {
    return { kind: "gone", text: goneText(error, share), reason: "", fixes: [], retry: false };
  }
  return { kind: "failed", text: FAILED_TEXT, reason: "", fixes: [], retry: true };
}
