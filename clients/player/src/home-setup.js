import { renderSVG } from "uqr";
import { api } from "./api.js";
import { h, icons } from "./dom.js";
import { language, t } from "./i18n.js";
import { KIND_KEY } from "./mode.js";
import { owner, ownerSignedIn, passkeysSupported, signInWithPasskey } from "./owner.js";
import { localText } from "./plugins-settings.js";

// The home's cold start (Agent Note 2026-10-31-home-cold-start): the first
// time a paired screen opens a home that was never set up, it asks "Where
// do you usually watch?" and offers the places the node's catalog names.
// Choosing turns their plugins on, with the owner's passkey, and walks
// through connecting each; Skip is on every step. Yolo keeps the answer per
// owner (GET and PUT /v1/setup), so no other screen asks again; a skipped
// home keeps one quiet "Add where you watch" at its end, and Settings ›
// Plugins opens the guide again.
//
// A browser on a phone or computer signs in and chooses here. The car and a
// TV never ask for typing or a passkey: they show the places with a QR code
// to this page on the owner's phone, and follow /v1/setup until the owner
// answers there.

const POLL_MS = 2_000;
// The answer is asked again when a home loads after this long.
const FRESH_MS = 60_000;
const GROUP_ORDER = ["files", "site", "agent"];
const GROUP_ICONS = {
  files: '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
  site: '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.99 7.99 0 0 1 5.08 16zm2.95-8H5.08a7.99 7.99 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z"/></svg>',
  agent: icons.agent,
};

let setup = null; // the last answer of GET /v1/setup
let askedAt = 0;
let reloadHome = () => {};
let poll = null;
let guideOpen = false;

const root = () => document.getElementById("home-setup");
const entry = () => document.getElementById("home-setup-entry");

// Typing and the passkey ceremony happen on a phone or computer, never in
// the car or on a TV.
function choosesHere() {
  let kind = null;
  try {
    kind = localStorage.getItem(KIND_KEY);
  } catch {
    // Private mode: the fingerprint alone.
  }
  return document.documentElement.dataset.mode !== "car" && kind !== "tv" && passkeysSupported();
}

// Places in the order a screen offers them: the owner's own files, then
// sites (those that name this screen's language first), then the agent.
function ordered(places) {
  const lang = language().split("-")[0];
  const rank = (place) => GROUP_ORDER.indexOf(place.group) * 10 + (place.group === "site" && !place.languages?.some((tag) => tag.split("-")[0] === lang) ? 1 : 0);
  return [...places].sort((left, right) => rank(left) - rank(right));
}

async function readSetup() {
  setup = await api("/v1/setup", { label: "Setup", retries: 0, timeoutMs: 20_000 });
  askedAt = Date.now();
  return setup;
}

async function saveState(state) {
  setup = { ...(setup ?? {}), ...(await api("/v1/setup", { method: "PUT", body: { state }, label: "Setup", retries: 0 })) };
  showEntry();
}

function showEntry() {
  entry()?.classList.toggle("hidden", setup?.state !== "skipped" || !setup?.places?.length);
}

/**
 * The home screen showed (browse.js): ask whether the owner answered, and
 * open the guide on a new home, or show the quiet entry on a skipped one.
 * `reload` loads the home again once places are on.
 */
export async function checkHomeSetup({ reload }) {
  reloadHome = reload;
  if (guideOpen) return;
  try {
    if (!setup || Date.now() - askedAt > FRESH_MS) await readSetup();
  } catch {
    // An older Yolo, or none reachable: the home as it is.
    return;
  }
  showEntry();
  if (setup.state === "new" && setup.available && setup.places.length) await showGuide();
}

/** Opens the guide on this screen, whatever the owner answered before. */
export async function showGuide() {
  if (guideOpen) return;
  try {
    await readSetup();
  } catch (error) {
    console.warn("[setup] Cannot read the places:", error);
    return;
  }
  if (!setup.available) return;
  guideOpen = true;
  turnedOn = false;
  const element = root();
  element.classList.remove("hidden");
  // Opened again: the places already on start chosen, with what they
  // brought along as it is now.
  const on = setup.places.filter((place) => place.state === "on");
  if (choosesHere()) renderChoose(new Set(on.map((place) => place.id)), new Map(on.map((place) => [place.id, new Set(place.with.filter((plugin) => !plugin.enabled).map((plugin) => plugin.name))])));
  else renderElsewhere();
  element.querySelector("button")?.focus({ preventScroll: true });
}

