import { language, t } from "./i18n.js";

// One line about a game or another event (Agent Note
// 2026-11-06-event-libraries). The score shows only while it is played: on a
// card it would give away how a game the owner has not watched ended.

const join = (...parts) => parts.filter(Boolean).join(" · ");

const score = (sides) => {
  const scores = (sides ?? []).map((side) => side.score);
  return scores.length && scores.every((value) => value !== undefined && value !== null) ? scores.join("–") : null;
};

function when(startsAt, { withTime, now }) {
  const at = new Date(startsAt);
  if (!startsAt || Number.isNaN(at.getTime())) return null;
  const day = at.toDateString() === now.toDateString()
    ? t("Today")
    : new Intl.DateTimeFormat(language(), { month: "short", day: "numeric" }).format(at);
  return withTime ? `${day} ${new Intl.DateTimeFormat(language(), { hour: "2-digit", minute: "2-digit" }).format(at)}` : day;
}

export function eventLine(event, { now = new Date() } = {}) {
  if (!event) return "";
  if (event.status === "live") return join(t("Live"), event.progress, score(event.sides));
  return join(when(event.startsAt, { withTime: event.status === "upcoming", now }), event.competition);
}
