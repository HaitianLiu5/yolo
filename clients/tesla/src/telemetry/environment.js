import { readFingerprintInput, teslaFingerprint } from "../device-fingerprint.js";

// The `env` device event: what this browser is, so detection of the Tesla
// browser can be designed from real data (its user agent stopped saying
// "Tesla" with software 2026.26). Sent once per page load, and again after a
// realtime reconnect only if something changed. It includes a bounded probe
// for a native bridge the car's browser might inject: names, types and keys
// only. Nothing found is ever called.

export const ENV_EVENT_MAX_BYTES = 8 * 1024;
const HIGH_ENTROPY_HINTS = ["platformVersion", "architecture", "bitness", "model", "fullVersionList", "wow64", "formFactors"];
const MAX_RESIDUAL_GLOBALS = 100;
const MAX_KEYS = 20;
const ASYNC_TIMEOUT_MS = 1_000;

// Window globals every browser has, by prefix (the owner's list) …
const STANDARD_GLOBAL_PREFIX = new RegExp(`^(${[
  "HTML", "SVG", "CSS", "WebGL", "WebGL2", "RTC", "Media", "Audio", "Video", "Text", "XR", "GPU", "Intl", "Performance", "Navigation",
  "Network", "Payment", "Presentation", "Push", "Readable", "Writable", "Transform", "Speech", "USB", "HID", "Serial", "Bluetooth",
  "Gamepad", "IDB", "File", "Blob", "Image", "Offscreen", "Path2D", "Request", "Response", "Headers", "URL", "Worker", "Shared",
  "Service", "Broadcast", "Message", "Event", "Custom", "Keyboard", "Mouse", "Pointer", "Touch", "Wheel", "Focus", "Input",
  "Composition", "Clipboard", "Drag", "Animation", "Transition", "Resize", "Intersection", "Mutation", "Report", "Storage", "Cache",
  "Crypto", "Subtle", "Credential", "Public", "Notification", "Permission", "Screen", "Visual", "Window", "Document", "Element",
  "Node", "Range", "Selection", "Shadow", "Abort", "DOM", "XML", "XPath", "Form", "Validity", "Data", "Array", "Typed", "Int", "Uint",
  "Float", "Big", "Map", "Set", "Weak", "Promise", "Proxy", "Reflect", "Symbol", "JSON", "Math", "Date", "RegExp", "Error", "Function",
  "Object", "Number", "String", "Boolean", "WebSocket", "WebTransport", "Location", "History", "Navigator", "Geolocation", "Sensor",
  "Accelerometer", "Gyroscope", "Magnetometer", "Orientation", "Ambient", "Battery", "Wake", "Lock", "Idle", "Scheduler", "Task",
  "Trusted", "Sanitizer", "Highlight", "Launch", "Cookie", "Font", "Compression", "Decompression", "Encoded", "Chunk", "Frame", "Codec",
  "webkit", "WebKit",
].join("|")})`);
// … by suffix (EvalError, PopStateEvent, …) …
const STANDARD_GLOBAL_SUFFIX = /(Error|Event|Element|List|Collection|Observer|Entry|Timing|Rule|Sheet|Declaration|Iterator|Registry|Context|Buffer|Stream)$/;
// … and by name.
const STANDARD_GLOBALS = new Set([
  "window", "self", "document", "name", "location", "customElements", "history", "navigation", "locationbar", "menubar", "personalbar",
  "scrollbars", "statusbar", "toolbar", "status", "closed", "frames", "length", "top", "opener", "parent", "frameElement", "navigator",
  "origin", "external", "screen", "innerWidth", "innerHeight", "scrollX", "pageXOffset", "scrollY", "pageYOffset", "visualViewport",
  "screenX", "screenY", "outerWidth", "outerHeight", "devicePixelRatio", "event", "clientInformation", "screenLeft", "screenTop",
  "styleMedia", "isSecureContext", "crossOriginIsolated", "performance", "crypto", "indexedDB", "sessionStorage", "localStorage",
  "scheduler", "alert", "atob", "blur", "btoa", "cancelAnimationFrame", "cancelIdleCallback", "captureEvents", "clearInterval",
  "clearTimeout", "close", "confirm", "createImageBitmap", "fetch", "fetchLater", "find", "focus", "getComputedStyle", "getSelection", "matchMedia",
  "moveBy", "moveTo", "open", "postMessage", "print", "prompt", "queueMicrotask", "releaseEvents", "reportError",
  "requestAnimationFrame", "requestIdleCallback", "resizeBy", "resizeTo", "scroll", "scrollBy", "scrollTo", "setInterval",
  "setTimeout", "stop", "structuredClone", "chrome", "caches", "cookieStore", "trustedTypes", "speechSynthesis", "globalThis",
  "Infinity", "NaN", "undefined", "eval", "isFinite", "isNaN", "parseFloat", "parseInt", "decodeURI", "decodeURIComponent", "encodeURI",
  "encodeURIComponent", "escape", "unescape", "Atomics", "WebAssembly", "console", "Option", "Audio", "Image", "Iterator", "WeakRef",
  "FinalizationRegistry", "XSLTProcessor", "VideoDecoder", "AudioDecoder", "VideoEncoder", "AudioEncoder", "VideoFrame", "AudioData",
  "ImageDecoder", "EncodedVideoChunk", "EncodedAudioChunk", "launchQueue", "sharedStorage", "documentPictureInPicture",
  "originAgentCluster", "credentialless", "onLine", "showDirectoryPicker", "showOpenFilePicker", "showSaveFilePicker",
  "getScreenDetails", "queryLocalFonts", "ai", "Translator", "LanguageDetector", "Summarizer", "Writer", "Rewriter", "LanguageModel",
  "Proofreader", "ScrollTimeline", "ViewTimeline", "ViewTransition", "CaretPosition", "CloseWatcher", "Ink", "Profiler",
  "XRSession", "Viewport", "MathMLElement", "Observable", "Subscriber", "QuotaExceededError", "Fence", "SnapEvent",
]);
// This app's own globals.
const APP_GLOBALS = new Set(["__yolo", "__yoloPlayerLog", "__yoloPlayerMetrics", "__driveInMediabunny", "__yoloPlayer"]);

