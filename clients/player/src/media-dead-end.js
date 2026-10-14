// A screen that no media path reaches (Agent Note 2026-10-13-media-off-the-worker):
// Yolo refuses with `media_unreachable` only while the owner has the relay
// off, and its `details` say why and what fixes it. The error panel shows
// that instead of one bare sentence: the reason, each fix in words, and a
// button that turns the relay to automatic with the owner's passkey
// session, or opens settings to sign in.

const FALLBACK_FIXES = Object.freeze([
  { action: "relay", text: "Turn the relay to Automatic in Settings › Media paths: media then goes through your Cloudflare account when no direct path works" },
  { action: "remote", text: "Or set up Remote direct play in Settings › Media paths" },
]);

/** The refusal in `error` or its causes: { reason, fixes: [{ action, text }] }, or null for any other error. */
export function mediaDeadEnd(error) {
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth += 1) {
    if (current.code !== "media_unreachable" && current.apiCode !== "media_unreachable") continue;
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
