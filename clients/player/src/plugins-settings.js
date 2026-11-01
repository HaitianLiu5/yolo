import { h, switchButton } from "./dom.js";
import { language, t } from "./i18n.js";
import { decidePluginRequest, owner } from "./owner.js";

// Settings › Plugins (Agent Note 2026-10-31-home-cold-start): where the
// owner comes back to choose what the home media node runs. Grouped as the
// owner thinks of it: agents' requests waiting for them, the places they
// watch, link playback (built in, with no switch), and every plugin with
// its switch, what it sends, and its options. Only the signed-in owner
// changes anything; signed out, the group says how to sign in. The guide
// (home-setup.js) and this group are views of the same catalog.

// A manifest text ({ en, zh, … }) in this screen's language.
export function localText(text) {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text[language().split("-")[0]] ?? text.en ?? Object.values(text)[0] ?? "";
}

const STATE_WORDS = {
  on: () => t("On"),
  off: () => t("Off"),
  failed: () => t("Failed"),
  stopping: () => t("Turning off once its streams end"),
  restart: () => t("Applies when the media node restarts"),
  redeploy: () => t("Applies after a redeploy from the home machine"),
};

/**
 * @param {object} options
 * @param {HTMLElement} options.content  the group's body
 * @param {(text?: string) => void} options.say  the group's status line
 * @param {() => void} options.onShowGuide  "Show the guide again"
 */
