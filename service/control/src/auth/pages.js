import { DEVICE_KIND_ICONS, DEVICE_KIND_LABELS, DEVICE_KINDS, deviceKindIconSvg, yoloMarkSvg } from "@useyolo/core";

// Server-rendered owner pages: sign-in, pairing a screen, an agent's consent,
// the account page, and messages (Agent Note 2026-10-12-owner-web-pages).
// They share Yolo Web's visual system (clients/tesla/src/style.css): the same
// dark tokens, type scale, radii, 48 px targets, and the Yolo mark, plus a
// light scheme that follows the system setting. Small and dependency-free;
// every value that came from a client or a device is escaped.

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The dark values are Yolo Web's own tokens; a unit test keeps them equal.
export const DARK_TOKENS = Object.freeze({
  "--bg": "oklch(8% 0.008 250)",
  "--surface": "oklch(14% 0.006 250)",
  "--tile": "oklch(17% 0.006 250)",
  "--fg": "oklch(93% 0.008 250)",
  "--fg-2": "oklch(66% 0.008 250)",
  "--fg-3": "oklch(50% 0.006 250)",
  "--line": "oklch(100% 0 0 / 0.1)",
  "--danger": "oklch(72% 0.16 25)",
  "--ok": "oklch(76% 0.13 155)",
  "--press": "oklch(100% 0 0 / 0.12)",
  "--hover": "oklch(100% 0 0 / 0.06)",
});

const LIGHT_TOKENS = Object.freeze({
  "--bg": "oklch(98.4% 0.003 250)",
  "--surface": "oklch(100% 0 0)",
  "--tile": "oklch(95.6% 0.005 250)",
  "--fg": "oklch(21% 0.012 250)",
  "--fg-2": "oklch(44% 0.01 250)",
  "--fg-3": "oklch(56% 0.008 250)",
  "--line": "oklch(0% 0 0 / 0.1)",
  "--danger": "oklch(54% 0.19 25)",
  "--ok": "oklch(52% 0.13 155)",
  "--press": "oklch(0% 0 0 / 0.08)",
  "--hover": "oklch(0% 0 0 / 0.04)",
});

const declarations = (tokens) => Object.entries(tokens).map(([name, value]) => `${name}: ${value};`).join(" ");