// A browser's own interfaces (AnalyserNode, TreeWalker, …) are capitalized
// native functions. Their source text is read; they are not called.
const NATIVE_SOURCE = /\{\s*\[native code\]\s*\}\s*$/;

function isBuiltInInterface(win, name) {
  if (!/^[A-Z]/.test(name)) return false;
  try {
    const value = win[name];
    return typeof value === "function" && NATIVE_SOURCE.test(Function.prototype.toString.call(value));
  } catch {
    return false;
  }
}

// Window globals no ordinary browser has: an injected bridge would show here.
export function residualGlobals(win) {
  let names = [];
  try {
    names = Object.getOwnPropertyNames(win);
  } catch {
    return { count: 0, names: [] };
  }
  const residual = names.filter((name) => !name.startsWith("on")
    && !STANDARD_GLOBALS.has(name)
    && !APP_GLOBALS.has(name)
    && !STANDARD_GLOBAL_PREFIX.test(name)
    && !STANDARD_GLOBAL_SUFFIX.test(name)
    && !isBuiltInInterface(win, name)).sort();
  return { count: residual.length, names: residual.slice(0, MAX_RESIDUAL_GLOBALS) };
}

// typeof and, for objects and functions, the first own keys. Getters are
// read; nothing found is called.
function describeValue(value) {
  const type = typeof value;
  if (value === null || (type !== "object" && type !== "function")) return { type: value === null ? "null" : type };
  let keys = [];
  try {
    keys = Object.keys(value).slice(0, MAX_KEYS);
  } catch {
    // A host object that refuses enumeration.
  }
  return { type, keys };
}

function lookup(root, path) {
  let value = root;
  for (const part of path.split(".")) {
    if (value == null) return undefined;
    try {
      value = value[part];
    } catch {
      return { error: true };
    }
  }
  return value;
}

const BRIDGE_PATHS = [
  "qt", "qt.webChannelTransport", "cefQuery", "cefQueryCancel", "chrome", "chrome.webview", "chrome.runtime", "webkit",
  "webkit.messageHandlers", "tesla", "Tesla", "QtCarBrowser", "__TESLA__", "TeslaBrowser", "android", "AndroidBridge", "JSBridge",
  "jsBridge", "nativeBridge",
];