export function createPluginsSettings({ content, say, onShowGuide }) {
  let data = null; // { catalog, requests } while signed in
  let signedIn = false;
  let open = null; // the plugin whose details show
  let busy = false;

  async function load(isSignedIn) {
    signedIn = isSignedIn;
    if (!signedIn) {
      data = null;
      render();
      return;
    }
    const [catalog, approvals] = await Promise.allSettled([owner.plugins(), owner.approvals()]);
    if (catalog.status === "rejected") {
      data = null;
      say(catalog.reason?.message);
    } else {
      data = { catalog: catalog.value, requests: approvals.status === "fulfilled" ? approvals.value.requests : [] };
    }
    render();
  }

  async function act(work, waiting) {
    if (busy) return;
    busy = true;
    say(waiting);
    try {
      const answer = await work();
      say(answer?.restart ? restartText(answer.restart) : "");
    } catch (error) {
      say(error?.message || String(error));
    } finally {
      busy = false;
      await load(signedIn);
    }
  }

  const restartText = (restart) => (restart.automatic
    ? t("Some changes apply when the media node restarts by itself, once nothing plays")
    : t("Some changes apply when you restart the media node: npm run yolo -- service restart node"));

  function render() {
    if (!signedIn) {
      content.replaceChildren(h("div", { class: "settings-card" }, h("div", { class: "row" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title" }, t("Choose what Yolo shows")),
          h("p", { class: "row-meta" }, t("Sign in under Your Yolo to turn plugins on or off"))),
        guideButton())));
      return;
    }
    if (!data) {
      content.replaceChildren(h("div", { class: "settings-card" }, h("div", { class: "row" }, h("p", { class: "row-meta" }, t("Checking…")))));
      return;
    }
    const { catalog, requests } = data;
    const builtIn = catalog.plugins.filter((plugin) => plugin.builtIn);
    const others = catalog.plugins.filter((plugin) => !plugin.builtIn);
    content.replaceChildren(...[
      catalog.restart ? h("p", { class: "settings-lead" }, restartText(catalog.restart)) : null,
      catalog.config?.writable === false ? h("p", { class: "settings-lead" }, t("The media node cannot write its plugin config; change it on the home machine")) : null,
      requests.length ? h("h3", { class: "settings-subheading" }, t("Waiting for you")) : null,
      requests.length ? h("ul", { class: "settings-card", role: "list" }, requests.map(requestRow)) : null,
      h("h3", { class: "settings-subheading", id: "settings-places-title" }, t("Where you watch")),
      h("ul", { class: "settings-card", role: "list", "aria-labelledby": "settings-places-title" }, [
        ...catalog.places.map((place) => placeRow(place, catalog)),
        h("li", { class: "row" }, h("div", { class: "row-text" }, h("p", { class: "row-meta" }, t("Choose where you watch again"))), guideButton()),
      ]),
      builtIn.length ? h("h3", { class: "settings-subheading" }, t("Built in")) : null,
      builtIn.length ? h("ul", { class: "settings-card", role: "list" }, builtIn.map((plugin) => h("li", { class: "row" },
        h("div", { class: "row-text" }, h("p", { class: "row-title" }, localText(plugin.title)), h("p", { class: "row-meta" }, localText(plugin.summary))),
        h("p", { class: "row-value" }, t("Always on"))))) : null,
      h("h3", { class: "settings-subheading", id: "settings-every-plugin-title" }, t("Every plugin")),
      h("ul", { class: "settings-card", role: "list", "aria-labelledby": "settings-every-plugin-title" }, others.map(pluginRow)),
    ].filter(Boolean));
  }

  function guideButton() {
    return h("button", { type: "button", class: "pill", onclick: () => onShowGuide() }, t("Show the guide"));
  }

  function requestRow(request) {
    const plugin = data.catalog.plugins.find((entry) => entry.name === request.plugin);
    const place = data.catalog.places.find((entry) => entry.id === request.place);
    const what = place ? localText(place.title) : plugin ? localText(plugin.title) : request.plugin;
    const verb = request.change?.enabled === false ? t("Turn off {what}", { what }) : request.change?.options && request.change.enabled === undefined ? t("Change {what}", { what }) : t("Turn on {what}", { what });
    return h("li", { class: "row" },
      h("div", { class: "row-text" }, h("p", { class: "row-title" }, verb), h("p", { class: "row-meta" }, t("Asked by {client}", { client: request.client ?? t("an agent") }))),
      h("button", { type: "button", class: "pill pill-primary", onclick: () => act(() => decidePluginRequest(request.id, true), t("Waiting for your passkey…")) }, t("Allow")),
      h("button", { type: "button", class: "pill pill-quiet", onclick: () => act(() => decidePluginRequest(request.id, false), "") }, t("Deny")));
  }

  function placeRow(place, catalog) {
    const on = place.state === "on";
    const titleId = `settings-place-${place.id}`;
    const brings = place.with.map((name) => catalog.plugins.find((plugin) => plugin.name === name)).filter((plugin) => plugin?.enabled).map((plugin) => localText(plugin.title));
    return h("li", { class: "row" },
      h("div", { class: "row-text" },
        h("p", { class: "row-title", id: titleId }, localText(place.title)),
        h("p", { class: "row-meta" }, [localText(place.summary), on && brings.length ? t("With {plugins}", { plugins: brings.join(", ") }) : null].filter(Boolean).join(" · "))),
      switchButton({
        id: `${titleId}-switch`,
        on,
        labelledBy: titleId,
        onToggle: () => act(() => owner.setPlace(place.id, { enabled: !on }), on ? t("Turning it off…") : t("Turning it on…")),
      }));
  }

  function pluginRow(plugin) {
    const titleId = `settings-plugin-${plugin.name.replace(/[^a-z0-9]+/gi, "-")}`;
    const state = STATE_WORDS[plugin.state]?.() ?? plugin.state;
    const shown = open === plugin.name;
    return h("li", { class: "row row-stack plugin-row" },
      h("div", { class: "row" },
        h("div", { class: "row-text" },
          h("p", { class: "row-title", id: titleId }, localText(plugin.title), plugin.origin === "local" ? h("span", { class: "row-meta" }, t("Not reviewed by Yolo")) : null),
          h("p", { class: "row-meta" }, [state, plugin.error].filter(Boolean).join(": "))),
        h("button", {
          type: "button",
          class: "pill pill-quiet",
          "aria-expanded": String(shown),
          onclick: () => {
            open = shown ? null : plugin.name;
            render();
          },
        }, shown ? t("Less") : t("More")),
        switchButton({
          id: `${titleId}-switch`,
          on: plugin.enabled,
          labelledBy: titleId,
          onToggle: () => act(() => owner.changePlugin(plugin.name, { enabled: !plugin.enabled }), plugin.enabled ? t("Turning it off…") : t("Turning it on…")),
        })),
      shown ? details(plugin) : null);
  }

  // What a plugin adds, reads, keeps, and sends, the hosts it talks to, and
  // its options as a form; a secret shows only whether it is set.
  function details(plugin) {
    const lines = [
      localText(plugin.summary),
      plugin.privacy ? localText(plugin.privacy) : null,
      plugin.hosts.length ? t("Talks to {hosts}", { hosts: plugin.hosts.join(", ") }) : null,
      plugin.terms ? localText(plugin.terms) : null,
      plugin.version ? `${plugin.name} ${plugin.version}` : plugin.name,
    ].filter(Boolean).map((line) => h("p", { class: "row-meta" }, line));
    if (!plugin.options.length) return h("div", { class: "plugin-details" }, lines);
    const form = h("form", { class: "row-edit-form plugin-options" }, plugin.options.map((option) => optionField(plugin, option)),
      h("div", { class: "row-actions" }, h("button", { type: "submit", class: "pill pill-primary" }, t("Save"))));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = {};
      for (const option of plugin.options) {
        const input = form.elements.namedItem(option.key);
        if (!input) continue;
        if (option.type === "boolean") values[option.key] = input.checked;
        else if (option.secret) {
          if (input.value) values[option.key] = input.value;
        } else if (option.type === "folders") values[option.key] = input.value.split("\n").map((line) => line.trim()).filter(Boolean);
        else values[option.key] = input.value.trim() || null;
      }
      void act(() => owner.changePlugin(plugin.name, { options: values }), t("Saving…"));
    });
    return h("div", { class: "plugin-details" }, lines, form);
  }

  function optionField(plugin, option) {
    const id = `option-${plugin.name.replace(/[^a-z0-9]+/gi, "-")}-${option.key}`;
    const hint = [
      option.help ? localText(option.help) : null,
      option.fromEnv ? t("Also set in the node's .env as {name}", { name: option.env }) : null,
      option.secret && option.set ? t("Set; type a new one to replace it") : null,
    ].filter(Boolean).join(" · ");
    let input;
    if (option.type === "boolean") {
      input = h("input", { type: "checkbox", id, name: option.key, checked: option.value ?? option.default ?? false });
    } else if (option.type === "folders") {
      input = h("textarea", { id, name: option.key, rows: 3 }, (option.value ?? []).join("\n"));
    } else {
      input = h("input", {
        id,
        name: option.key,
        type: option.secret ? "password" : option.type === "number" ? "number" : option.type === "url" ? "url" : "text",
        value: option.secret ? "" : option.value ?? "",
        placeholder: option.default != null ? String(option.default) : null,
        autocomplete: "off",
        spellcheck: "false",
      });
    }
    return h("label", { class: "field", for: id },
      h("span", { class: "field-label" }, localText(option.title)),
      input,
      hint ? h("span", { class: "row-meta" }, hint) : null);
  }

  return { load, render };
}