// One column under the mark, one left edge, and no borders or dividers:
// spacing (the 4 px scale), grouping, and type carry the structure.
const STYLE = `
  :root { color-scheme: light dark; ${declarations(LIGHT_TOKENS)}
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
    --radius-s: 6px; --radius-m: 12px; --radius-full: 999px; --touch: 48px;
    --fs-meta: 0.8125rem; --fs-body: 0.9375rem; --fs-lede: 1rem; --fs-heading: 1.125rem; --fs-page: 1.5rem; --fs-code: 2.25rem;
    --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1); }
  @media (prefers-color-scheme: dark) { :root { ${declarations(DARK_TOKENS)} } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body { min-height: 100vh; min-height: 100dvh; background: var(--bg); color: var(--fg);
    font: 400 var(--fs-body)/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; }
  .col { width: 100%; max-width: 440px; margin: 0 auto; padding: 0 var(--s5); }
  header.col { padding-top: var(--s4); }
  .brand { display: inline-flex; align-items: center; gap: var(--s2); min-height: var(--touch); color: var(--fg); text-decoration: none;
    font-size: var(--fs-heading); font-weight: 650; letter-spacing: -0.01em; }
  main.col { display: flex; flex-direction: column; gap: var(--s5); padding-top: var(--s6); padding-bottom: var(--s7); }
  @media (min-width: 720px) { main.col { padding-top: var(--s7); } }
  form { display: flex; flex-direction: column; gap: var(--s5); }
  .head { display: flex; flex-direction: column; gap: var(--s2); }
  h1 { font-size: var(--fs-page); font-weight: 650; line-height: 1.2; letter-spacing: -0.015em; }
  .sub { color: var(--fg-2); font-size: var(--fs-lede); }
  .meta { color: var(--fg-3); font-size: var(--fs-meta); }
  code { font: 600 0.92em/1 ui-monospace, "SF Mono", Menlo, monospace; padding: 2px 6px; border-radius: var(--radius-s); background: var(--tile); white-space: nowrap; }
  a { color: inherit; }
  :focus-visible { outline: 2px solid var(--fg); outline-offset: 3px; }

  .actions { display: flex; flex-direction: column; gap: var(--s2); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--s2); width: 100%; min-height: 52px; padding: 0 var(--s5);
    border: 0; border-radius: var(--radius-full); background: var(--tile); color: var(--fg);
    font: inherit; font-size: var(--fs-body); font-weight: 600; text-decoration: none; cursor: pointer;
    transition: transform 100ms var(--ease-out-quart), background-color 120ms, opacity 120ms; }
  .btn:active { transform: scale(0.98); background: var(--press); }
  .btn-primary { background: var(--fg); color: var(--bg); }
  .btn-primary:active { background: var(--fg-2); }
  .btn-quiet { background: transparent; color: var(--fg-2); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .btn svg { width: 20px; height: 20px; flex: none; }
  @media (hover: hover) and (pointer: fine) {
    .btn:not(:disabled):hover { background: var(--press); }
    .btn-primary:not(:disabled):hover { background: var(--fg); opacity: 0.9; }
  }
  .status:empty { display: none; }
  .status { color: var(--fg-2); }
  .status.error { color: var(--danger); }

  .input { width: 100%; height: 56px; padding: 0 var(--s4); border: 0; border-radius: var(--radius-m); background: var(--tile); color: var(--fg);
    font: inherit; font-size: var(--fs-lede); }
  .input:focus { outline: 2px solid var(--fg); outline-offset: 0; }
  .input::placeholder { color: var(--fg-3); }
  .mono { font: 600 1.5rem/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.3em; text-transform: uppercase; }

  .usercode { font: 650 var(--fs-code)/1.1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.06em; font-variant-numeric: tabular-nums; }
  .chip { display: flex; align-items: center; gap: var(--s3); }
  .chip-icon { flex: none; width: 44px; height: 44px; border-radius: var(--radius-m); background: var(--tile); color: var(--fg);
    display: flex; align-items: center; justify-content: center; }
  .chip-name { font-weight: 650; overflow-wrap: anywhere; }

  .name { display: flex; align-items: center; gap: var(--s3); height: 56px; padding: 0 var(--s4) 0 var(--s2); border-radius: var(--radius-m); background: var(--tile); }
  .name:focus-within { outline: 2px solid var(--fg); }
  .name .chip-icon { width: 40px; height: 40px; background: none; color: var(--fg-2); }
  .name input { flex: 1; min-width: 0; height: 100%; border: 0; background: none; color: var(--fg); font: inherit; font-size: var(--fs-lede); font-weight: 600; outline: none; }
  .kinds { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--s1); padding: var(--s1); border: 0; border-radius: var(--radius-m); background: var(--tile); }
  .kinds legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .kind { position: relative; }
  .kind input { position: absolute; opacity: 0; pointer-events: none; }
  .kind span { min-height: 56px; border-radius: var(--radius-s); color: var(--fg-2); font-size: 0.75rem; font-weight: 600;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; cursor: pointer;
    transition: background-color 120ms, color 120ms; }
  .kind input:checked + span { background: var(--fg); color: var(--bg); }
  .kind input:focus-visible + span { outline: 2px solid var(--fg); outline-offset: 2px; }

  .scopes { display: flex; flex-direction: column; gap: var(--s4); }
  .scope { display: grid; grid-template-columns: 1fr auto; gap: var(--s4); align-items: center; min-height: var(--touch); cursor: pointer; }
  .scope-title { display: block; font-weight: 600; }
  .scope-text { display: block; color: var(--fg-2); font-size: var(--fs-meta); }
  .switch { position: relative; width: 48px; height: 28px; }
  .switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
  .switch span { position: absolute; inset: 0; border-radius: var(--radius-full); background: var(--tile); transition: background-color 140ms; pointer-events: none; }
  .switch span::after { content: ""; position: absolute; top: 4px; left: 4px; width: 20px; height: 20px; border-radius: 50%; background: var(--fg-3);
    transition: transform 160ms var(--ease-out-quart), background-color 140ms; }
  .switch input:checked + span { background: var(--fg); }
  .switch input:checked + span::after { transform: translateX(20px); background: var(--bg); }
  .switch input:focus-visible + span { outline: 2px solid var(--fg); outline-offset: 2px; }
  .warn { color: var(--danger); font-weight: 600; }

  .mark { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--tile); color: var(--fg-2); }
  .mark svg { width: 22px; height: 22px; }
  .mark.ok { background: color-mix(in oklch, var(--ok) 16%, transparent); color: var(--ok); }
  .mark.error { background: color-mix(in oklch, var(--danger) 14%, transparent); color: var(--danger); }

  details { margin-top: var(--s5); }
  summary { min-height: var(--touch); display: inline-flex; align-items: center; color: var(--fg-2); font-weight: 600; cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  details[open] { display: flex; flex-direction: column; gap: var(--s4); }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; } }
`;