// Known names of native bridges (Qt WebChannel, CEF, WebView2, WKWebView,
// Android WebView, and Tesla's own), present or not.
export function bridgeChecks(win) {
  const out = {};
  for (const path of BRIDGE_PATHS) {
    const value = lookup(win, path);
    if (value === undefined) continue;
    out[path] = value?.error ? { type: "error" } : describeValue(value);
  }
  try {
    const external = win.external;
    if (external != null) {
      const proto = Object.getPrototypeOf(external);
      out.external = {
        type: typeof external,
        own: Object.getOwnPropertyNames(external).slice(0, MAX_KEYS),
        proto: proto && proto !== Object.prototype ? Object.getOwnPropertyNames(proto).filter((name) => name !== "constructor").slice(0, MAX_KEYS) : [],
      };
    }
  } catch {
    out.external = { type: "error" };
  }
  return out;
}

const STANDARD_NAVIGATOR = new Set([
  "constructor", "appCodeName", "appName", "appVersion", "platform", "product", "productSub", "userAgent", "vendor", "vendorSub",
  "language", "languages", "onLine", "cookieEnabled", "doNotTrack", "hardwareConcurrency", "deviceMemory", "maxTouchPoints",
  "pdfViewerEnabled", "webdriver", "userAgentData", "plugins", "mimeTypes", "javaEnabled", "connection", "geolocation",
  "mediaCapabilities", "mediaDevices", "mediaSession", "permissions", "serviceWorker", "storage", "storageBuckets", "locks", "clipboard",
  "credentials", "keyboard", "wakeLock", "usb", "hid", "serial", "bluetooth", "xr", "gpu", "ink", "virtualKeyboard", "presentation",
  "scheduling", "managed", "windowControlsOverlay", "login", "devicePosture", "protectedAudience", "userActivation", "sendBeacon",
  "vibrate", "getGamepads", "getBattery", "requestMediaKeySystemAccess", "registerProtocolHandler", "unregisterProtocolHandler",
  "share", "canShare", "getUserMedia", "webkitGetUserMedia", "webkitPersistentStorage", "webkitTemporaryStorage",
  "getInstalledRelatedApps", "requestMIDIAccess", "setAppBadge", "clearAppBadge", "contacts", "joinAdInterestGroup",
  "leaveAdInterestGroup", "runAdAuction", "updateAdInterestGroups", "clearOriginJoinedAdInterestGroups", "createAuctionNonce",
  "deprecatedReplaceInURN", "deprecatedURNToURL", "deprecatedRunAdAuctionEnforcesKAnonymity", "getInterestGroupAdAuctionData",
  "canLoadAdAuctionFencedFrame", "adAuctionComponents", "getAutoplayPolicy", "modelContext", "registerProtocolHandler",
]);

// navigator properties beyond the standard ones, own and inherited.
export function nonStandardNavigator(nav) {
  const names = new Set();
  try {
    for (let object = nav; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
      for (const name of Object.getOwnPropertyNames(object)) names.add(name);
    }
  } catch {
    return [];
  }
  return [...names].filter((name) => !STANDARD_NAVIGATOR.has(name)).sort().slice(0, 50);
}

const withTimeout = (promise) => Promise.race([
  promise,
  new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ASYNC_TIMEOUT_MS)),
]);

async function userAgentData(nav) {
  const data = nav.userAgentData;
  if (!data) return null;
  const out = { brands: (data.brands || []).map(({ brand, version }) => `${brand}/${version}`), mobile: data.mobile, platform: data.platform };
  if (typeof data.getHighEntropyValues === "function") {
    try {
      const values = await withTimeout(data.getHighEntropyValues(HIGH_ENTROPY_HINTS));
      out.highEntropy = {
        ...Object.fromEntries(HIGH_ENTROPY_HINTS.filter((hint) => hint !== "fullVersionList").map((hint) => [hint, values?.[hint]])),
        fullVersionList: (values?.fullVersionList || []).map(({ brand, version }) => `${brand}/${version}`),
        ...(values?.timedOut ? { timedOut: true } : {}),
      };
    } catch (error) {
      out.highEntropy = { error: error?.name || "failed" };
    }
  }
  return out;
}

