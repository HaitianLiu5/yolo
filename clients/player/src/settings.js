import { renderSVG } from "uqr";
import { DANMAKU_OPACITY_STEPS, DEVICE_KIND_LABELS, DEVICE_KINDS } from "@useyolo/core";
import { api } from "./api.js";
import { h, icons, shortDate } from "./dom.js";
import { addPasskey, owner, passkeysSupported, signInWithPasskey } from "./owner.js";
import { state } from "./state.js";
import { timeAgo } from "./utils.js";

// Settings (Agent Note 2026-10-11-yolo-web-client): one sheet in three groups.
//
// - This screen: what Yolo calls this device, its display size (the car
//   only, display-scale.js), danmaku (danmaku-settings.js), playing over the
//   home network and the media path it takes (media-paths.js), and
//   forgetting it. The device credential is enough for these.
// - Your Yolo: devices, connected agents and the image links of the covers
//   they show, passkeys, the media paths (the home network, remote access,
//   the relay's mode, and the path each screen used last), and signing out. They need the owner's passkey session
//   (owner.js); the device credential never reaches them. The car, whose
//   browser may not do passkeys, also offers a QR code that opens these
//   settings on a phone.
// - About: the version, the media node, and /diag.
//
// The same sheet serves the car's touchscreen and a computer's keyboard: a
// modal <dialog> (focus stays inside, Escape and a visible Close leave it),
// 48 px targets, nothing that needs hover, and destructive actions that ask
// again in place instead of opening another dialog.

const VERSION = typeof __YOLO_VERSION__ === "string" ? __YOLO_VERSION__ : "dev";
const COMMIT = typeof __YOLO_COMMIT__ === "string" ? __YOLO_COMMIT__ : "";
const CONFIRM_MS = 4_000;
const SCOPE_WORDS = { read: "see", control: "play", manage: "change" };

const kindLabel = (kind) => DEVICE_KIND_LABELS[kind] ?? DEVICE_KIND_LABELS.other;

// What this screen's last probe of the node's LAN origin means
// (Agent Note 2026-10-12-lan-direct-play), in the owner's words.
const LAN_OUTCOMES = Object.freeze({
  off: "Off on this screen",
  ok: "Playing from the home network",
  timeout: "The media node did not answer here: this screen is not on the home network",
  permission_prompt: "Waiting for the browser's permission: press Check and allow local network access",
  permission_denied: "The browser blocks local network access. Allow it in this site's settings; on a Mac, also allow the browser in System Settings › Privacy & Security › Local Network",
  certificate: "The node's certificate is not valid yet; Yolo renews it",
  dns_rebinding: "The router hides the node's name (DNS rebinding protection). Allow the name below in the router, or the whole domain",
});

function lanOutcomeText(last) {
  if (!last) return "Not checked yet";
  return LAN_OUTCOMES[last.outcome] ?? `The node answered ${String(last.outcome).replace(/^http_/, "")}`;
}

// The media paths (Agent Note 2026-10-13-media-off-the-worker), in the owner's words.
const PATH_NAMES = Object.freeze({ lan: "the home network", wan: "remote direct play", relay: "the relay through Cloudflare" });
const REMOTE_OUTCOMES = Object.freeze({
  ok: "answers", timeout: "no answer: the router does not forward the port, or this network blocks it", failed: "the connection failed", certificate: "its certificate is not valid", off: "off",
});
// What the router's NAT loopback means for a screen at home without a domain.
const HAIRPIN = Object.freeze({
  ok: "At home: your router loops back to the home's address, so this screen plays directly at home too",
  failed: "At home: your router does not loop back to the home's address, so at home this screen uses the relay unless it is off",
});
// The relay's modes, in the owner's words.
const RELAY_MODES = Object.freeze([
  { value: "auto", label: "Automatic", meta: "Only when no direct path works for a screen" },
  { value: "on", label: "On", meta: "Always available, as the last path" },
  { value: "off", label: "Off", meta: "Screens play only from the home node directly" },
]);
const RELAY_STATUS = Object.freeze({ auto: "The relay steps in when no direct path works", on: "The relay is on", off: "The relay is off" });
const REMOTE_STATES = Object.freeze({
  off: "Off",
  pending: "Setting up",
  ok: "Ready: reachable from outside the home",
  cgnat: "Not possible on this internet connection: the home is behind carrier-grade or double NAT",
  unreachable: "Not reachable from outside the home",
  certificate: "Waiting for a valid certificate",
  error: "Needs attention",
});

