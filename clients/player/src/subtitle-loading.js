// How the player loads the text subtitles selected for a stream, and what
// it tells the owner when one does not load. The stream waits for the first
// round only. A track the node answered 429 or 425 with a Retry-After of at
// most MAX_SUBTITLE_RETRY_WAIT_MS (a site limiting its subtitles, a subtitle
// still being prepared) is asked for once more after that wait, in the
// background; the notice names the tracks that never loaded, once both
// rounds are over, and says nothing for a track that loaded on its second
// try.

import { t } from "./i18n.js";

const MAX_SUBTITLE_RETRY_WAIT_MS = 2 * 60_000;

// The wait a Retry-After asks for, in milliseconds (seconds or an HTTP
// date), or null without a usable one.
export function retryAfterMs(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// `load(track)` is true once the track loaded, null when it was superseded
// (another stream or selection), else `{ retryAfterMs }` (a number, or null
// for a failure not worth asking again). `wait(ms)` sleeps; `current()` says
// whether this stream and selection still stand; `loadedLater()` runs when
// the second round loaded a track. Resolves after the first round with
// `{ failed, later }`: the tracks of the first round that failed for good,
// and a promise of all the tracks that never loaded, empty when the stream
// or selection moved on.
export async function loadSubtitleTracks(tracks, { load, wait, current = () => true, loadedLater = () => {} }) {
  const first = await Promise.all(tracks.map(async (track) => ({ track, result: await load(track) })));
  const failed = [];
  const again = [];
  for (const { track, result } of first) {
    if (result === true || result === null) continue;
    const delay = result?.retryAfterMs == null ? NaN : Number(result.retryAfterMs);
    if (Number.isFinite(delay) && delay >= 0 && delay <= MAX_SUBTITLE_RETRY_WAIT_MS) again.push({ track, delay });
    else failed.push(track);
  }
  const later = (async () => {
    const results = await Promise.all(again.map(async ({ track, delay }) => {
      await wait(delay);
      if (!current()) return { track, result: null };
      return { track, result: await load(track) };
    }));
    if (current() && results.some(({ result }) => result === true)) loadedLater();
    if (!current()) return [];
    return [...failed, ...results.filter(({ result }) => result !== true && result !== null).map(({ track }) => track)];
  })();
  return { failed, later };
}

const trackName = (track) => String(track?.name || track?.language || "").trim();

function list(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return t("{first} and {second}", { first: names[0], second: names[1] });
  return t("{list}, and {last}", { list: names.slice(0, -1).join(t(", ")), last: names.at(-1) });
}

// The notice for subtitles that did not load, naming them, or null.
export function subtitleFailureNotice(tracks = []) {
  if (!tracks.length) return null;
  const names = [...new Set(tracks.map(trackName))];
  if (names.some((name) => !name)) return tracks.length === 1 ? t("A subtitle could not be loaded") : t("Some subtitles could not be loaded");
  return t("{names} subtitles could not be loaded", { names: list(names) });
}
