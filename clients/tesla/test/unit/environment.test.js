import assert from "node:assert/strict";
import test from "node:test";
import {
  bridgeChecks, collectEnvironment, createEnvironmentReporter, ENV_EVENT_MAX_BYTES, nonStandardNavigator, residualGlobals,
} from "../../src/telemetry/environment.js";

const trap = () => {
  throw new Error("a probed function was called");
};

// A window shaped like the car's: Chromium 148 on Linux, Tesla 2026.26
// measurements, and a few globals no ordinary browser has.
function carWindow(extraGlobals = {}) {
  class NavigatorProto {}
  Object.defineProperty(NavigatorProto.prototype, "teslaVersion", { get: () => "2026.26", enumerable: true });
  const navigator = Object.assign(Object.create(NavigatorProto.prototype), {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    language: "en-US",
    maxTouchPoints: 10,
    hardwareConcurrency: 4,
    userAgentData: {
      brands: [{ brand: "Chromium", version: "148" }],
      mobile: false,
      platform: "Linux",
      getHighEntropyValues: async () => ({ platformVersion: "6.1", architecture: "x86", bitness: "64", model: "", wow64: false, formFactors: ["Automotive"], fullVersionList: [{ brand: "Chromium", version: "148.0.1.2" }] }),
    },
  });
  class ExternalProto {
    AddSearchProvider() {}
  }
  return {
    navigator,
    devicePixelRatio: 1.53,
    innerWidth: 773,
    innerHeight: 601,
    screen: { width: 1254, height: 784, availWidth: 1254, availHeight: 784 },
    visualViewport: { width: 773, height: 601, scale: 1 },
    matchMedia: (query) => ({ matches: query === "(pointer: coarse)" }),
    crossOriginIsolated: true,
    SharedArrayBuffer: class {},
    MediaSource: { isTypeSupported: (type) => !type.includes("hvc1") },
    VideoDecoder: { isConfigSupported: async (config) => ({ supported: config.codec.startsWith("avc1") }) },
    AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
    external: new ExternalProto(),
    fetch: trap,
    HTMLDivElement: class {},
    EvalError,
    onload: null,
    webkitURL: class {},
    __yolo: {},
    qt: { webChannelTransport: { send: trap, onmessage: null } },
    cefQuery: trap,
    chrome: { webview: { postMessage: trap } },
    ...extraGlobals,
  };
}

test("the bridge probe reports names, types and keys, and calls nothing", () => {
  // AnalyserNode stands for the browser's own interfaces (native code);
  // QWebChannel for a script-defined bridge class.
  const win = carWindow({ TeslaCarBridge: { getVin: trap }, AnalyserNode: Math.max, QWebChannel: class {} });
  assert.deepEqual(residualGlobals(win), { count: 4, names: ["QWebChannel", "TeslaCarBridge", "cefQuery", "qt"] });
  const bridges = bridgeChecks(win);
  assert.deepEqual(bridges.qt, { type: "object", keys: ["webChannelTransport"] });
  assert.deepEqual(bridges["qt.webChannelTransport"], { type: "object", keys: ["send", "onmessage"] });
  assert.deepEqual(bridges.cefQuery, { type: "function", keys: [] });
  assert.deepEqual(bridges["chrome.webview"], { type: "object", keys: ["postMessage"] });
  assert.equal(bridges.tesla, undefined, "absent names are left out");
  assert.deepEqual(bridges.external, { type: "object", own: [], proto: ["AddSearchProvider"] });
  assert.deepEqual(nonStandardNavigator(win.navigator), ["teslaVersion"]);
});

test("env describes the browser in under 8 KiB, with the Tesla score", async () => {
  const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`injectedGlobalNumber${i}`, i]));
  const env = await collectEnvironment(carWindow(many));
  assert.ok(new TextEncoder().encode(JSON.stringify(env)).length <= ENV_EVENT_MAX_BYTES);
  assert.equal(env.userAgentData.platform, "Linux");
  assert.deepEqual(env.userAgentData.highEntropy.formFactors, ["Automotive"]);
  assert.deepEqual(env.userAgentData.highEntropy.fullVersionList, ["Chromium/148.0.1.2"]);
  assert.deepEqual(env.media, { pointerCoarse: true, hoverNone: false, displayModeFullscreen: false });
  assert.deepEqual(env.codecs.avc1, { mse: true, webcodecs: true });
  assert.deepEqual(env.codecs.hevc, { mse: false, webcodecs: false });
  assert.deepEqual([env.tesla.guess, env.tesla.by, env.tesla.score, env.tesla.maxScore], [true, "score", 14, 14]);
  assert.equal(env.tesla.signals.dpr, 2);
  assert.equal(env.globals.count, 402);
  assert.ok(env.globals.names.length <= 100);
});

test("env goes out on page load, and after a reconnect only when it changed", async () => {
  const recorded = [];
  let width = 773;
  const reporter = createEnvironmentReporter({ record: (type, fields) => recorded.push([type, fields.reason, fields.width]), collect: async () => ({ width }) });
  await reporter.report("page_load");
  await reporter.report("reconnect");
  width = 1254;
  await reporter.report("reconnect");
  assert.deepEqual(recorded, [["env", "page_load", 773], ["env", "reconnect", 1254]]);
});
