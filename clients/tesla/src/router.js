// Simple pushState router. Routes: / (home), /show/<library item id> (a
// show's episodes), /play (the player; what plays comes from Yolo).

let onNavigate = null;

export function initRouter(handler) {
  onNavigate = handler;
  window.addEventListener("popstate", () => {
    onNavigate(parseRoute(), { source: "popstate" });
  });
}

export function parseRoute() {
  const path = location.pathname;
  const showMatch = path.match(/^\/show\/([^/]+)$/);
  if (showMatch) return { view: "show", itemId: decodeURIComponent(showMatch[1]) };
  if (path === "/play") return { view: "player" };
  return { view: "browse" };
}

export const showPath = (itemId) => `/show/${encodeURIComponent(itemId)}`;

export function navigate(path, replace = false) {
  if (location.pathname + location.search === path) return false;
  if (replace) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
  }
  if (onNavigate) onNavigate(parseRoute(), { source: replace ? "replace" : "push" });
  return true;
}