const ICONS = {
  key: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>',
};

const kindLabel = (kind) => DEVICE_KIND_LABELS[kind] ?? DEVICE_KIND_LABELS.other;

// Where to go back to after pairing, by the kind of screen.
const RETURN_TO = { car: "the car", browser: "that browser", phone: "that phone", tv: "the TV", other: "that screen" };

function page(title, body, { script = "" } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f8f9fa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0c0f" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${escapeHtml(title)} · Yolo</title><style>${STYLE}</style></head>
<body><header class="col"><a class="brand" href="/" aria-label="Yolo">${yoloMarkSvg({ size: 26 })}<span>Yolo</span></a></header>
<main class="col">${body}</main>${script ? `<script type="module">${script}</script>` : ""}</body></html>`;
}

const head = (title, sub = "") => `<div class="head"><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div>`;

// Browser side of WebAuthn: base64url <-> ArrayBuffer around the JSON the
// server library speaks, so it works without PublicKeyCredential.parse*JSON.
// Errors are said in plain words; the code field takes digits only, pasted
// or typed.
const WEBAUTHN_SCRIPT = `
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const s64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const status = document.getElementById("status");
const next = new URLSearchParams(location.search).get("next") || "/account";
const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/account";
const say = (text, error = false) => { status.textContent = text; status.classList.toggle("error", error); };
function plain(error) {
  if (error?.name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again when you're ready.";
  if (error?.name === "InvalidStateError") return "This device already has a Yolo passkey. Sign in with it instead.";
  if (error?.name === "SecurityError") return "Passkeys do not work on this address.";
  return (error?.message || String(error)).replace(/\`/g, "");
}
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || res.statusText);
  return data;
}
const codeInput = document.getElementById("code");
codeInput?.addEventListener("input", () => {
  const digits = codeInput.value.replace(/\\D/g, "").slice(0, 6);
  if (codeInput.value !== digits) codeInput.value = digits;
});
codeInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") document.getElementById("register").click();
});
async function register() {
  const code = codeInput?.value || "";
  const options = await post("/auth/passkey/register/options", { code });
  options.challenge = b64(options.challenge);
  options.user.id = b64(options.user.id);
  options.excludeCredentials = (options.excludeCredentials || []).map((c) => ({ ...c, id: b64(c.id) }));
  const cred = await navigator.credentials.create({ publicKey: options });
  await post("/auth/passkey/register/verify", { code, response: {
    id: cred.id, rawId: s64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment,
    response: { clientDataJSON: s64(cred.response.clientDataJSON), attestationObject: s64(cred.response.attestationObject),
      transports: cred.response.getTransports?.() || [] },
  } });
}
async function login() {
  const options = await post("/auth/passkey/login/options");
  options.challenge = b64(options.challenge);
  options.allowCredentials = (options.allowCredentials || []).map((c) => ({ ...c, id: b64(c.id) }));
  const cred = await navigator.credentials.get({ publicKey: options });
  await post("/auth/passkey/login/verify", { response: {
    id: cred.id, rawId: s64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment,
    response: { clientDataJSON: s64(cred.response.clientDataJSON), authenticatorData: s64(cred.response.authenticatorData),
      signature: s64(cred.response.signature), userHandle: cred.response.userHandle ? s64(cred.response.userHandle) : undefined },
  } });
}
for (const [id, action] of [["register", register], ["login", login]]) {
  const button = document.getElementById(id);
  button?.addEventListener("click", async () => {
    button.disabled = true;
    say("Waiting for your passkey…");
    try { await action(); say("Signed in."); location.href = safeNext; }
    catch (error) { say(plain(error), true); button.disabled = false; }
  });
}
`;

// The 6-digit pairing code from `npm run owner-code` on the home machine:
// a one-time-code field (numeric keyboard, autofill from messages, paste).
const CODE_INPUT = `<input type="text" id="code" class="input mono" inputmode="numeric" autocomplete="one-time-code"
  pattern="[0-9]{6}" maxlength="6" placeholder="000000" aria-label="6-digit code" spellcheck="false">`;

const STATUS = '<p id="status" class="status" role="status" aria-live="polite"></p>';

function deviceChip({ deviceName, deviceKind, userCode }) {
  return `<div class="chip"><span class="chip-icon">${deviceKindIconSvg(deviceKind, { size: 24 })}</span>
      <div><p class="chip-name">${escapeHtml(deviceName)}</p>
        <p class="meta">${escapeHtml(kindLabel(deviceKind))}${userCode ? ` · ${escapeHtml(userCode)}` : ""}</p></div></div>`;
}

// /login. `context` says what the sign-in is for, so the page keeps it in
// view: a screen waiting to pair ({ kind: "device", deviceName, deviceKind,
// userCode }), an agent's consent ({ kind: "consent" }), or Yolo's settings.
export function loginPage({ hasPasskey, context = null }) {
  if (!hasPasskey) {
    return page("Set up", `
      ${head("Set up Yolo", "On the media node's computer, run <code>npm run owner-code</code> and enter the code it prints.")}
      ${CODE_INPUT}
      <div class="actions"><button class="btn btn-primary" id="register" type="button">${ICONS.key}Create passkey</button></div>
      ${STATUS}`, { script: WEBAUTHN_SCRIPT });
  }
  const titles = { device: "Sign in to pair a screen", consent: "Sign in to connect an app", settings: "Sign in to Yolo's settings" };
  const chip = context?.kind === "device" && context.deviceName ? deviceChip(context) : "";
  return page("Sign in", `
    ${head(escapeHtml(titles[context?.kind] ?? "Sign in to Yolo"))}
    ${chip}
    <div class="actions"><button class="btn btn-primary" id="login" type="button">${ICONS.key}Sign in with passkey</button></div>
    ${STATUS}
    <details><summary>Lost every passkey?</summary>
      <p class="sub">On the media node's computer, run <code>npm run owner-code</code> and enter the code. The new passkey replaces all others and signs you out everywhere.</p>
      ${CODE_INPUT}
      <div class="actions"><button class="btn" id="register" type="button">Replace passkeys</button></div>
    </details>`, { script: WEBAUTHN_SCRIPT });
}

const SCOPES = {
  read: { title: "See", text: "What's playing, your library and history" },
  control: { title: "Play and control", text: "Play, pause, seek, switch screens" },
  manage: { title: "Change", text: "Queue, playlists, history, devices" },
};

export function consentPage(details, handle) {
  const name = escapeHtml(details.clientName || "An app");
  const from = details.clientDomain ? escapeHtml(details.clientDomain) : "Name not verified";
  const scopes = (details.scope?.length ? details.scope : Object.keys(SCOPES)).map((scope) => `
      <label class="scope"><span><span class="scope-title">${escapeHtml(SCOPES[scope]?.title || scope)}</span>
        <span class="scope-text">${escapeHtml(SCOPES[scope]?.text || "")}</span></span>
        <span class="switch"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked><span></span></span></label>`).join("");
  return page(`Allow ${details.clientName || "app"}?`, `
    <div class="head"><h1>Allow ${name} to use Yolo?</h1><p class="meta">${from} · access goes to ${escapeHtml(details.redirectHost)}</p></div>
    ${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started it.</p>' : ""}
    <form method="post" id="consent">
      <input type="hidden" name="handle" value="${escapeHtml(handle)}">
      <div class="scopes">${scopes}</div>
      <div class="actions"><button class="btn btn-primary" name="decision" value="approve" id="allow">Allow</button>
        <button class="btn btn-quiet" name="decision" value="deny">Deny</button></div>
    </form>`, {
    script: `const form = document.getElementById("consent"); const allow = document.getElementById("allow");
const sync = () => { allow.disabled = !form.querySelector('input[name="scope"]:checked'); };
form.addEventListener("change", sync); sync();`,
  });
}

// /account: who is signed in, and the way into Yolo and its settings.
export function accountPage({ signedIn, origin }) {
  const agents = `Agents connect at ${escapeHtml(origin)}/mcp`;
  return page("Account", signedIn ? `
    ${head("Signed in", agents)}
    <div class="actions">
      <a class="btn btn-primary" href="/">Open Yolo</a>
      <a class="btn" href="/settings">Settings</a>
      <form method="post" action="/auth/logout"><button class="btn btn-quiet">Sign out</button></form>
    </div>` : `
    ${head("Yolo", agents)}
    <div class="actions"><a class="btn btn-primary" href="/login?next=/account">${ICONS.key}Sign in</a><a class="btn" href="/">Open Yolo</a></div>`);
}

export function deviceCodeForm(error = "") {
  return page("Pair a screen", `
    ${head("Enter the screen's code", "Or scan its QR code with your phone.")}
    <form method="get" action="/device">
      <input type="text" name="code" class="input mono" autocomplete="off" autocapitalize="characters" spellcheck="false"
        placeholder="XXXX-XXXX" aria-label="Pairing code" required maxlength="9"${error ? ' aria-invalid="true" aria-describedby="code-error"' : ""}>
      ${error ? `<p class="status error" id="code-error" role="alert">${escapeHtml(error)}</p>` : ""}
      <div class="actions"><button class="btn btn-primary">Continue</button></div>
    </form>`, {
    script: `const input = document.querySelector('input[name="code"]');
input.addEventListener("input", () => {
  const letters = input.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  const formatted = letters.length > 4 ? letters.slice(0, 4) + "-" + letters.slice(4) : letters;
  if (input.value !== formatted) input.value = formatted;
});`,
  });
}

// Device-code phishing guard (Agent Note 2026-10-07-device-code-pairing): at
// a glance, the code the screen should show and when it asked; nothing
// happens without pressing Allow. The name and type start as the screen's
// own guess (the Tesla browser's user agent is plain desktop Chrome, so a
// car guesses from its screen), and the owner can change both here.
export function deviceConfirmPage({ deviceName, deviceKind, requestedAt, userCode }) {
  const iso = new Date(requestedAt).toISOString();
  const kind = DEVICE_KINDS.includes(deviceKind) ? deviceKind : "other";
  const kinds = DEVICE_KINDS.map((value) => `<label class="kind"><input type="radio" name="kind" value="${escapeHtml(value)}"${value === kind ? " checked" : ""}>
        <span>${deviceKindIconSvg(value, { size: 22 })}${escapeHtml(kindLabel(value))}</span></label>`).join("");
  return page("Allow this screen?", `
    <div class="head"><h1>Allow this screen?</h1>
      <p><span class="usercode">${escapeHtml(userCode)}</span></p>
      <p class="meta">Check it matches the screen · asked <time datetime="${iso}">at ${escapeHtml(iso.slice(11, 16))} UTC</time></p></div>
    <form method="post" action="/device" id="pair">
      <input type="hidden" name="code" value="${escapeHtml(userCode)}">
      <label class="name"><span class="chip-icon" id="kind-icon">${deviceKindIconSvg(kind, { size: 24 })}</span>
        <input type="text" name="name" value="${escapeHtml(deviceName)}" maxlength="60" required autocomplete="off" aria-label="Name on Yolo"></label>
      <fieldset class="kinds"><legend>Type</legend>${kinds}</fieldset>
      <div class="actions"><button class="btn btn-primary" name="decision" value="approve">Allow</button>
        <button class="btn btn-quiet" name="decision" value="deny" formnovalidate>Deny</button></div>
    </form>`, {
    script: `const icons = ${JSON.stringify(DEVICE_KIND_ICONS)};
const t = document.querySelector("time"); const at = new Date(t.dateTime);
const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
t.textContent = minutes < 1 ? "just now" : minutes + " min ago";
document.getElementById("pair").addEventListener("change", (event) => {
  if (event.target.name !== "kind") return;
  document.querySelector("#kind-icon path").setAttribute("d", icons[event.target.value] || icons.other);
});`,
  });
}

function htmlResponse(html, status) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function outcome(tone, icon, title, text, action) {
  return `<div class="mark ${tone}">${icon}</div>
    ${head(escapeHtml(title), escapeHtml(text))}
    ${action ? `<div class="actions"><a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></div>` : ""}`;
}

// After Allow: what happens next, on the screen that was paired.
export function devicePairedPage({ deviceName, deviceKind }) {
  const where = RETURN_TO[deviceKind] ?? RETURN_TO.other;
  return htmlResponse(page(`${deviceName} is paired`,
    outcome("ok", ICONS.check, `${deviceName} is paired`, `Go back to ${where}. It continues by itself.`, { href: "/", label: "Open Yolo here" })), 200);
}

export function deviceDeniedPage({ deviceName }) {
  return htmlResponse(page("Not paired",
    outcome("", ICONS.cross, `${deviceName} was not paired`, "Start again on the screen to get a new code.")), 200);
}

const MESSAGE_ICONS = { error: ["error", ICONS.info], expired: ["", ICONS.clock], info: ["", ICONS.info], ok: ["ok", ICONS.check] };

// A one-sentence outcome with a way on. `kind`: error, expired, info, ok.
export function messagePage(title, message, status = 400, { kind = status >= 400 ? "error" : "info", action = { href: "/", label: "Back to Yolo" } } = {}) {
  const [tone, icon] = MESSAGE_ICONS[kind] ?? MESSAGE_ICONS.info;
  return htmlResponse(page(title, outcome(tone, icon, title, message, action)), status);
}
