import { t } from "./i18n.js";

export function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("just now");
  if (min < 60) return t("{minutes}m ago", { minutes: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("{hours}h ago", { hours: hr });
  const days = Math.floor(hr / 24);
  return t("{days}d ago", { days });
}

export function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
