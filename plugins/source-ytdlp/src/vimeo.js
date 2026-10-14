// Vimeo through yt-dlp. yt-dlp reads a video's own page (vimeo.com/<id>, or
// an unlisted vimeo.com/<id>/<hash>) with its web client, which needs a
// signed-in Vimeo account; without one it fails with "The web client only
// works when logged-in". The embed player, player.vimeo.com/video/<id>?h=<hash>,
// plays the same video anonymously, so ytdlp.js asks it after that error.
// With Vimeo cookies (the cookie options) the page answers and stays in use.

const LOGIN_REQUIRED = /\bweb client only works when logged-in\b/i;

// yt-dlp's VimeoIE pattern for one video on vimeo.com: an optional path
// (channels/<name>/, groups/<name>/videos/, showcase/<id>/video/), the id,
// then an unlisted video's hash. A collection's own page is not one video.
const COLLECTION = /^\/(?:channels|album|showcase|groups)\/[^/]+\/?$/i;
const VIDEO_PATH = /^\/(?:[^?#]*?\/)??(?:videos?\/)?(\d+)(?:\/([\da-f]{10}))?\/?$/i;

export const needsVimeoLogin = (error) => LOGIN_REQUIRED.test(String(error?.message || ""));

// The embed player's URL for a vimeo.com video page, else null.
export function vimeoPlayerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/^(?:www\.)?vimeo\.com$/i.test(url.hostname) || COLLECTION.test(url.pathname)) return null;
  const match = VIDEO_PATH.exec(url.pathname);
  if (!match) return null;
  const player = new URL(`https://player.vimeo.com/video/${match[1]}`);
  const hash = match[2] || url.searchParams.get("h");
  if (hash && /^[\da-f]+$/i.test(hash)) player.searchParams.set("h", hash);
  return player.href;
}