// A button that asks once more in place ("Remove" → "Remove?") before it
// acts; it goes back after a few seconds or when focus leaves it.
function confirmButton({ label, confirmLabel, ariaLabel, onConfirm, onError }) {
  const button = h("button", { type: "button", class: "pill pill-quiet", "aria-label": ariaLabel ?? null }, label);
  let timer = null;
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    button.textContent = label;
    button.classList.remove("armed");
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  };
  button.addEventListener("click", async () => {
    if (!timer) {
      button.textContent = confirmLabel;
      button.classList.add("armed");
      button.setAttribute("aria-label", confirmLabel);
      timer = setTimeout(disarm, CONFIRM_MS);
      return;
    }
    disarm();
    button.disabled = true;
    try {
      await onConfirm();
    } catch (error) {
      onError?.(error);
    } finally {
      button.disabled = false;
    }
  });
  button.addEventListener("blur", () => {
    if (timer) disarm();
  });
  return button;
}

// The device type as a segmented choice with icons: radio inputs, so arrow
// keys move between them.
export function kindChoice(name, selected) {
  return h("fieldset", { class: "kind-choice" },
    h("legend", { class: "field-label" }, "Type"),
    h("div", { class: "kind-options" }, DEVICE_KINDS.map((kind) => h("label", { class: "kind-option" },
      h("input", { type: "radio", name, value: kind, checked: kind === selected }),
      h("span", { class: "kind-face" }, h("span", { html: icons.kind(kind, 20) }), h("span", {}, kindLabel(kind))),
    ))));
}

/**
 * @param {object} options
 * @param {HTMLDialogElement} options.dialog
 * @param {object} options.profile  profile.js
 * @param {object} options.displayScale  display-scale.js
 * @param {object} [options.danmaku]  danmaku-settings.js
 * @param {() => Promise<void>} options.onForget  unpair this screen
 * @param {() => void} options.onRequestClose  Close, Escape, or the backdrop
 */
