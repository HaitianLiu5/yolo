import { renderSVG } from "uqr";
import { DANMAKU_OPACITY_STEPS, DEVICE_KIND_LABELS, DEVICE_KINDS } from "@useyolo/core";
import { api, thisDeviceId } from "./api.js";
import { confirmButton, dismissible, h, icons, segmented, shortDate, switchButton } from "./dom.js";
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
//   agents and the image links of the covers they show, share links,
//   passkeys, the media paths (the home network, remote access, and the
//   relay's mode), and signing out. They need the owner's passkey session
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
const SCOPE_WORDS = { read: "see", control: "play", manage: "change" };

const kindLabel = (kind) => DEVICE_KIND_LABELS[kind] ?? DEVICE_KIND_LABELS.other;

// What this screen's last probe of the node's LAN origin means
// (Agent Note 2026-10-12-lan-direct-play), in the owner's words.
const LAN_OUTCOMES = Object.freeze({
  ok: "Found on this network",
  timeout: "Not found: this screen is not on the home network",
  permission_prompt: "Press Check, then allow local network access",
  permission_denied: "The browser blocks local network access. Allow it in this site's settings, and on a Mac in System Settings › Privacy & Security › Local Network",
  certificate: "The node's certificate is not valid yet",
});

function lanOutcomeText(last, host) {
  if (!last) return "Not checked yet";
  if (last.outcome === "dns_rebinding") return `Your router hides the node's name (DNS rebinding protection): allow ${host ?? "it"} in the router`;
  return LAN_OUTCOMES[last.outcome] ?? `The node answered ${String(last.outcome).replace(/^http_/, "")}`;
}