const CODECS = {
  avc1: { mse: 'video/mp4; codecs="avc1.640028"', decoder: "video", codec: "avc1.640028" },
  hevc: { mse: 'video/mp4; codecs="hvc1.1.6.L120.90"', decoder: "video", codec: "hvc1.1.6.L120.90" },
  mp4a: { mse: 'audio/mp4; codecs="mp4a.40.2"', decoder: "audio", codec: "mp4a.40.2" },
  opus: { mse: 'audio/webm; codecs="opus"', decoder: "audio", codec: "opus" },
};

// Cheap checks only: MediaSource is synchronous, WebCodecs answers fast.
async function codecSupport(win) {
  const out = {};
  for (const [name, { mse, decoder, codec }] of Object.entries(CODECS)) {
    let mseSupported = null;
    try {
      mseSupported = typeof win.MediaSource?.isTypeSupported === "function" ? win.MediaSource.isTypeSupported(mse) : null;
    } catch {
      // Unknown.
    }
    let webcodecs = null;
    try {
      const Decoder = decoder === "video" ? win.VideoDecoder : win.AudioDecoder;
      if (typeof Decoder?.isConfigSupported === "function") {
        const config = decoder === "video" ? { codec, codedWidth: 1280, codedHeight: 720 } : { codec, sampleRate: 48_000, numberOfChannels: 2 };
        const result = await withTimeout(Decoder.isConfigSupported(config));
        webcodecs = result?.timedOut ? "timeout" : Boolean(result?.supported);
      }
    } catch {
      webcodecs = false;
    }
    out[name] = { mse: mseSupported, webcodecs };
  }
  return out;
}

function matches(win, query) {
  try {
    return win.matchMedia(query).matches;
  } catch {
    return null;
  }
}

// Everything in one object, under ENV_EVENT_MAX_BYTES: the largest optional
// parts are dropped first.
export async function collectEnvironment(win = globalThis) {
  const nav = win.navigator || {};
  const fingerprint = teslaFingerprint(readFingerprintInput(win));
  const env = {
    userAgent: nav.userAgent,
    userAgentData: await userAgentData(nav),
    screen: {
      width: win.screen?.width, height: win.screen?.height, availWidth: win.screen?.availWidth, availHeight: win.screen?.availHeight,
    },
    devicePixelRatio: win.devicePixelRatio,
    inner: { width: win.innerWidth, height: win.innerHeight },
    visualViewport: win.visualViewport
      ? { width: Math.round(win.visualViewport.width), height: Math.round(win.visualViewport.height), scale: win.visualViewport.scale }
      : null,
    media: {
      pointerCoarse: matches(win, "(pointer: coarse)"),
      hoverNone: matches(win, "(hover: none)"),
      displayModeFullscreen: matches(win, "(display-mode: fullscreen)"),
    },
    maxTouchPoints: nav.maxTouchPoints,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    language: nav.language,
    crossOriginIsolated: win.crossOriginIsolated === true,
    sharedArrayBuffer: typeof win.SharedArrayBuffer,
    codecs: await codecSupport(win),
    tesla: {
      guess: fingerprint.tesla,
      by: fingerprint.by,
      score: fingerprint.score,
      maxScore: fingerprint.maxScore,
      threshold: fingerprint.threshold,
      signals: Object.fromEntries(fingerprint.signals.map((signal) => [signal.id, signal.matched ? signal.points : 0])),
      values: Object.fromEntries(fingerprint.signals.filter((signal) => signal.value !== undefined).map((signal) => [signal.id, signal.value])),
    },
    bridges: bridgeChecks(win),
    navigatorExtras: nonStandardNavigator(nav),
    globals: residualGlobals(win),
  };
  for (const optional of ["globals", "navigatorExtras", "codecs", "bridges"]) {
    if (new TextEncoder().encode(JSON.stringify(env)).length <= ENV_EVENT_MAX_BYTES) break;
    if (optional === "globals") env.globals = { count: env.globals.count, names: env.globals.names.slice(0, 30), cut: true };
    else delete env[optional];
  }
  return env;
}

// Sends `env` on page load, then after a reconnect only when it changed.
export function createEnvironmentReporter({ record, collect = () => collectEnvironment() }) {
  let last = null;
  let running = null;
  return {
    report(reason) {
      running = (running || Promise.resolve()).then(async () => {
        const env = await collect();
        const signature = JSON.stringify(env);
        if (signature === last) return false;
        last = signature;
        record("env", { reason, ...env });
        return true;
      }).catch(() => false);
      return running;
    },
  };
}
