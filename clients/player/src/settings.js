import { renderSVG } from "uqr";
import { DANMAKU_OPACITY_STEPS, DEVICE_KIND_LABELS, DEVICE_KINDS } from "@useyolo/core";
import { api, thisDeviceId } from "./api.js";
import { confirmButton, dismissible, h, icons, segmented, shortDate, switchButton } from "./dom.js";
import { chooseLanguage, chosenLanguage, LANGUAGES, t } from "./i18n.js";
import { addPasskey, owner, passkeysSupported, signInWithPasskey } from "./owner.js";
import { agentStatus, chooseAgent, chosenAgent, loadAgentStatus, onAgentStatus } from "./agent-choice.js";
import { state } from "./state.js";
import { trackScrollEdges } from "./scroll-edges.js";
import { timeAgo } from "./utils.js";
import { testMicrophone } from "./voice.js";

// Settings (Agent Note 2026-10-11-yolo-web-client): one sheet in three groups.
//
// - This screen: what Yolo calls this device, its display size (the car
//   only, display-scale.js), danmaku (danmaku-settings.js), playing over the
//   home network and the media path it takes (media-paths.js), the agent
//   Ask asks (agent-choice.js), the microphone check, and forgetting it. The
//   device credential is enough for these.
// - Your Yolo: devices with the path each one played by last, connected
//   agents and the image links of the covers they show, the languages the
//   owner speaks to Yolo, share links, passkeys, the media paths (the home
//   network, remote access, and the relay's mode), and signing out. They need the owner's passkey session
//   (owner.js); the device credential never reaches them. The car, whose
//   browser may not do passkeys, also offers a QR code that opens these
//   settings on a phone.
// - About: the version, the media node, and /diag.
//
// Each row says one thing: its name, its state in a few words, and a fix
// only where the owner has one to make. On and off are switches; choices
// that matter only while a setting is on show only then.
//
// The same sheet serves the car's touchscreen and a computer's keyboard: a
// modal <dialog> (focus stays inside, Escape and a visible Close leave it),
// 40 px targets, since settings are changed parked, nothing that needs
// hover, and destructive actions that ask again in place instead of opening
// another dialog.

const VERSION = typeof __YOLO_VERSION__ === "string" ? __YOLO_VERSION__ : "dev";
const COMMIT = typeof __YOLO_COMMIT__ === "string" ? __YOLO_COMMIT__ : "";
const SCOPE_WORDS = { read: t("see"), control: t("play"), manage: t("change") };

// The device types, in the screen's language.
const KIND_LABELS = { car: t("Car"), browser: t("Browser"), phone: t("Phone"), tv: t("TV"), other: t("Other") };
const kindLabel = (kind) => KIND_LABELS[kind] ?? DEVICE_KIND_LABELS[kind] ?? KIND_LABELS.other;

// What this screen's last probe of the node's LAN origin means
// (Agent Note 2026-10-12-lan-direct-play), in the owner's words.
const LAN_OUTCOMES = Object.freeze({
  ok: t("Found on this network"),
  timeout: t("Not found: this screen is not on the home network"),
  permission_prompt: t("Press Check, then allow local network access"),
  permission_denied: t("The browser blocks local network access. Allow it in this site's settings, and on a Mac in System Settings › Privacy & Security › Local Network"),
  certificate: t("The node's certificate is not valid yet"),
});

function lanOutcomeText(last, host) {
  if (!last) return t("Not checked yet");
  if (last.outcome === "dns_rebinding") {
    return host ? t("Your router hides the node's name (DNS rebinding protection): allow {host} in the router", { host })
      : t("Your router hides the node's name (DNS rebinding protection): allow it in the router");
  }
  return LAN_OUTCOMES[last.outcome] ?? t("The node answered {status}", { status: String(last.outcome).replace(/^http_/, "") });
}

// The media paths (Agent Note 2026-10-13-media-off-the-worker), in the owner's words.
const PATH_LABELS = Object.freeze({ lan: t("Home network"), wan: t("Remote direct play"), relay: t("Relay") });
// The path a device played by last, after its other details.
const PATH_VIA = Object.freeze({ lan: t("via home network"), wan: t("via remote direct play"), relay: t("via relay") });
const REMOTE_OUTCOMES = Object.freeze({
  timeout: t("no answer: the router does not forward the port, or this network blocks it"), failed: t("the connection failed"), certificate: t("its certificate is not valid"), off: t("off"),
});
// A screen at home without a domain whose router does not loop back.
const NO_HAIRPIN = t("At home your router does not loop back to the home's address, so here this screen uses the relay");
// The relay's modes, in the owner's words.
const RELAY_MODES = Object.freeze([
  { value: "auto", label: t("Automatic"), meta: t("Only when no direct path works") },
  { value: "on", label: t("On"), meta: t("Always available, as the last path") },
  { value: "off", label: t("Off"), meta: t("Screens play only directly from home") },
]);
const REMOTE_STATES = Object.freeze({
  pending: t("Setting up"),
  ok: t("Ready"),
  cgnat: t("Not possible: the home is behind carrier-grade or double NAT"),
  unreachable: t("Not reachable from outside the home"),
  certificate: t("Waiting for a valid certificate"),
  error: t("Needs attention"),
});

