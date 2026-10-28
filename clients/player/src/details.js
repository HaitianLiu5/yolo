import { api } from "./api.js";
import { artworkImage, hydrateArtwork } from "./artwork.js";
import { dismissible, h, metaLine, runtime } from "./dom.js";
import { t } from "./i18n.js";

// What an item is (Agent Note 2026-10-25-metadata-plugins): a sheet over the
// player with its picture, synopsis, and cast with photos, from
// GET /v1/library/items/:id. A web upload matched to an episode or a film
// shows the work, and names the upload it is a copy of; details that came
// from a database carry its notice, as its terms require.

const SEASON_EPISODE = (series) => (series?.season != null && series?.episode != null ? `S${series.season} · E${series.episode}` : null);

function people(list) {
  const shown = (list ?? []).filter((person) => person.role !== "channel").slice(0, 16);
  if (!shown.length) return null;
  const row = h("ul", { class: "details-people", role: "list" }, shown.map((person) => {
    const face = h("span", { class: "details-face", html: artworkImage(person.photo ?? null) });
    return h("li", { class: "details-person" }, face,
      h("span", { class: "details-person-name", text: person.name }),
      person.character || person.role !== "cast" ? h("span", { class: "details-person-role", text: person.character ?? person.role }) : null);
  }));
  return h("section", { class: "details-section" }, h("h2", { text: t("Cast and crew") }), row);
}

/** The sheet's body for an item's details. */
export function detailsBody(item) {
  const picture = item.backdrop ?? item.still ?? item.show?.poster ?? item.poster ?? item.thumbnail ?? null;
  const series = item.series;
  const heading = item.kind === "episode" && series?.title ? series.title : item.title;
  const subtitle = item.kind === "episode" && series?.episodeTitle ? series.episodeTitle : null;
  const meta = metaLine(SEASON_EPISODE(series), item.year, runtime(item.duration), (item.genres ?? []).slice(0, 3).join(", "), item.contentRating);
  const upload = item.upload;
  const notices = item.metadata?.attributions ?? [];
  return h("div", { class: "details" },
    picture ? h("div", { class: "details-picture", html: artworkImage(picture, { eager: true }) }) : null,
    h("h2", { class: "details-title", text: heading ?? t("Untitled") }),
    subtitle ? h("p", { class: "details-subtitle", text: subtitle }) : null,
    meta ? h("p", { class: "details-meta", text: meta }) : null,
    item.description ? h("p", { class: "details-description", text: item.description }) : null,
    item.show?.description && item.show.description !== item.description
      ? h("section", { class: "details-section" }, h("h2", { text: t("About {show}", { show: item.show.title }) }), h("p", { class: "details-description", text: item.show.description }))
      : null,
    people(item.people),
    upload?.title
      ? h("section", { class: "details-section details-upload" },
        h("h2", { text: t("This copy") }),
        h("p", { text: upload.title }),
        upload.channel ? h("p", { class: "details-meta", text: t("Uploaded by {channel}", { channel: upload.channel }) }) : null)
      : null,
    notices.map((notice) => h("p", { class: "details-notice", text: notice.text })),
  );
}

export function createDetails({ dialog, body, closeButton, onClose = () => {} }) {
  let asked = 0;
  const close = () => {
    if (dialog.open) dialog.close();
  };
  dismissible(dialog, close);
  closeButton.addEventListener("click", close);
  dialog.addEventListener("close", onClose);

  return {
    /** Opens the sheet for the item with source key `itemId`, then fills it. */
    async show(itemId, { instant = false } = {}) {
      const mine = ++asked;
      dialog.classList.toggle("instant", instant);
      body.replaceChildren(h("p", { class: "details-meta", role: "status", text: t("Loading…") }));
      if (!dialog.open) dialog.showModal();
      try {
        const item = await api(`/v1/library/items/${encodeURIComponent(itemId)}`, { timeoutMs: 25_000, retries: 0, label: "Item details" });
        if (mine !== asked) return;
        body.replaceChildren(detailsBody(item));
        hydrateArtwork(body);
      } catch (error) {
        if (mine === asked) body.replaceChildren(h("p", { class: "details-meta", role: "alert", text: t("Could not load the details: {error}", { error: error.message }) }));
      }
    },
    close,
  };
}
