// What a browser's languages mean to Yolo's own pages, the player's and the
// ones the control plane renders (Agent Note 2026-10-26-player-language).

// Where a screen's choice reaches the server. The player keeps the choice in
// localStorage, which a page rendered on the server never sees, and mirrors
// it in this cookie; an automatic screen has none.
export const LANGUAGE_COOKIE = "yolo-language";

/**
 * The language a browser's tags mean, in the order it prefers them: the first
 * that is Chinese, in any script or region, is Simplified Chinese, the first
 * that is English is English, and none of either is English.
 */
export function languageFromTags(tags) {
  for (const tag of tags ?? []) {
    const primary = typeof tag === "string" ? tag.trim().split("-")[0].toLowerCase() : "";
    if (primary === "zh") return "zh-Hans";
    if (primary === "en") return "en";
  }
  return "en";
}
