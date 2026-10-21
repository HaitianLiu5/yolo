// Simple pushState router. Routes: / (home), /show/<library item id> (a
// show's episodes), /play (the player; what plays comes from Yolo),
// /settings (the settings sheet over the home screen), and /s/<token>, a
// share link's page, which is a friend's only page: nothing moves it to
// /play or home (Agent Note 2026-10-20-share-links).

const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]+)$/;

let onNavigate = null;

export function initRouter(handler) {
  onNavigate = handler;
  window.addEventListener("popstate", () => {
    onNavigate(parseRoute(), { source: "popstate" });
  });
}

export function parseRoute() {
  const path = location.pathname;
  const shareMatch = path.match(SHARE_PATH);
  if (shareMatch) return { view: "share", token: shareMatch[1] };
  const showMatch = path.match(/^\/show\/([^/]+)$/);
  if (showMatch) return { view: "show", itemId: decodeURIComponent(showMatch[1]) };
  if (path === "/play") return { view: "player" };
  if (path === "/settings") return { view: "settings" };
  return { view: "browse" };
}

export const showPath = (itemId) => `/show/${encodeURIComponent(itemId)}`;

export function navigate(path, replace = false) {
  if (location.pathname + location.search === path || SHARE_PATH.test(location.pathname)) return false;
  if (replace) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
  }
  if (onNavigate) onNavigate(parseRoute(), { source: replace ? "replace" : "push" });
  return true;
}