function close({ reload = false } = {}) {
  clearInterval(poll);
  poll = null;
  guideOpen = false;
  root().classList.add("hidden");
  root().replaceChildren();
  showEntry();
  if (reload) void Promise.resolve().then(reloadHome).catch((error) => console.error("[setup] Failed to load the home screen:", error));
}

// Skip: before any place is on, the guide is skipped; after (a connect
// step), the owner chose, and connecting waits for Settings.
let turnedOn = false;
async function skip() {
  if (turnedOn) return finish();
  try {
    await saveState("skipped");
  } catch (error) {
    console.warn("[setup] Could not keep the skip:", error);
  }
  close();
}

function frame(...children) {
  const skipButton = h("button", { type: "button", class: "browse-button home-setup-skip", onclick: () => void skip() }, t("Skip for now"));
  root().replaceChildren(h("div", { class: "home-setup-body" },
    h("h1", { id: "home-setup-title", class: "home-setup-title" }, t("Where do you usually watch?")),
    h("p", { class: "home-setup-lead" }, t("Links always play: paste one, or ask your agent.")),
    ...children,
    skipButton));
}

function placeCard(place, { chosen = null, onToggle = null } = {}) {
  const pressed = chosen?.has(place.id) ?? false;
  const brings = place.with.map((plugin) => localText(plugin.title)).filter(Boolean);
  const inner = [
    h("span", { class: "home-setup-icon", html: GROUP_ICONS[place.group] ?? GROUP_ICONS.site }),
    h("span", { class: "home-setup-card-text" },
      h("span", { class: "home-setup-card-title" }, localText(place.title)),
      h("span", { class: "home-setup-card-meta" }, localText(place.summary)),
      brings.length ? h("span", { class: "home-setup-card-meta" }, t("With {plugins}", { plugins: brings.join(", ") })) : null),
  ];
  if (!onToggle) return h("li", { class: `home-setup-card${place.group === "agent" ? " secondary" : ""}` }, inner);
  return h("li", {}, h("button", {
    type: "button",
    class: `home-setup-card${place.group === "agent" ? " secondary" : ""}`,
    "data-place": place.id,
    "aria-pressed": String(pressed),
    onclick: onToggle,
  }, inner, h("span", { class: "home-setup-check", html: icons.check })));
}

// What a place brings along, each with what it sends and a box to leave it off.
function bringsAlong(place, without) {
  if (!place.with.length) return null;
  return h("fieldset", { class: "home-setup-with" },
    h("legend", {}, t("{place} also turns on", { place: localText(place.title) })),
    place.with.map((plugin) => h("label", { class: "home-setup-with-item" },
      h("input", {
        type: "checkbox",
        checked: !without.has(plugin.name),
        onchange: (event) => {
          if (event.target.checked) without.delete(plugin.name);
          else without.add(plugin.name);
        },
      }),
      h("span", {}, h("span", { class: "home-setup-card-title" }, localText(plugin.title)), plugin.privacy ? h("span", { class: "home-setup-card-meta" }, localText(plugin.privacy)) : null))));
}

// A phone or computer: choose, then sign in and turn them on.
function renderChoose(chosen, without = new Map()) {
  const places = ordered(setup.places);
  const status = h("p", { class: "home-setup-status", role: "status", "aria-live": "polite" });
  const go = h("button", { type: "button", class: "browse-button primary", disabled: !chosen.size }, t("Continue"));
  go.addEventListener("click", () => void turnOn([...chosen], without, status, go));
  frame(
    h("ul", { class: "home-setup-places", role: "list" }, places.map((place) => placeCard(place, {
      chosen,
      onToggle: () => {
        if (chosen.has(place.id)) chosen.delete(place.id);
        else chosen.add(place.id);
        if (!without.has(place.id)) without.set(place.id, new Set());
        renderChoose(chosen, without);
        root().querySelector(`[data-place="${place.id}"]`)?.focus({ preventScroll: true });
      },
    }))),
    ...places.filter((place) => chosen.has(place.id)).map((place) => bringsAlong(place, without.get(place.id) ?? new Set())),
    h("div", { class: "home-setup-actions" }, go),
    status,
  );
}