// The media paths (Agent Note 2026-10-13-media-off-the-worker), in the owner's words.
const PATH_LABELS = Object.freeze({ lan: "Home network", wan: "Remote direct play", relay: "Relay" });
const REMOTE_OUTCOMES = Object.freeze({
  timeout: "no answer: the router does not forward the port, or this network blocks it", failed: "the connection failed", certificate: "its certificate is not valid", off: "off",
});
// A screen at home without a domain whose router does not loop back.
const NO_HAIRPIN = "At home your router does not loop back to the home's address, so here this screen uses the relay";
// The relay's modes, in the owner's words.
const RELAY_MODES = Object.freeze([
  { value: "auto", label: "Automatic", meta: "Only when no direct path works" },
  { value: "on", label: "On", meta: "Always available, as the last path" },
  { value: "off", label: "Off", meta: "Screens play only directly from home" },
]);
const REMOTE_STATES = Object.freeze({
  pending: "Setting up",
  ok: "Ready",
  cgnat: "Not possible: the home is behind carrier-grade or double NAT",
  unreachable: "Not reachable from outside the home",
  certificate: "Waiting for a valid certificate",
  error: "Needs attention",
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
// The microphone check's findings, in the owner's words (voice.js).
const MIC_RECORDING = {
  heard: "Heard you",
  silent: "Recorded, but heard nothing",
  denied: "Microphone access is off",
  no_microphone: "No microphone",
  busy: "The microphone is in use",
  unsupported: "This browser cannot record",
  failed: "The microphone did not start",
};
const MIC_RECOGNITION = {
  heard: "the browser's own recognition works",
  error: "the browser's own recognition failed",
  no_result: "the browser's own recognition answered nothing",
  ended: "the browser's own recognition answered nothing",
  unsupported: "no recognition in the browser",
};

function microphoneText({ recording, recognition }) {
  const heard = MIC_RECORDING[recording?.outcome] ?? recording?.outcome;
  const browser = MIC_RECOGNITION[recognition?.outcome] ?? recognition?.outcome;
  return `${heard} · ${browser}${recognition?.error ? ` (${recognition.error})` : ""}`;
}

// `report(type, fields)` records a device event (the microphone check's).
export function createSettings({ dialog, profile, displayScale, paths = null, danmaku = null, onForget, onRequestClose, report = () => {} }) {
  const body = dialog.querySelector("#settings-body");
  const ownerData = { signedIn: null, devices: null, agents: null, passkeys: null, media: null, imageLinks: null, shares: null };
  let about = null;
  let editing = null;
  let micCheck = null; // { step } while it runs, then { result }

  const groups = {
    screen: group("settings-screen", "This screen"),
    owner: group("settings-owner", "Your Yolo"),
    about: group("settings-about", "About"),
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
    rows.push(microphoneRow());
    groups.screen.content.replaceChildren(
      h("p", { class: "settings-lead" },
        h("span", { id: "settings-device-name" }, device?.name ?? "This screen"),
        [device ? kindLabel(device.kind) : null, profile.canPlay ? null : "Remote only"].filter(Boolean).map((part) => ` · ${part}`)),
      h("div", { class: "settings-card" }, rows),
      h("div", { class: "settings-end" }, confirmButton({
        label: "Forget this screen",
        confirmLabel: "Forget it?",
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
          h("p", { class: "row-title" }, "Home network"),
          h("p", { class: "row-meta", id: "settings-lan-status" }, "Needs a domain")));
    }
    const on = status.enabled;
    const host = status.origin ? new URL(status.origin).hostname : null;
    const meta = !on ? null : !status.origin ? "Yolo has no home network address for the node yet" : lanOutcomeText(status.last, host);
    const actions = on && status.origin && status.last?.outcome !== "ok" ? [h("button", {
      type: "button",
      class: "pill pill-quiet",
      onclick: async () => {
        say("screen", "Checking…");
        await paths.probe("settings", { owner: true });
        say("screen");
        renderScreen();
      },
    }, "Check")] : [];
    return switchRow({
      id: "settings-lan",
      title: "Home network",
      meta,
      on,
      actions,
      onToggle: async () => {
        if (!on) say("screen", "Checking… your browser may ask to find devices on the local network");
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
      title: "Ask with",
      options: [{ value: "", label: "Automatic" }, ...status.agents.map((agent) => ({ value: agent.id, label: agent.title }))],
      selected,
      onChoose: (value) => chooseAgent(value || null),
    });
    const notes = [
      !selected && automatic ? `Automatic asks ${automatic.title} now` : null,
      ...status.agents.filter((agent) => !agent.available).map((agent) => `${agent.title} can't answer: ${agent.reason || "unavailable"}`),
    ].filter(Boolean);
    row.append(...notes.map((text) => h("p", { class: "row-meta" }, text)));
    return row;
  }

  // What this screen's microphone offers for asking by voice: a check that
  // shows the browser's permission prompt, records three seconds, and tries
  // the browser's own recognition; the finding goes to the device events, so
  // a car's can be read later. It keeps no sound and no words.
  function microphoneRow() {
    const running = Boolean(micCheck?.step);
    const meta = micCheck?.step === "recording" ? "Say something… (1 of 2)"
      : micCheck?.step === "recognition" ? "Say it again, for the browser's own recognition… (2 of 2)"
        : micCheck?.step ? "Starting…"
          : micCheck?.result ? microphoneText(micCheck.result)
            : null;
    return h("div", { class: "row", id: "settings-microphone" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, "Microphone"),
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
      }, "Test")));
  }

  // The path this screen's next stream takes; when it is not a direct one,
  // why the direct ones did not answer.
  function pathRow() {
    const status = paths.status();
    const remote = status.probes.wan;
    const why = status.network === "lan" || status.network === "wan" ? [] : [
      status.remoteOrigin && remote?.outcome !== "ok" ? `Remote direct play: ${remote ? REMOTE_OUTCOMES[remote.outcome] ?? remote.outcome : "not checked yet"}` : null,
      status.home && status.hairpin === "failed" ? NO_HAIRPIN : null,
    ].filter(Boolean);
    return h("div", { class: "row", id: "settings-path" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title", id: "settings-path-title" }, "Media path"),
        why.map((line) => h("p", { class: "row-meta" }, line))),
      h("p", { class: "row-value", id: "settings-path-value" }, PATH_LABELS[status.network] ?? "None"));
  }

  // Display size: five steps from smaller to larger, each a letter at its
  // size, as one radio group; the chosen step's name shows under the title.
  function displaySizeRow() {
    const options = displayScale.options();
    const current = options.find((option) => option.active);
    return h("div", { class: "row row-choice", id: "settings-size" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title", id: "settings-size-title" }, "Display size"),
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
      title: "Danmaku",
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
        title: "Density",
        options: [{ value: "low", label: "Fewer" }, { value: "normal", label: "Normal" }, { value: "high", label: "All" }],
        selected: current.density,
        onChoose: (density) => change({ density }),
      }),
      choiceRow({
        id: "settings-danmaku-area",
        title: "Area",
        options: [{ value: "full", label: "Full" }, { value: "half", label: "Half" }, { value: "quarter", label: "Quarter" }],
        selected: current.area,
        onChoose: (area) => change({ area }),
      }),
      choiceRow({
        id: "settings-danmaku-opacity",
        title: "Opacity",
        options: DANMAKU_OPACITY_STEPS.map((value) => ({ value, label: `${Math.round(value * 100)}%` })),
        selected: DANMAKU_OPACITY_STEPS.reduce((best, value) => (Math.abs(value - current.opacity) < Math.abs(best - current.opacity) ? value : best)),
        onChoose: (opacity) => change({ opacity }),
      }),
      choiceRow({
        id: "settings-danmaku-size",
        title: "Text size",
        options: [{ value: "small", label: "Small" }, { value: "normal", label: "Normal" }, { value: "large", label: "Large" }],
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
    const [devices, agents, passkeys, media, imageLinks, shares] = await Promise.allSettled([
      owner.devices(), owner.agents(), owner.passkeys(), owner.media(), owner.imageLinks(), owner.shares(),
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
    const failure = [devices, agents, passkeys].find((result) => result.status === "rejected");
    if (failure) say("owner", `Some settings could not load: ${failure.reason?.message}`);
    renderOwner();
  }

  function renderOwner() {
    const content = groups.owner.content;
    if (ownerData.signedIn === null) {
      content.replaceChildren(h("div", { class: "settings-card" }, h("div", { class: "row" }, h("p", { class: "row-meta" }, "Checking…"))));
      return;
    }
    if (!ownerData.signedIn) {
      content.replaceChildren(lockedCard());
      return;
    }
    // A card with nothing to say is null, which replaceChildren() would
    // show as the text "null".
    content.replaceChildren(...[
      h("h3", { class: "settings-subheading" }, "Devices"),
      h("ul", { class: "settings-card", role: "list", "aria-label": "Devices" }, (ownerData.devices || [])
        .filter((device) => device.via !== "node" || device.online)
        .map(deviceRow)),
      h("h3", { class: "settings-subheading" }, "Agents"),
      agentsList(),
      imageLinksCard(),
      h("h3", { class: "settings-subheading" }, "Share links"),
      sharesList(),
      h("h3", { class: "settings-subheading" }, "Passkeys"),
      passkeysList(),
      h("h3", { class: "settings-subheading" }, "Media paths"),
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
            say("owner", "Signed out.");
          } catch (error) {
            failed("owner")(error);
          }
        },
      }, "Sign out")),
    ].filter(Boolean));
  }

  function lockedCard() {
    const status = h("p", { class: "row-meta locked-status", role: "status" });
    const children = [h("p", { class: "row-title" }, "Sign in to manage devices, agents, and passkeys")];
    if (passkeysSupported()) {
      const button = h("button", { type: "button", class: "pill pill-primary", id: "settings-sign-in" }, "Sign in with passkey");
      button.addEventListener("click", async () => {
        button.disabled = true;
        status.textContent = "Waiting for your passkey…";
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
        h("div", { class: "handoff-qr", role: "img", "aria-label": "QR code to open these settings on your phone", html: renderSVG(url, { ecc: "M", border: 2, whiteColor: "#ffffff", blackColor: "#000000" }) }),
        h("p", { class: "row-meta" }, "Or scan to manage on your phone")));
    }
    children.push(status);
    return h("div", { class: "settings-card locked" }, children);
  }

  // A device: its type, whether it is online, and the path it played by
  // last; one Edit opens the name, the type, and Remove in place.
  function deviceRow(device) {
    const self = device.id === thisDeviceId();
    if (editing === device.id) return deviceEditor(device, self);
    const seen = self ? "This screen" : device.online ? h("span", { class: "ok" }, "Online")
      : device.lastSeenAt ? `Seen ${timeAgo(device.lastSeenAt)}` : "Not connected yet";
    const path = ownerData.media?.screens?.find((screen) => screen.id === device.id)?.path;
    const parts = [
      kindLabel(device.kind),
      seen,
      device.capabilities?.renderer === "remote" ? "Remote only" : null,
      PATH_LABELS[path] ? `via ${PATH_LABELS[path].toLowerCase()}` : null,
    ].filter(Boolean);
    const meta = parts.flatMap((part, index) => (index ? [" · ", part] : [part]));
    return h("li", { class: "row", "data-device": device.id },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, device.name),
        h("p", { class: "row-meta" }, meta)),
      h("div", { class: "row-actions" }, h("button", {
        type: "button",
        class: "pill pill-quiet",
        "aria-label": `Edit ${device.name}`,
        onclick: () => {
          editing = device.id;
          renderOwner();
          groups.owner.content.querySelector(".row-edit input[name='name']")?.focus();
        },
      }, "Edit")));
  }

  function deviceEditor(device, self) {
    const form = h("form", { class: "row-edit-form" },
      h("label", { class: "field" },
        h("span", { class: "field-label" }, "Name"),
        h("input", { type: "text", name: "name", value: device.name, maxlength: "60", required: true, autocomplete: "off", enterkeyhint: "done" })),
      h("div", { class: "field kind-choice" },
        h("span", { class: "field-label", id: `kind-${device.id}-title` }, "Type"),
        segmented({
          name: `kind-${device.id}`,
          labelledBy: `kind-${device.id}-title`,
          options: DEVICE_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind), content: [h("span", { html: icons.kind(kind, 20) }), h("span", {}, kindLabel(kind))] })),
          selected: device.kind,
        })),
      h("div", { class: "row-edit-actions" },
        confirmButton({
          label: "Remove",
          confirmLabel: "Remove?",
          ariaLabel: `Remove ${device.name}`,
          onConfirm: async () => {
            await owner.removeDevice(device.id);
            editing = null;
            if (self) return onForget({ removed: true });
            await loadOwner();
          },
          onError: failed("owner"),
        }),
        h("div", { class: "row-actions" },
          h("button", { type: "button", class: "pill pill-quiet", onclick: () => cancel() }, "Cancel"),
          h("button", { type: "submit", class: "pill pill-primary" }, "Save"))));
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
          h("p", { class: "row-title" }, "None connected"),
          h("p", { class: "row-meta" }, `Connect at ${location.origin}/mcp`))));
    }
    return h("ul", { class: "settings-card", role: "list", "aria-label": "Connected agents" }, agents.map((agent) => {
      const can = (agent.scope || []).map((scope) => SCOPE_WORDS[scope] ?? scope).join(", ");
      const where = agent.site || agent.redirectHosts?.[0] || null;
      return h("li", { class: "row", "data-agent": agent.id },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, agent.name),
          h("p", { class: "row-meta" }, [where, can].filter(Boolean).join(" · "))),
        h("div", { class: "row-actions" }, confirmButton({
          label: "Revoke",
          confirmLabel: "Revoke?",
          ariaLabel: `Revoke ${agent.name}`,
          onConfirm: async () => {
            await owner.revokeAgent(agent.id);
            await loadOwner();
            say("owner", `${agent.name} can no longer use Yolo.`);
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
        h("p", { class: "row-title" }, "Image links"),
        h("p", { class: "row-meta" }, "Reset stops every link given so far"),
        resetAt ? h("p", { class: "row-meta" }, `Last reset ${shortDate(resetAt)}`) : null),
      h("div", { class: "row-actions" }, confirmButton({
        label: "Reset",
        confirmLabel: "Reset?",
        ariaLabel: "Reset image links",
        onConfirm: async () => {
          ownerData.imageLinks = await owner.resetImageLinks();
          renderOwner();
          say("owner", "Image links reset. Agents get new links from their next call.");
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
          h("p", { class: "row-title" }, "None open"),
          h("p", { class: "row-meta" }, "Share from the player, or ask your agent"))));
    }
    return h("ul", { class: "settings-card", role: "list", "aria-label": "Share links" }, links.map((link) => h("li", { class: "row", "data-share": link.id },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, link.title),
        h("p", { class: "row-meta" }, [
          link.plays ? `Played ${link.plays} ${link.plays === 1 ? "time" : "times"}` : "Not played yet",
          `until ${shortDate(link.expiresAt)}`,
        ].join(" · "))),
      h("div", { class: "row-actions" }, confirmButton({
        label: "Revoke",
        confirmLabel: "Revoke?",
        ariaLabel: `Revoke the link to ${link.title}`,
        onConfirm: async () => {
          await owner.revokeShare(link.id);
          await loadOwner();
          say("owner", `The link to ${link.title} no longer plays.`);
        },
        onError: failed("owner"),
      })))));
  }

  function passkeysList() {
    const passkeys = ownerData.passkeys || [];
    const rows = passkeys.map((passkey) => h("li", { class: "row" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, passkey.name || "Passkey"),
        h("p", { class: "row-meta" }, [passkey.synced ? "Synced" : "One device", passkey.createdAt ? `added ${shortDate(passkey.createdAt)}` : null].filter(Boolean).join(" · "))),
      h("div", { class: "row-actions" }, passkeys.length > 1 ? confirmButton({
        label: "Remove",
        confirmLabel: "Remove?",
        ariaLabel: `Remove passkey ${passkey.name || ""}`.trim(),
        onConfirm: async () => {
          await owner.removePasskey(passkey.id);
          await loadOwner();
          say("owner", "Passkey removed. Other browsers were signed out.");
        },
        onError: failed("owner"),
      }) : h("span", { class: "row-value" }, "Your only passkey"))));
    if (passkeysSupported()) {
      const add = h("button", { type: "button", class: "pill" }, "Add a passkey");
      add.addEventListener("click", async () => {
        add.disabled = true;
        say("owner", "Waiting for your passkey…");
        try {
          await addPasskey(navigator.userAgentData?.platform || null);
          say("owner", "Passkey added.");
          await loadOwner();
        } catch (error) {
          failed("owner")(error);
        } finally {
          add.disabled = false;
        }
      });
      rows.push(h("li", { class: "row" }, add));
    }
    return h("ul", { class: "settings-card", role: "list", "aria-label": "Passkeys" }, rows);
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
        h("p", { class: "row-title" }, "Without a domain"),
        h("p", { class: "row-meta" }, "Screens play from your home's public address once remote direct play is on. A domain, from about $5 a year, adds direct play on the home network."))));
  }

  // LAN direct play's setup as the control plane last found it: its state,
  // the node's address, and what failed.
  function homeNetworkCard() {
    const status = ownerData.media?.lan;
    if (noDomain()) {
      return h("div", { class: "settings-card" }, h("div", { class: "row", id: "settings-home-network" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, "Home network"),
          h("p", { class: "row-meta" }, "Needs a domain"))));
    }
    const rows = [];
    const label = { ready: "Ready", pending: "Setting up", error: "Needs attention" }[status?.status] ?? "Checking…";
    const detail = !status ? label
      : status.status === "off" ? "Needs the MEDIA_DNS_TOKEN secret on the control plane"
        : [label, status.address].filter(Boolean).join(" · ");
    rows.push(h("div", { class: "row", id: "settings-home-network" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, "Home network"),
        h("p", { class: "row-meta" }, detail),
        status?.error ? h("p", { class: "row-meta" }, `${status.error.step}: ${status.error.message}`) : null),
      status?.configured ? h("div", { class: "row-actions" }, h("button", {
        type: "button",
        class: "pill pill-quiet",
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          say("owner", "Checking the media paths… (a new certificate can take a minute)");
          try {
            ownerData.media = await owner.checkMedia();
            say("owner");
          } catch (error) {
            failed("owner")(error);
          }
          renderOwner();
        },
      }, "Check")) : null));
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
    const lines = !status ? [] : !status.configured ? ["Needs the MEDIA_DNS_TOKEN secret on the control plane"] : !on ? [] : [
      [REMOTE_STATES[status.status] ?? status.status, status.address].filter(Boolean).join(" · "),
      status.reason,
      status.error ? `${status.error.step}: ${status.error.message}` : null,
      byAddress && check && status.status !== "ok" ? `The certificate's check comes through the router's port ${check.externalPort}${check.method === "manual" ? " (your port forward)" : ""}` : null,
      byAddress && status.ipv6Error ? `IPv6: ${status.ipv6Error}` : null,
    ];
    const toggle = status?.configured ? switchButton({
      id: "settings-remote-toggle",
      on,
      labelledBy: "settings-remote-title",
      onToggle: (event) => {
        event.currentTarget.disabled = true;
        void changeMedia({ remote: !on }, on ? "Turning remote access off…" : "Turning remote access on… (the router port and a certificate can take a minute)");
      },
    }) : null;
    return h("div", { class: "settings-card" }, h("div", { class: "row", id: "settings-remote" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title", id: "settings-remote-title" }, "Remote direct play"),
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
      h("p", { class: "row-title", id: "settings-relay-title" }, "Relay through Cloudflare"),
      segmented({
        name: "settings-relay",
        labelledBy: "settings-relay-title",
        options: RELAY_MODES,
        selected: mode,
        disabled: !media,
        onChoose: (value) => {
          if (value !== mode) void changeMedia({ relay: value }, "Changing the relay…");
        },
      }),
      h("p", { class: "row-meta", id: "settings-relay-status" }, [current?.meta, streams ? `${streams.relay} ${streams.relay === 1 ? "stream" : "streams"} in ${streams.days} days` : null].filter(Boolean).join(" · "))));
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
    const nodeText = !about ? "Checking…" : node?.online ? `Online${node.version ? ` · ${node.version}` : ""}` : "Offline";
    groups.about.content.replaceChildren(h("div", { class: "settings-card" },
      h("div", { class: "row" },
        h("div", { class: "row-text" }, h("p", { class: "row-title" }, "Yolo")),
        h("p", { class: "row-value" }, COMMIT ? `${VERSION} · ${COMMIT}` : VERSION)),
      h("div", { class: "row" },
        h("div", { class: "row-text" }, h("p", { class: "row-title" }, "Media node")),
        h("p", { class: `row-value${node?.online ? " ok" : ""}` }, nodeText)),
      h("a", { class: "row row-link", href: "/diag" },
        h("div", { class: "row-text" }, h("p", { class: "row-title" }, "Diagnostics")),
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