export function createSettings({ dialog, profile, displayScale, paths = null, danmaku = null, onForget, onRequestClose }) {
  const body = dialog.querySelector("#settings-body");
  const ownerData = { signedIn: null, devices: null, agents: null, passkeys: null, media: null, imageLinks: null };
  let about = null;
  let editing = null;

  const groups = {
    screen: group("settings-screen", "This screen"),
    owner: group("settings-owner", "Your Yolo"),
    about: group("settings-about", "About"),
  };
  body.replaceChildren(groups.screen.section, groups.owner.section, groups.about.section);

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

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    onRequestClose();
  });
  dialog.querySelector("#settings-close").addEventListener("click", () => onRequestClose());
  // A tap on the dimmed page beside the sheet closes it too.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) onRequestClose();
  });

  // --- This screen --------------------------------------------------------

  function selfDevice() {
    return (state.devices || []).find((device) => device.id === state.deviceId) ?? null;
  }

  function renderScreen() {
    const device = selfDevice();
    const rows = [
      h("div", { class: "row" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title", id: "settings-device-name" }, device?.name ?? "This screen"),
          h("p", { class: "row-meta" }, [device ? kindLabel(device.kind) : null, profile.canPlay ? null : "Remote only"].filter(Boolean).join(" · ")))),
    ];
    if (displayScale.eligible) rows.push(displaySizeRow());
    if (danmaku && profile.canPlay) rows.push(...danmakuRows());
    if (paths && profile.canPlay) rows.push(lanRow(), pathRow());
    rows.push(h("div", { class: "row" },
      h("div", { class: "row-text" }, h("p", { class: "row-title" }, "Forget this screen")),
      h("div", { class: "row-actions" }, confirmButton({
        label: "Forget",
        confirmLabel: "Forget it?",
        ariaLabel: "Forget this screen",
        onConfirm: () => onForget(),
        onError: failed("screen"),
      }))));
    groups.screen.content.replaceChildren(h("div", { class: "settings-card" }, rows));
  }

  // Play over the home network: this screen's switch, what its last probe
  // found, and a check that may show the browser's permission prompt.
  function lanRow() {
    const status = paths.status();
    if (!status.domain) {
      return h("div", { class: "row", id: "settings-lan" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, "Play over the home network"),
          h("p", { class: "row-meta", id: "settings-lan-status" }, "Needs a domain. Without one, this screen plays at home from the home's public address where the router loops back to it")));
    }
    const on = status.enabled;
    const meta = !status.origin ? "Yolo has no home network address for the media node yet"
      : !on ? "Off: this screen does not look for the media node on the home network"
        : lanOutcomeText(status.last);
    const host = status.origin ? new URL(status.origin).hostname : null;
    const actions = [h("button", {
      type: "button",
      class: `pill${on ? "" : " pill-primary"}`,
      id: "settings-lan-toggle",
      "aria-pressed": String(on),
      onclick: async () => {
        if (!on) say("screen", "Checking… your browser may ask to find devices on the local network");
        await paths.setEnabled(!on);
        say("screen");
        renderScreen();
      },
    }, on ? "Turn off" : "Turn on")];
    if (on && status.origin) {
      actions.unshift(h("button", {
        type: "button",
        class: "pill pill-quiet",
        onclick: async () => {
          say("screen", "Checking…");
          await paths.probe("settings", { owner: true });
          say("screen");
          renderScreen();
        },
      }, "Check"));
    }
    return h("div", { class: "row", id: "settings-lan" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, "Play over the home network"),
        h("p", { class: "row-meta", id: "settings-lan-status" }, meta),
        on && host && status.last?.outcome === "dns_rebinding" ? h("p", { class: "row-meta" }, host) : null),
      h("div", { class: "row-actions" }, actions));
  }

  // The path this screen's next stream takes, and what each probe found.
  function pathRow() {
    const status = paths.status();
    const title = status.network ? `Media comes by ${PATH_NAMES[status.network]}` : "No media path reaches this screen";
    const remote = status.probes.wan;
    const details = [
      status.remoteOrigin ? `Remote direct play: ${remote ? REMOTE_OUTCOMES[remote.outcome] ?? remote.outcome : "not checked yet"}` : "Remote direct play is not set up",
      RELAY_STATUS[status.relayMode] ?? (status.relay ? RELAY_STATUS.on : RELAY_STATUS.off),
    ];
    return h("div", { class: "row", id: "settings-path" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title", id: "settings-path-title" }, title),
        h("p", { class: "row-meta", id: "settings-path-status" }, details.join(" · ")),
        status.home && status.hairpin ? h("p", { class: "row-meta", id: "settings-path-hairpin" }, HAIRPIN[status.hairpin]) : null));
  }

  // Display size: five steps from smaller to larger, as one radio group.
  function displaySizeRow() {
    const options = displayScale.options();
    const choose = (option) => {
      displayScale.choose(option.value);
      renderScreen();
      groups.screen.content.querySelector(".size-step[aria-checked='true']")?.focus();
    };
    const steps = options.map((option, index) => h("button", {
      type: "button",
      class: "size-step",
      role: "radio",
      "aria-checked": String(option.active),
      tabindex: option.active ? "0" : "-1",
      "data-value": String(option.value),
      onclick: () => choose(option),
      onkeydown: (event) => {
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!delta) return;
        event.preventDefault();
        const next = options[Math.min(options.length - 1, Math.max(0, index + delta))];
        if (next !== option) choose(next);
      },
    },
    h("span", { class: "size-glyph", style: `font-size:${14 + index * 3.25}px`, "aria-hidden": "true" }, "A"),
    h("span", { class: "size-label" }, option.label)));
    return h("div", { class: "row row-stack" },
      h("p", { class: "row-title", id: "settings-size-title" }, "Display size"),
      h("div", { class: "size-scale", role: "radiogroup", "aria-labelledby": "settings-size-title" }, steps));
  }

  // One choice of a few, as a radio group of 48 px steps; arrow keys move
  // between them.
  function choiceRow({ id, title, options, selected, onChoose }) {
    const choose = (value) => {
      onChoose(value);
      renderScreen();
      groups.screen.content.querySelector(`#${id} .choice-step[aria-checked='true']`)?.focus();
    };
    const steps = options.map((option, index) => h("button", {
      type: "button",
      class: "choice-step",
      role: "radio",
      "aria-checked": String(option.value === selected),
      tabindex: option.value === selected ? "0" : "-1",
      "data-value": String(option.value),
      onclick: () => choose(option.value),
      onkeydown: (event) => {
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!delta) return;
        event.preventDefault();
        const next = options[Math.min(options.length - 1, Math.max(0, index + delta))];
        if (next !== option) choose(next.value);
      },
    }, option.label));
    return h("div", { class: "row row-stack", id },
      h("p", { class: "row-title", id: `${id}-title` }, title),
      h("div", { class: "choice-scale", role: "radiogroup", "aria-labelledby": `${id}-title` }, steps));
  }

  // Danmaku: on or off, and how they look on this screen.
  function danmakuRows() {
    const current = danmaku.get();
    const change = (patch) => danmaku.update(patch);
    return [
      h("div", { class: "row", id: "settings-danmaku" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, "Danmaku"),
          h("p", { class: "row-meta" }, current.enabled ? "Viewer comments over the picture, where a video has them" : "Off on this screen")),
        h("div", { class: "row-actions" }, h("button", {
          type: "button",
          class: `pill${current.enabled ? "" : " pill-primary"}`,
          id: "settings-danmaku-toggle",
          "aria-pressed": String(current.enabled),
          onclick: () => {
            change({ enabled: !current.enabled });
            renderScreen();
          },
        }, current.enabled ? "Turn off" : "Turn on"))),
      choiceRow({
        id: "settings-danmaku-density",
        title: "Danmaku density",
        options: [{ value: "low", label: "Fewer" }, { value: "normal", label: "Normal" }, { value: "high", label: "All" }],
        selected: current.density,
        onChoose: (density) => change({ density }),
      }),
      choiceRow({
        id: "settings-danmaku-area",
        title: "Danmaku area",
        options: [{ value: "full", label: "Full" }, { value: "half", label: "Top half" }, { value: "quarter", label: "Top quarter" }],
        selected: current.area,
        onChoose: (area) => change({ area }),
      }),
      choiceRow({
        id: "settings-danmaku-opacity",
        title: "Danmaku opacity",
        options: DANMAKU_OPACITY_STEPS.map((value) => ({ value, label: `${Math.round(value * 100)}%` })),
        selected: DANMAKU_OPACITY_STEPS.reduce((best, value) => (Math.abs(value - current.opacity) < Math.abs(best - current.opacity) ? value : best)),
        onChoose: (opacity) => change({ opacity }),
      }),
      choiceRow({
        id: "settings-danmaku-size",
        title: "Danmaku text size",
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
    const [devices, agents, passkeys, media, imageLinks] = await Promise.allSettled([owner.devices(), owner.agents(), owner.passkeys(), owner.media(), owner.imageLinks()]);
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
    content.replaceChildren(
      h("h3", { class: "settings-subheading" }, "Devices"),
      h("ul", { class: "settings-card", role: "list", "aria-label": "Devices" }, (ownerData.devices || [])
        .filter((device) => device.via !== "node" || device.online)
        .map(deviceRow)),
      h("h3", { class: "settings-subheading" }, "Connected agents"),
      agentsList(),
      imageLinksCard(),
      h("h3", { class: "settings-subheading" }, "Passkeys"),
      passkeysList(),
      h("h3", { class: "settings-subheading" }, "Media paths"),
      noDomainCard(),
      homeNetworkCard(),
      remoteCard(),
      relayCard(),
      screensCard(),
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
    );
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

  function deviceRow(device) {
    const self = device.id === state.deviceId;
    if (editing === device.id) return deviceEditor(device);
    const seen = device.online ? h("span", { class: "ok" }, "Online")
      : device.lastSeenAt ? `Seen ${timeAgo(device.lastSeenAt)}` : "Not connected yet";
    const parts = [self ? "This screen" : null, kindLabel(device.kind), seen, device.capabilities?.renderer === "remote" ? "Remote" : null].filter(Boolean);
    const meta = parts.flatMap((part, index) => (index ? [" · ", part] : [part]));
    const actions = [
      h("button", {
        type: "button",
        class: "pill pill-quiet",
        "aria-label": `Rename ${device.name}`,
        onclick: () => {
          editing = device.id;
          renderOwner();
          groups.owner.content.querySelector(".row-edit input[name='name']")?.focus();
        },
      }, "Rename"),
      confirmButton({
        label: "Remove",
        confirmLabel: "Remove?",
        ariaLabel: `Remove ${device.name}`,
        onConfirm: async () => {
          await owner.removeDevice(device.id);
          if (self) return onForget({ removed: true });
          await loadOwner();
        },
        onError: failed("owner"),
      }),
    ];
    return h("li", { class: "row", "data-device": device.id },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, device.name),
        h("p", { class: "row-meta" }, meta)),
      h("div", { class: "row-actions" }, actions));
  }

  function deviceEditor(device) {
    const form = h("form", { class: "row-edit-form" },
      h("label", { class: "field" },
        h("span", { class: "field-label" }, "Name"),
        h("input", { type: "text", name: "name", value: device.name, maxlength: "60", required: true, autocomplete: "off", enterkeyhint: "done" })),
      kindChoice(`kind-${device.id}`, device.kind),
      h("div", { class: "row-actions" },
        h("button", { type: "button", class: "pill pill-quiet", onclick: () => cancel() }, "Cancel"),
        h("button", { type: "submit", class: "pill pill-primary" }, "Save")));
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
        h("p", { class: "row-meta" }, [
          "Covers in agents' chats load from links anyone with the link can open. Reset to make every link so far stop working.",
          resetAt ? `Last reset ${shortDate(resetAt)}.` : null,
        ].filter(Boolean).join(" "))),
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
  // what plays where, the one router step, and what a domain adds.
  function noDomainCard() {
    if (!noDomain()) return null;
    return h("div", { class: "settings-card" }, h("div", { class: "row", id: "settings-no-domain" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, "Without a domain"),
        h("p", { class: "row-meta" }, "Away from home: once remote direct play is on, every screen, the car on LTE included, plays straight from your home node at your home's public address."),
        h("p", { class: "row-meta" }, "Your router: the node asks it for the ports it needs. If the router refuses, the card below names the one port to forward, which is the only step on the router."),
        h("p", { class: "row-meta" }, "At home: a screen uses the same address only if your router loops back to it; otherwise it uses the relay unless it is off. A domain, from about $5 a year, adds direct play on the home network in every browser."))));
  }

  // LAN direct play's setup as the control plane last found it: the node's
  // name and address, its certificate, and what failed.
  function homeNetworkCard() {
    const status = ownerData.media?.lan;
    if (noDomain()) {
      return h("div", { class: "settings-card" }, h("div", { class: "row", id: "settings-home-network" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, "Home network: Needs a domain"),
          h("p", { class: "row-meta" }, "Direct play on the home network needs a name for the node, which a domain gives"))));
    }
    const rows = [];
    const label = { off: "Off", ready: "Ready", pending: "Setting up", error: "Needs attention" }[status?.status] ?? "Checking…";
    const detail = !status ? null
      : status.status === "off" ? "Set the MEDIA_DNS_TOKEN secret on the control plane to turn it on"
        : [status.name, status.address].filter(Boolean).join(" · ") || null;
    rows.push(h("div", { class: "row", id: "settings-home-network" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, `Home network: ${label}`),
        detail ? h("p", { class: "row-meta" }, detail) : null,
        status?.notAfter ? h("p", { class: "row-meta" }, `Certificate valid until ${shortDate(status.notAfter)}${status.renewAt ? `, renewed from ${shortDate(status.renewAt)}` : ""}`) : null,
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
      }, "Check now")) : null));
    return h("div", { class: "settings-card" }, rows);
  }

  // Remote direct play: the owner's switch, and what the last check found
  // (the name, the public address, the router port, the outside check).
  function remoteCard() {
    const status = ownerData.media?.remote;
    const on = Boolean(status?.on);
    const byAddress = status?.certificate === "ip";
    const check = status?.challenge;
    const lines = !status ? [] : !status.configured ? ["Needs the MEDIA_DNS_TOKEN secret on the control plane"] : [
      REMOTE_STATES[status.status] ?? status.status,
      status.reason,
      status.error ? `${status.error.step}: ${status.error.message}` : null,
      [byAddress ? status.origin : status.name, status.address, status.mapping?.method ? (status.mapping.method === "manual" ? "your port forward" : `router port by ${status.mapping.method}`) : null].filter(Boolean).join(" · ") || null,
      byAddress && check ? `Certificate check through the router's port ${check.externalPort}${check.type === "tls-alpn-01" ? ", the remote listener's own" : check.method === "manual" ? " (your port forward)" : check.method ? ` (mapped by ${check.method} for the check only)` : ""}` : null,
      status.notAfter ? `Certificate valid until ${shortDate(status.notAfter)}${byAddress ? ", renewed every few days" : ""}` : null,
      byAddress && status.ipv6Error ? `IPv6: ${status.ipv6Error}` : null,
    ];
    return h("div", { class: "settings-card" }, h("div", { class: "row", id: "settings-remote" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, "Remote direct play"),
        ...lines.filter(Boolean).map((line) => h("p", { class: "row-meta" }, line))),
      status?.configured ? h("div", { class: "row-actions" }, h("button", {
        type: "button",
        class: `pill${on ? "" : " pill-primary"}`,
        id: "settings-remote-toggle",
        "aria-pressed": String(on),
        onclick: (event) => {
          event.currentTarget.disabled = true;
          void changeMedia({ remote: !on }, on ? "Turning remote access off…" : "Turning remote access on… (the router port and a certificate can take a minute)");
        },
      }, on ? "Turn off" : "Turn on")) : null));
  }

  // The relay through the Worker: its mode as one choice of three, the one
  // line about it, and how many streams it carried this week.
  function relayCard() {
    const media = ownerData.media;
    const mode = media?.relay?.mode ?? (media?.relay?.on === false ? "off" : "auto");
    const streams = media?.streams;
    const choose = (value) => {
      if (value !== mode) void changeMedia({ relay: value }, "Changing the relay…");
    };
    const steps = RELAY_MODES.map((option, index) => h("button", {
      type: "button",
      class: "choice-step",
      role: "radio",
      "aria-checked": String(option.value === mode),
      tabindex: option.value === mode ? "0" : "-1",
      "data-value": option.value,
      disabled: media ? null : true,
      onclick: () => choose(option.value),
      onkeydown: (event) => {
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!delta) return;
        event.preventDefault();
        choose(RELAY_MODES[Math.min(RELAY_MODES.length - 1, Math.max(0, index + delta))].value);
      },
    }, option.label));
    const current = RELAY_MODES.find((option) => option.value === mode);
    return h("div", { class: "settings-card" }, h("div", { class: "row row-stack", id: "settings-relay" },
      h("p", { class: "row-title", id: "settings-relay-title" }, "Relay through Cloudflare"),
      h("p", { class: "row-meta" }, media?.relay?.note ?? "Media goes through your Cloudflare account when no direct path works."),
      h("div", { class: "choice-scale", role: "radiogroup", "aria-labelledby": "settings-relay-title" }, steps),
      h("p", { class: "row-meta", id: "settings-relay-status" }, [current?.meta, streams ? `${streams.relay} ${streams.relay === 1 ? "stream" : "streams"} took the relay in the last ${streams.days} days` : null].filter(Boolean).join(" · "))));
  }

  // The path each screen's last stream took, and when it started.
  function screensCard() {
    const screens = ownerData.media?.screens;
    if (!screens?.length) return null;
    return h("ul", { class: "settings-card", role: "list", "aria-label": "Each screen's last path", id: "settings-screen-paths" }, screens.map((screen) => h("li", { class: "row", "data-screen": screen.id },
      h("div", { class: "row-text" },
        h("p", { class: "row-title" }, screen.name),
        h("p", { class: "row-meta" }, screen.path ? `Last played by ${PATH_NAMES[screen.path] ?? screen.path}${screen.at ? ` · ${timeAgo(screen.at)}` : ""}` : "Has not played yet")))));
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
      await Promise.allSettled([loadOwner(), loadAbout()]);
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