/**
 * @param {object} options
 * @param {HTMLDialogElement} options.dialog
 * @param {object} options.profile  profile.js
 * @param {object} options.displayScale  display-scale.js
 * @param {object} [options.danmaku]  danmaku-settings.js
 * @param {() => Promise<void>} options.onForget  unpair this screen
 * @param {() => void} options.onRequestClose  Close, Escape, or the backdrop
 */
// The languages voice input hears (Agent Note 2026-10-18-agent-from-the-screen),
// each in its own words.
const VOICE_LANGUAGES = Object.freeze([
  { value: "zh-Hans", label: "简体中文" },
  { value: "zh-Hant", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
]);
const MAX_VOICE_LANGUAGES = 4;
const voiceLabel = (tag) => VOICE_LANGUAGES.find((option) => option.value === tag)?.label ?? tag;

// The microphone check's findings, in the owner's words (voice.js).
const MIC_RECORDING = {
  heard: t("Heard you"),
  silent: t("Recorded, but heard nothing"),
  denied: t("Microphone access is off"),
  no_microphone: t("No microphone"),
  busy: t("The microphone is in use"),
  unsupported: t("This browser cannot record"),
  failed: t("The microphone did not start"),
};
const MIC_RECOGNITION = {
  heard: t("the browser's own recognition works"),
  error: t("the browser's own recognition failed"),
  no_result: t("the browser's own recognition answered nothing"),
  ended: t("the browser's own recognition answered nothing"),
  unsupported: t("no recognition in the browser"),
};

function microphoneText({ recording, recognition }) {
  const heard = MIC_RECORDING[recording?.outcome] ?? recording?.outcome;
  const browser = MIC_RECOGNITION[recognition?.outcome] ?? recognition?.outcome;
  return `${heard} · ${browser}${recognition?.error ? ` (${recognition.error})` : ""}`;
}

// `report(type, fields)` records a device event (the microphone check's).
export function createSettings({ dialog, profile, displayScale, paths = null, danmaku = null, onForget, onRequestClose, report = () => {} }) {
  const body = dialog.querySelector("#settings-body");
  const ownerData = { signedIn: null, devices: null, agents: null, passkeys: null, media: null, imageLinks: null, shares: null, voice: null };
  let about = null;
  let editing = null;
  let micCheck = null; // { step } while it runs, then { result }

  const groups = {
    screen: group("settings-screen", t("This screen")),
    owner: group("settings-owner", t("Your Yolo")),
    about: group("settings-about", t("About")),
  };
  body.replaceChildren(groups.screen.section, groups.owner.section, groups.about.section);
  // The edges with more settings behind them, for the fades.
  trackScrollEdges(body, { marked: body.parentElement, axis: "y" });

  function group(id, title) {
    const heading = h("h2", { id: `${id}-title`, class: "settings-heading" }, title);
    const content = h("div", { class: "settings-group-body" });
    const status = h("p", { class: "settings-status", role: "status", "aria-live": "polite" });
    const section = h("section", { id, class: "settings-group", "aria-labelledby": `${id}-title` }, heading, content, status);
    return { section, content, status };
  }

  const say = (which, text = "") => {
    groups[which].status.textContent = text;
  };
  const failed = (which) => (error) => say(which, error?.message || String(error));

  // Yolo said something new about its agents, or this screen chose one.
  onAgentStatus(() => {
    if (dialog.open) renderScreen();
  });

  dismissible(dialog, onRequestClose);
  dialog.querySelector("#settings-close").addEventListener("click", () => onRequestClose());

  // --- This screen --------------------------------------------------------

  function selfDevice() {
    return (state.devices || []).find((device) => device.id === thisDeviceId()) ?? null;
  }

  function renderScreen() {
    const device = selfDevice();
    const rows = [];
    if (displayScale.eligible) rows.push(displaySizeRow());
    if (danmaku && profile.canPlay) rows.push(...danmakuRows());
    if (paths && profile.canPlay) rows.push(lanRow(), pathRow());
    if (agentStatus()?.agents?.length) rows.push(agentRow());
    rows.push(microphoneRow(), languageRow());
    groups.screen.content.replaceChildren(
      h("p", { class: "settings-lead" },
        h("span", { id: "settings-device-name" }, device?.name ?? t("This screen")),
        [device ? kindLabel(device.kind) : null, profile.canPlay ? null : t("Remote only")].filter(Boolean).map((part) => ` · ${part}`)),
      h("div", { class: "settings-card" }, rows),
      h("div", { class: "settings-end" }, confirmButton({
        label: t("Forget this screen"),
        confirmLabel: t("Forget it?"),
        quiet: false,
        onConfirm: () => onForget(),
        onError: failed("screen"),
      })));
  }

  // After a change draws the group again, focus goes back to the control
  // that made it.
  const refocus = (selector) => groups.screen.content.querySelector(selector)?.focus();

  // A row with a switch at its right edge, and the row's other actions
  // before it.
  function switchRow({ id, title, meta = null, on, actions = [], onToggle }) {
    return h("div", { class: "row", id },
      h("div", { class: "row-text" },
        h("p", { class: "row-title", id: `${id}-title` }, title),
        meta ? h("p", { class: "row-meta", id: `${id}-status` }, meta) : null),
      h("div", { class: "row-actions" }, actions, switchButton({ id: `${id}-toggle`, on, labelledBy: `${id}-title`, onToggle })));
  }

  // Play over the home network: this screen's switch, what its last probe
  // found, and a check, which may show the browser's permission prompt,
  // while the probe has not found the node.
  function lanRow() {
    const status = paths.status();
    if (!status.domain) {
      return h("div", { class: "row", id: "settings-lan" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, t("Home network")),
          h("p", { class: "row-meta", id: "settings-lan-status" }, t("Needs a domain"))));
    }
    const on = status.enabled;
    const host = status.origin ? new URL(status.origin).hostname : null;
    const meta = !on ? null : !status.origin ? t("Yolo has no home network address for the node yet") : lanOutcomeText(status.last, host);
    const actions = on && status.origin && status.last?.outcome !== "ok" ? [h("button", {
      type: "button",
      class: "pill pill-quiet",
      onclick: async () => {
        say("screen", t("Checking…"));
        await paths.probe("settings", { owner: true });
        say("screen");
        renderScreen();
      },
    }, t("Check"))] : [];
    return switchRow({
      id: "settings-lan",
      title: t("Home network"),
      meta,
      on,
      actions,
      onToggle: async () => {
        if (!on) say("screen", t("Checking… your browser may ask to find devices on the local network"));
        await paths.setEnabled(!on);
        say("screen");
        renderScreen();
        refocus("#settings-lan-toggle");
      },
    });
  }

  // The agent Ask asks on this screen: Yolo's pick, the first that can
  // answer, or one of the node's agents, with why any cannot answer now.
  function agentRow() {
    const status = agentStatus();
    const chosen = chosenAgent();
    const selected = status.agents.some((agent) => agent.id === chosen) ? chosen : "";
    const automatic = status.agents.find((agent) => agent.id === status.id);
    const row = choiceRow({
      id: "settings-agent",
      title: t("Ask with"),
      options: [{ value: "", label: t("Automatic") }, ...status.agents.map((agent) => ({ value: agent.id, label: agent.title }))],
      selected,
      onChoose: (value) => chooseAgent(value || null),
    });
    const notes = [
      !selected && automatic ? t("Automatic asks {agent} now", { agent: automatic.title }) : null,
      ...status.agents.filter((agent) => !agent.available).map((agent) => t("{agent} can't answer: {reason}", { agent: agent.title, reason: agent.reason || t("unavailable") })),
    ].filter(Boolean);
    row.append(...notes.map((text) => h("p", { class: "row-meta" }, text)));
    return row;
  }

  // The language this screen shows and is heard in (i18n.js); a change
  // reloads the page, which draws everything again in it.
  function languageRow() {
    return choiceRow({
      id: "settings-language",
      title: t("Language"),
      options: [{ value: "", label: t("Automatic") }, ...LANGUAGES],
      selected: chosenLanguage(),
      onChoose: (value) => {
        chooseLanguage(value || null);
        location.reload();
      },
    });
  }

  // What this screen's microphone offers for asking by voice: a check that
  // shows the browser's permission prompt, records three seconds, and tries
  // the browser's own recognition; the finding goes to the device events, so
  // a car's can be read later. It keeps no sound and no words.
  function microphoneRow() {
    const running = Boolean(micCheck?.step);
    const meta = micCheck?.step === "recording" ? t("Say something… (1 of 2)")
      : micCheck?.step === "recognition" ? t("Say it again, for the browser's own recognition… (2 of 2)")
        : micCheck?.step ? t("Starting…")
          : micCheck?.result ? microphoneText(micCheck.result)
            : null;
    return h("div", { class: "row", id: "settings-microphone" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, t("Microphone")),
        meta ? h("p", { class: "row-meta", id: "settings-microphone-status" }, meta) : null),
      h("div", { class: "row-actions" }, h("button", {
        type: "button",
        class: "pill pill-quiet",
        disabled: running,
        onclick: async () => {
          micCheck = { step: "starting" };
          renderScreen();
          const result = await testMicrophone({
            onProgress: (step) => {
              micCheck = { step };
              renderScreen();
            },
          });
          report("mic_test", result);
          micCheck = { result };
          renderScreen();
        },
      }, t("Test"))));
  }

  // The path this screen's next stream takes; when it is not a direct one,
  // why the direct ones did not answer.
  function pathRow() {
    const status = paths.status();
    const remote = status.probes.wan;
    const why = status.network === "lan" || status.network === "wan" ? [] : [
      !status.remoteOrigin ? t("Remote direct play is not on")
        : remote?.outcome !== "ok" ? t("Remote direct play: {outcome}", { outcome: remote ? REMOTE_OUTCOMES[remote.outcome] ?? remote.outcome : t("not checked yet") }) : null,
      status.home && status.hairpin === "failed" ? NO_HAIRPIN : null,
    ].filter(Boolean);
    return h("div", { class: "row", id: "settings-path" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title", id: "settings-path-title" }, t("Media path")),
        why.map((line) => h("p", { class: "row-meta" }, line))),
      h("p", { class: "row-value", id: "settings-path-value" }, PATH_LABELS[status.network] ?? t("None")));
  }

  // Display size: five steps from smaller to larger, each a letter at its
  // size, as one radio group; the chosen step's name shows under the title.
  function displaySizeRow() {
    const options = displayScale.options();
    const current = options.find((option) => option.active);
    return h("div", { class: "row row-choice", id: "settings-size" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title", id: "settings-size-title" }, t("Display size")),
        current ? h("p", { class: "row-meta" }, current.label) : null),
      segmented({
        name: "settings-size",
        labelledBy: "settings-size-title",
        className: "size-scale",
        options: options.map((option, index) => ({
          value: option.value,
          label: option.label,
          content: h("span", { class: "size-glyph", style: `font-size:${12 + index * 2.5}px`, "aria-hidden": "true" }, "A"),
        })),
        selected: current?.value,
        onChoose: (value) => {
          displayScale.choose(value);
          renderScreen();
          refocus("#settings-size input:checked");
        },
      }));
  }

  // A choice of a few beside its name, or under it where the sheet is
  // narrow.
  function choiceRow({ id, title, options, selected, onChoose }) {
    return h("div", { class: "row row-choice", id },
      h("p", { class: "row-title", id: `${id}-title` }, title),
      segmented({
        name: id,
        labelledBy: `${id}-title`,
        options,
        selected,
        onChoose: (value) => {
          onChoose(value);
          renderScreen();
          refocus(`#${id} input:checked`);
        },
      }));
  }

  // Danmaku: on or off, and while on, how they look on this screen.
  function danmakuRows() {
    const current = danmaku.get();
    const change = (patch) => danmaku.update(patch);
    const rows = [switchRow({
      id: "settings-danmaku",
      title: t("Danmaku"),
      on: current.enabled,
      onToggle: () => {
        change({ enabled: !current.enabled });
        renderScreen();
        refocus("#settings-danmaku-toggle");
      },
    })];
    if (!current.enabled) return rows;
    return [...rows,
      choiceRow({
        id: "settings-danmaku-density",
        title: t("Density"),
        options: [{ value: "low", label: t("Fewer") }, { value: "normal", label: t("Normal") }, { value: "high", label: t("All") }],
        selected: current.density,
        onChoose: (density) => change({ density }),
      }),
      choiceRow({
        id: "settings-danmaku-area",
        title: t("Area"),
        options: [{ value: "full", label: t("Full") }, { value: "half", label: t("Half") }, { value: "quarter", label: t("Quarter") }],
        selected: current.area,
        onChoose: (area) => change({ area }),
      }),
      choiceRow({
        id: "settings-danmaku-opacity",
        title: t("Opacity"),
        options: DANMAKU_OPACITY_STEPS.map((value) => ({ value, label: `${Math.round(value * 100)}%` })),
        selected: DANMAKU_OPACITY_STEPS.reduce((best, value) => (Math.abs(value - current.opacity) < Math.abs(best - current.opacity) ? value : best)),
        onChoose: (opacity) => change({ opacity }),
      }),
      choiceRow({
        id: "settings-danmaku-size",
        title: t("Text size"),
        options: [{ value: "small", label: t("Small") }, { value: "normal", label: t("Normal") }, { value: "large", label: t("Large") }],
        selected: current.fontSize,
        onChoose: (fontSize) => change({ fontSize }),
      }),
    ];
  }

  // --- Your Yolo (the owner's passkey session) ----------------------------

  async function loadOwner() {
    say("owner");
    try {
      ownerData.signedIn = (await owner.session()).signedIn === true;
    } catch (error) {
      ownerData.signedIn = false;
      say("owner", error.message);
    }
    if (!ownerData.signedIn) {
      Object.assign(ownerData, { devices: null, agents: null, passkeys: null });
      renderOwner();
      return;
    }
    renderOwner();
    const [devices, agents, passkeys, media, imageLinks, shares, voice] = await Promise.allSettled([
      owner.devices(), owner.agents(), owner.passkeys(), owner.media(), owner.imageLinks(), owner.shares(), owner.voice(),
    ]);
    if ([devices, agents, passkeys].some((result) => result.status === "rejected" && result.reason?.status === 401)) {
      ownerData.signedIn = false;
      renderOwner();
      return;
    }
    ownerData.devices = devices.status === "fulfilled" ? devices.value.devices : [];
    ownerData.agents = agents.status === "fulfilled" ? agents.value.agents : [];
    ownerData.passkeys = passkeys.status === "fulfilled" ? passkeys.value.passkeys : [];
    ownerData.media = media.status === "fulfilled" ? media.value : null;
    ownerData.imageLinks = imageLinks.status === "fulfilled" ? imageLinks.value : null;
    ownerData.shares = shares.status === "fulfilled" ? shares.value.links : null;
    ownerData.voice = voice.status === "fulfilled" ? voice.value.languages : null;
    const failure = [devices, agents, passkeys].find((result) => result.status === "rejected");
    if (failure) say("owner", t("Some settings could not load: {message}", { message: failure.reason?.message }));
    renderOwner();
  }

  function renderOwner() {
    const content = groups.owner.content;
    if (ownerData.signedIn === null) {
      content.replaceChildren(h("div", { class: "settings-card" }, h("div", { class: "row" }, h("p", { class: "row-meta" }, t("Checking…")))));
      return;
    }
    if (!ownerData.signedIn) {
      content.replaceChildren(lockedCard());
      return;
    }
    // A card with nothing to say is null, which replaceChildren() would
    // show as the text "null".
    content.replaceChildren(...[
      h("h3", { class: "settings-subheading" }, t("Devices")),
      h("ul", { class: "settings-card", role: "list", "aria-label": t("Devices") }, (ownerData.devices || [])
        .filter((device) => device.via !== "node" || device.online)
        .map(deviceRow)),
      h("h3", { class: "settings-subheading" }, t("Agents")),
      agentsList(),
      imageLinksCard(),
      ownerData.voice ? h("h3", { class: "settings-subheading", id: "settings-voice-title" }, t("Voice languages")) : null,
      voiceCard(),
      h("h3", { class: "settings-subheading" }, t("Share links")),
      sharesList(),
      h("h3", { class: "settings-subheading" }, t("Passkeys")),
      passkeysList(),
      h("h3", { class: "settings-subheading" }, t("Media paths")),
      noDomainCard(),
      homeNetworkCard(),
      remoteCard(),
      relayCard(),
      h("div", { class: "settings-end" }, h("button", {
        type: "button",
        class: "pill",
        onclick: async () => {
          try {
            await owner.signOut();
            ownerData.signedIn = false;
            renderOwner();
            say("owner", t("Signed out."));
          } catch (error) {
            failed("owner")(error);
          }
        },
      }, t("Sign out"))),
    ].filter(Boolean));
  }

  function lockedCard() {
    const status = h("p", { class: "row-meta locked-status", role: "status" });
    const children = [h("p", { class: "row-title" }, t("Sign in to manage devices, agents, and passkeys"))];
    if (passkeysSupported()) {
      const button = h("button", { type: "button", class: "pill pill-primary", id: "settings-sign-in" }, t("Sign in with passkey"));
      button.addEventListener("click", async () => {
        button.disabled = true;
        status.textContent = t("Waiting for your passkey…");
        try {
          await signInWithPasskey();
          status.textContent = "";
          await loadOwner();
        } catch (error) {
          status.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
      children.push(button);
    }
    if (profile.car || !passkeysSupported()) {
      const url = `${location.origin}/settings`;
      children.push(h("div", { class: "handoff" },
        h("div", { class: "handoff-qr", role: "img", "aria-label": t("QR code to open these settings on your phone"), html: renderSVG(url, { ecc: "M", border: 2, whiteColor: "#ffffff", blackColor: "#000000" }) }),
        h("p", { class: "row-meta" }, t("Or scan to manage on your phone"))));
    }
    children.push(status);
    return h("div", { class: "settings-card locked" }, children);
  }

  // A device: its type, whether it is online, and the path it played by
  // last; one Edit opens the name, the type, and Remove in place.
  function deviceRow(device) {
    const self = device.id === thisDeviceId();
    if (editing === device.id) return deviceEditor(device, self);
    const seen = self ? t("This screen") : device.online ? h("span", { class: "ok" }, t("Online"))
      : device.lastSeenAt ? t("Seen {time}", { time: timeAgo(device.lastSeenAt) }) : t("Not connected yet");
    const path = ownerData.media?.screens?.find((screen) => screen.id === device.id)?.path;
    const parts = [
      kindLabel(device.kind),
      seen,
      device.capabilities?.renderer === "remote" ? t("Remote only") : null,
      PATH_VIA[path] ?? null,
    ].filter(Boolean);
    const meta = parts.flatMap((part, index) => (index ? [" · ", part] : [part]));
    return h("li", { class: "row", "data-device": device.id },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, device.name),
        h("p", { class: "row-meta" }, meta)),
      h("div", { class: "row-actions" }, h("button", {
        type: "button",
        class: "pill pill-quiet",
        "aria-label": t("Edit {name}", { name: device.name }),
        onclick: () => {
          editing = device.id;
          renderOwner();
          groups.owner.content.querySelector(".row-edit input[name='name']")?.focus();
        },
      }, t("Edit"))));
  }

  function deviceEditor(device, self) {
    const form = h("form", { class: "row-edit-form" },
      h("label", { class: "field" },
        h("span", { class: "field-label" }, t("Name")),
        h("input", { type: "text", name: "name", value: device.name, maxlength: "60", required: true, autocomplete: "off", enterkeyhint: "done" })),
      h("div", { class: "field kind-choice" },
        h("span", { class: "field-label", id: `kind-${device.id}-title` }, t("Type")),
        segmented({
          name: `kind-${device.id}`,
          labelledBy: `kind-${device.id}-title`,
          options: DEVICE_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind), content: [h("span", { html: icons.kind(kind, 20) }), h("span", {}, kindLabel(kind))] })),
          selected: device.kind,
        })),
      h("div", { class: "row-edit-actions" },
        confirmButton({
          label: t("Remove"),
          confirmLabel: t("Remove?"),
          ariaLabel: t("Remove {name}", { name: device.name }),
          onConfirm: async () => {
            await owner.removeDevice(device.id);
            editing = null;
            if (self) return onForget({ removed: true });
            await loadOwner();
          },
          onError: failed("owner"),
        }),
        h("div", { class: "row-actions" },
          h("button", { type: "button", class: "pill pill-quiet", onclick: () => cancel() }, t("Cancel")),
          h("button", { type: "submit", class: "pill pill-primary" }, t("Save")))));
    const cancel = () => {
      editing = null;
      renderOwner();
      groups.owner.content.querySelector(`[data-device="${CSS.escape(device.id)}"] button`)?.focus();
    };
    // Escape leaves the editor, not the whole sheet.
    form.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      try {
        await owner.renameDevice(device.id, { name: String(data.get("name") || "").trim(), kind: String(data.get(`kind-${device.id}`) || device.kind) });
        editing = null;
        await loadOwner();
      } catch (error) {
        failed("owner")(error);
      }
    });
    return h("li", { class: "row row-edit", "data-device": device.id }, form);
  }

  function agentsList() {
    const agents = ownerData.agents || [];
    if (!agents.length) {
      return h("div", { class: "settings-card" }, h("div", { class: "row" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, t("None connected")),
          h("p", { class: "row-meta" }, t("Connect at {url}", { url: `${location.origin}/mcp` })))));
    }
    return h("ul", { class: "settings-card", role: "list", "aria-label": t("Connected agents") }, agents.map((agent) => {
      const can = (agent.scope || []).map((scope) => SCOPE_WORDS[scope] ?? scope).join(", ");
      const where = agent.site || agent.redirectHosts?.[0] || null;
      return h("li", { class: "row", "data-agent": agent.id },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, agent.name),
          h("p", { class: "row-meta" }, [where, can].filter(Boolean).join(" · "))),
        h("div", { class: "row-actions" }, confirmButton({
          label: t("Revoke"),
          confirmLabel: t("Revoke?"),
          ariaLabel: t("Revoke {name}", { name: agent.name }),
          onConfirm: async () => {
            await owner.revokeAgent(agent.id);
            await loadOwner();
            say("owner", t("{name} can no longer use Yolo.", { name: agent.name }));
          },
          onError: failed("owner"),
        })));
    }));
  }

  // The covers agents show load from links that need no sign-in and keep
  // working in old chats; a reset makes every link given so far stop
  // working (Agent Note 2026-10-07-remote-mcp-server).
  function imageLinksCard() {
    const resetAt = ownerData.imageLinks?.resetAt;
    return h("div", { class: "settings-card" }, h("div", { class: "row", id: "settings-image-links" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, t("Image links")),
        h("p", { class: "row-meta" }, t("Reset stops every link given so far")),
        resetAt ? h("p", { class: "row-meta" }, t("Last reset {date}", { date: shortDate(resetAt) })) : null),
      h("div", { class: "row-actions" }, confirmButton({
        label: t("Reset"),
        confirmLabel: t("Reset?"),
        ariaLabel: t("Reset image links"),
        onConfirm: async () => {
          ownerData.imageLinks = await owner.resetImageLinks();
          renderOwner();
          say("owner", t("Image links reset. Agents get new links from their next call."));
        },
        onError: failed("owner"),
      }))));
  }

  // Links friends watch one item at (Agent Note 2026-10-20-share-links):
  // the ones still open, with how often they were played; revoking one
  // stops it at once, a stream that plays included.
  function sharesList() {
    const links = (ownerData.shares || []).filter((link) => link.status === "active");
    if (!links.length) {
      return h("div", { class: "settings-card" }, h("div", { class: "row" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, t("None open")),
          h("p", { class: "row-meta" }, t("Share from the player, or ask your agent")))));
    }
    return h("ul", { class: "settings-card", role: "list", "aria-label": t("Share links") }, links.map((link) => h("li", { class: "row", "data-share": link.id },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, link.title),
        h("p", { class: "row-meta" }, [
          !link.plays ? t("Not played yet") : link.plays === 1 ? t("Played 1 time") : t("Played {count} times", { count: link.plays }),
          t("until {date}", { date: shortDate(link.expiresAt) }),
        ].join(" · "))),
      h("div", { class: "row-actions" }, confirmButton({
        label: t("Revoke"),
        confirmLabel: t("Revoke?"),
        ariaLabel: t("Revoke the link to {title}", { title: link.title }),
        onConfirm: async () => {
          await owner.revokeShare(link.id);
          await loadOwner();
          say("owner", t("The link to {title} no longer plays.", { title: link.title }));
        },
        onError: failed("owner"),
      })))));
  }

  function passkeysList() {
    const passkeys = ownerData.passkeys || [];
    const rows = passkeys.map((passkey) => h("li", { class: "row" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, passkey.name || t("Passkey")),
        h("p", { class: "row-meta" }, [passkey.synced ? t("Synced") : t("One device"), passkey.createdAt ? t("added {date}", { date: shortDate(passkey.createdAt) }) : null].filter(Boolean).join(" · "))),
      h("div", { class: "row-actions" }, passkeys.length > 1 ? confirmButton({
        label: t("Remove"),
        confirmLabel: t("Remove?"),
        ariaLabel: passkey.name ? t("Remove passkey {name}", { name: passkey.name }) : t("Remove passkey"),
        onConfirm: async () => {
          await owner.removePasskey(passkey.id);
          await loadOwner();
          say("owner", t("Passkey removed. Other browsers were signed out."));
        },
        onError: failed("owner"),
      }) : h("span", { class: "row-value" }, t("Your only passkey")))));
    if (passkeysSupported()) {
      const add = h("button", { type: "button", class: "pill" }, t("Add a passkey"));
      add.addEventListener("click", async () => {
        add.disabled = true;
        say("owner", t("Waiting for your passkey…"));
        try {
          await addPasskey(navigator.userAgentData?.platform || null);
          say("owner", t("Passkey added."));
          await loadOwner();
        } catch (error) {
          failed("owner")(error);
        } finally {
          add.disabled = false;
        }
      });
      rows.push(h("li", { class: "row" }, add));
    }
    return h("ul", { class: "settings-card", role: "list", "aria-label": t("Passkeys") }, rows);
  }

  // The languages the owner speaks to Yolo, first first: voice input on
  // every screen hears a recording as one of them, and as the first unless
  // another is clearly what was said. Up moves one ahead of the one before
  // it; the buttons under them add one.
  function voiceCard() {
    const languages = ownerData.voice;
    if (!languages) return null;
    const rows = languages.map((tag, index) => h("li", { class: "row", "data-voice-language": tag },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, voiceLabel(tag)),
        index === 0 && languages.length > 1 ? h("p", { class: "row-meta" }, t("First: what a short or unclear request is heard as")) : null),
      h("div", { class: "row-actions" },
        index > 0 ? h("button", {
          type: "button",
          class: "pill pill-quiet",
          "aria-label": t("Move {language} up", { language: voiceLabel(tag) }),
          onclick: () => changeVoice([...languages.slice(0, index - 1), tag, languages[index - 1], ...languages.slice(index + 1)], `[data-voice-language="${tag}"] .pill`),
        }, t("Up")) : null,
        h("button", {
          type: "button",
          class: "pill pill-quiet",
          "aria-label": t("Remove {language}", { language: voiceLabel(tag) }),
          onclick: () => changeVoice(languages.filter((other) => other !== tag), "#settings-voice-add .pill"),
        }, t("Remove")))));
    if (!languages.length) rows.push(h("li", { class: "row" }, h("p", { class: "row-meta" }, t("None chosen: each screen hears its own language"))));
    const more = VOICE_LANGUAGES.filter((option) => !languages.includes(option.value));
    if (more.length && languages.length < MAX_VOICE_LANGUAGES) {
      rows.push(h("li", { class: "row row-stack", id: "settings-voice-add" },
        h("p", { class: "row-meta" }, t("Add a language")),
        h("div", { class: "voice-add" }, more.map((option) => h("button", {
          type: "button",
          class: "pill pill-quiet",
          onclick: () => changeVoice([...languages, option.value], `[data-voice-language="${option.value}"] .pill`),
        }, `+ ${option.label}`)))));
    }
    return h("ul", { class: "settings-card", role: "list", id: "settings-voice", "aria-labelledby": "settings-voice-title" }, rows);
  }

  // A change to the voice languages, then the sheet again, with focus on
  // `focus` where it is drawn.
  async function changeVoice(languages, focus) {
    say("owner");
    try {
      ownerData.voice = (await owner.setVoice(languages)).languages;
    } catch (error) {
      failed("owner")(error);
    }
    renderOwner();
    groups.owner.content.querySelector(focus)?.focus();
  }

  // A change to the media switches, then the sheet again.
  async function changeMedia(changes, saying) {
    say("owner", saying);
    try {
      ownerData.media = await owner.setMedia(changes);
      say("owner");
    } catch (error) {
      failed("owner")(error);
    }
    renderOwner();
  }

  const noDomain = () => ownerData.media?.remote?.certificate === "ip" && !ownerData.media?.lan?.configured;

  // An instance without a domain (Agent Note 2026-10-13-no-domain-deployment):
  // how screens play, and what a domain adds.
  function noDomainCard() {
    if (!noDomain()) return null;
    return h("div", { class: "settings-card" }, h("div", { class: "row", id: "settings-no-domain" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, t("Without a domain")),
        h("p", { class: "row-meta" }, t("Screens play from your home's public address once remote direct play is on. A domain, from about $5 a year, adds direct play on the home network.")))));
  }

  // LAN direct play's setup as the control plane last found it: its state,
  // the node's address, and what failed.
  function homeNetworkCard() {
    const status = ownerData.media?.lan;
    if (noDomain()) {
      return h("div", { class: "settings-card" }, h("div", { class: "row", id: "settings-home-network" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, t("Home network")),
          h("p", { class: "row-meta" }, t("Needs a domain")))));
    }
    const rows = [];
    const label = { ready: t("Ready"), pending: t("Setting up"), error: t("Needs attention") }[status?.status] ?? t("Checking…");
    const detail = !status ? label
      : status.status === "off" ? t("Needs the MEDIA_DNS_TOKEN secret on the control plane")
        : [label, status.address].filter(Boolean).join(" · ");
    rows.push(h("div", { class: "row", id: "settings-home-network" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, t("Home network")),
        h("p", { class: "row-meta" }, detail),
        status?.error ? h("p", { class: "row-meta" }, `${status.error.step}: ${status.error.message}`) : null),
      status?.configured ? h("div", { class: "row-actions" }, h("button", {
        type: "button",
        class: "pill pill-quiet",
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          say("owner", t("Checking the media paths… (a new certificate can take a minute)"));
          try {
            ownerData.media = await owner.checkMedia();
            say("owner");
          } catch (error) {
            failed("owner")(error);
          }
          renderOwner();
        },
      }, t("Check"))) : null));
    return h("div", { class: "settings-card" }, rows);
  }

  // Remote direct play: the owner's switch, its state and address, and
  // while it is not reachable, what the last check found and the router's
  // port for the CA's check, the one a refusing router needs forwarded.
  function remoteCard() {
    const status = ownerData.media?.remote;
    const on = Boolean(status?.on);
    const byAddress = status?.certificate === "ip";
    const check = status?.challenge;
    const lines = !status ? [] : !status.configured ? [t("Needs the MEDIA_DNS_TOKEN secret on the control plane")] : !on ? [] : [
      [REMOTE_STATES[status.status] ?? status.status, status.address].filter(Boolean).join(" · "),
      status.reason,
      status.error ? `${status.error.step}: ${status.error.message}` : null,
      byAddress && check && status.status !== "ok" ? (check.method === "manual"
        ? t("The certificate's check comes through the router's port {port} (your port forward)", { port: check.externalPort })
        : t("The certificate's check comes through the router's port {port}", { port: check.externalPort })) : null,
      byAddress && status.ipv6Error ? `IPv6: ${status.ipv6Error}` : null,
    ];
    const toggle = status?.configured ? switchButton({
      id: "settings-remote-toggle",
      on,
      labelledBy: "settings-remote-title",
      onToggle: (event) => {
        event.currentTarget.disabled = true;
        void changeMedia({ remote: !on }, on ? t("Turning remote access off…") : t("Turning remote access on… (the router port and a certificate can take a minute)"));
      },
    }) : null;
    return h("div", { class: "settings-card" }, h("div", { class: "row", id: "settings-remote" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title", id: "settings-remote-title" }, t("Remote direct play")),
        lines.filter(Boolean).map((line) => h("p", { class: "row-meta" }, line))),
      toggle ? h("div", { class: "row-actions" }, toggle) : null));
  }

  // The relay through the Worker: its mode as one choice of three, what that
  // mode does, and how many streams it carried this week.
  function relayCard() {
    const media = ownerData.media;
    const mode = media?.relay?.mode ?? "auto";
    const streams = media?.streams;
    const current = RELAY_MODES.find((option) => option.value === mode);
    return h("div", { class: "settings-card" }, h("div", { class: "row row-stack", id: "settings-relay" },
      h("p", { class: "row-title", id: "settings-relay-title" }, t("Relay through Cloudflare")),
      segmented({
        name: "settings-relay",
        labelledBy: "settings-relay-title",
        options: RELAY_MODES,
        selected: mode,
        disabled: !media,
        onChoose: (value) => {
          if (value !== mode) void changeMedia({ relay: value }, t("Changing the relay…"));
        },
      }),
      h("p", { class: "row-meta", id: "settings-relay-status" }, [current?.meta, streams ? (streams.relay === 1 ? t("1 stream in {days} days", { days: streams.days }) : t("{count} streams in {days} days", { count: streams.relay, days: streams.days })) : null].filter(Boolean).join(" · "))));
  }

  // --- About ----------------------------------------------------------------

  async function loadAbout() {
    try {
      about = await api("/v1/me", { label: "About", retries: 0 });
    } catch {
      about = null;
    }
    renderAbout();
  }

  function renderAbout() {
    const node = about?.node;
    const nodeText = !about ? t("Checking…") : node?.online ? `${t("Online")}${node.version ? ` · ${node.version}` : ""}` : t("Offline");
    groups.about.content.replaceChildren(h("div", { class: "settings-card" },
      h("div", { class: "row" },
        h("div", { class: "row-text" }, h("p", { class: "row-title" }, "Yolo")),
        h("p", { class: "row-value" }, COMMIT ? `${VERSION} · ${COMMIT}` : VERSION)),
      h("div", { class: "row" },
        h("div", { class: "row-text" }, h("p", { class: "row-title" }, t("Media node"))),
        h("p", { class: `row-value${node?.online ? " ok" : ""}` }, nodeText)),
      h("a", { class: "row row-link", href: "/diag" },
        h("div", { class: "row-text" }, h("p", { class: "row-title" }, t("Diagnostics"))),
        h("span", { class: "row-chevron", html: icons.chevron }))));
  }

  return {
    get open() {
      return dialog.open;
    },
    // `instant` when opened from the keyboard: no slide-in.
    async show({ instant = false } = {}) {
      dialog.classList.toggle("instant", instant);
      editing = null;
      renderScreen();
      renderOwner();
      renderAbout();
      if (!dialog.open) dialog.showModal();
      await Promise.allSettled([loadOwner(), loadAbout(), loadAgentStatus()]);
    },
    close() {
      if (dialog.open) dialog.close();
    },
    // Yolo's device list changed (a `devices` broadcast).
    devicesChanged() {
      if (!dialog.open) return;
      renderScreen();
    },
    // The display size became available or went away.
    displayChanged() {
      if (dialog.open) renderScreen();
    },
    // This screen's media path or a probe changed (media-paths.js).
    pathsChanged() {
      if (dialog.open) renderScreen();
    },
    // This screen's danmaku settings changed (an agent, or the player's toggle).
    danmakuChanged() {
      if (dialog.open) renderScreen();
    },
  };
}
