// Display size, applied before the page's first layout (a classic script in
// <head>; src/display-scale.js does the rest once the app runs).
//
// Since Tesla software 2026.26 the browser renders at devicePixelRatio 1.53:
// a 773x601 CSS viewport on about 1183x920 physical pixels. A display scale
// s shows the page at s physical pixels per CSS pixel by setting CSS `zoom`
// on the root element to s / devicePixelRatio (the car's Chrome ignores
// <meta name="viewport">). Zoom changes neither innerWidth nor
// devicePixelRatio; window.__yoloDisplayBoot keeps what was applied.
//
// The scale comes from ?scale=<number|native> (for testing, not saved),
// else the owner's choice (localStorage "yolo.displayScale"), else the
// default the app chose last time for this device ("yolo.displayScaleAuto").
// Only a device that offers display sizes (the car: the app stores a number
// as its default) applies the choice or the default; elsewhere the app
// stores "native" and the browser keeps its own scale.
(function () {
  var win = window;
  var dpr = Number(win.devicePixelRatio) || 1;
  var boot = { devicePixelRatio: dpr, scale: null, zoom: 1, width: null, source: "native" };
  win.__yoloDisplayBoot = boot;

  function stored(key) {
    try {
      return win.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }
  function scaleOf(value) {
    var number = Number(value);
    return value != null && value !== "" && number >= 0.75 && number <= 3 ? number : null;
  }

  var query = null;
  try {
    query = new URLSearchParams(win.location.search).get("scale");
  } catch (error) {
    query = null;
  }
  var choice = null;
  var source = "native";
  var auto = stored("yolo.displayScaleAuto");
  var offered = scaleOf(auto) !== null;
  if (query === "native" || scaleOf(query)) {
    choice = query;
    source = "query";
  } else if (offered && stored("yolo.displayScale")) {
    choice = stored("yolo.displayScale");
    source = "owner";
  } else if (offered) {
    choice = auto;
    source = "default";
  }
  var scale = scaleOf(choice);
  boot.source = source;
  // The browser's own scale needs no change.
  if (!scale || Math.abs(scale - dpr) < 0.005) return;
  var zoom = Math.round((scale / dpr) * 10000) / 10000;
  document.documentElement.style.setProperty("zoom", String(zoom));
  boot.scale = scale;
  boot.zoom = zoom;
  boot.width = Math.round(win.innerWidth / zoom);
})();