async function turnOn(ids, without, status, button) {
  button.disabled = true;
  try {
    if (!(await ownerSignedIn())) {
      status.textContent = t("Waiting for your passkey…");
      await signInWithPasskey();
    }
    for (const id of ids) {
      const place = setup.places.find((candidate) => candidate.id === id);
      status.textContent = t("Turning on {place}…", { place: localText(place?.title) || id });
      await owner.setPlace(id, { enabled: true, without: [...(without.get(id) ?? [])] });
    }
    turnedOn = true;
    await connectSteps(ids);
  } catch (error) {
    status.textContent = error?.message || String(error);
    button.disabled = false;
  }
}

// Each chosen place that connects with typed options (a server's address,
// a key): its form, which may be skipped and done later in Settings.
async function connectSteps(ids) {
  const catalog = await owner.plugins();
  const steps = [];
  for (const id of ids) {
    const place = catalog.places.find((candidate) => candidate.id === id);
    for (const name of place?.plugins ?? []) {
      const plugin = catalog.plugins.find((candidate) => candidate.name === name);
      if (plugin?.connect === "fields" && plugin.options.length) steps.push(plugin);
    }
  }
  const next = async () => {
    const plugin = steps.shift();
    if (!plugin) return finish();
    renderConnect(plugin, next);
  };
  await next();
}

function renderConnect(plugin, next) {
  const status = h("p", { class: "home-setup-status", role: "status", "aria-live": "polite" });
  const fields = plugin.options.filter((option) => option.type !== "boolean").map((option) => h("label", { class: "field" },
    h("span", { class: "field-label" }, localText(option.title)),
    h("input", {
      name: option.key,
      type: option.secret ? "password" : option.type === "url" ? "url" : option.type === "number" ? "number" : "text",
      value: option.secret ? "" : option.value ?? "",
      placeholder: option.default != null ? String(option.default) : "",
      autocomplete: "off",
      spellcheck: "false",
    }),
    option.help ? h("span", { class: "home-setup-card-meta" }, localText(option.help)) : null));
  const form = h("form", { class: "home-setup-connect" }, fields,
    h("div", { class: "home-setup-actions" },
      h("button", { type: "submit", class: "browse-button primary" }, t("Connect")),
      h("button", { type: "button", class: "browse-button", onclick: () => void next() }, t("Not now"))),
    status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const options = {};
    for (const option of plugin.options) {
      const input = form.elements.namedItem(option.key);
      if (!input || (option.secret && !input.value)) continue;
      options[option.key] = input.value.trim() || null;
    }
    status.textContent = t("Saving…");
    try {
      await owner.changePlugin(plugin.name, { options });
      await next();
    } catch (error) {
      status.textContent = error?.message || String(error);
    }
  });
  frame(h("h2", { class: "home-setup-step" }, t("Connect {place}", { place: localText(plugin.title) })),
    plugin.summary ? h("p", { class: "home-setup-card-meta" }, localText(plugin.summary)) : null,
    form);
}

async function finish() {
  try {
    await saveState("done");
  } catch (error) {
    console.warn("[setup] Could not keep the answer:", error);
  }
  close({ reload: true });
}

// The car or a TV: the places, and a QR code to choose them on a phone;
// this screen follows until the owner answers there.
function renderElsewhere() {
  const url = `${location.origin}/`;
  frame(
    h("div", { class: "home-setup-elsewhere" },
      h("ul", { class: "home-setup-places", role: "list" }, ordered(setup.places).map((place) => placeCard(place))),
      h("div", { class: "home-setup-handoff" },
        h("div", { class: "handoff-qr", role: "img", "aria-label": t("QR code to choose on your phone"), html: renderSVG(url, { ecc: "M", border: 2, whiteColor: "#ffffff", blackColor: "#000000" }) }),
        h("p", { class: "home-setup-card-meta" }, t("Scan with your phone, sign in with your passkey, and choose there. This screen follows.")))),
  );
  // The owner answered on the phone: the answer, or its time, changed.
  const asked = { state: setup.state, updatedAt: setup.updatedAt ?? null };
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      await readSetup();
    } catch {
      return;
    }
    if (setup.state !== asked.state || (setup.updatedAt ?? null) !== asked.updatedAt) close({ reload: true });
  }, POLL_MS);
}

// "Add where you watch", at the end of a skipped home.
document.getElementById("home-setup-open")?.addEventListener("click", () => void showGuide());
