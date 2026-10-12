// Display size, applied before the page's first layout (a classic script in
// <head>; src/display-scale.js does the rest once the app runs).
//
// Since Tesla software 2026.26 the browser renders at devicePixelRatio 1.53:
// a 773x601 CSS viewport on about 1183 physical pixels across. A display
// scale s shows the page at s physical pixels per CSS pixel by setting
// <meta name="viewport" content="width=N">, N = round(physical width / s).
// The physical size is measured here, before anything changes it, and kept
// in window.__yoloDisplayBoot: after the meta applies, innerWidth (and
// perhaps devicePixelRatio) no longer say what the screen is.
//
// The scale comes from ?scale=<number|native> (for testing, not saved),
// else the owner's choice (localStorage "yolo.displayScale"), else the
// default the app chose last time for this device ("yolo.displayScaleAuto").
(function () {
  var win = window;
  var dpr = Number(win.devicePixelRatio) || 1;
  var boot = {
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    devicePixelRatio: dpr,
    physicalWidth: Math.round(win.innerWidth * dpr),
    physicalHeight: Math.round(win.innerHeight * dpr),
    scale: null,
    width: null,
    source: "native",
  };
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
  if (query === "native" || scaleOf(query)) {
    choice = query;
    source = "query";
  } else if (stored("yolo.displayScale")) {
    choice = stored("yolo.displayScale");
    source = "owner";
  } else if (stored("yolo.displayScaleAuto")) {
    choice = stored("yolo.displayScaleAuto");
    source = "default";
  }
  var scale = scaleOf(choice);
  boot.source = source;
  // The browser's own scale needs no change.
  if (!scale || Math.abs(scale - dpr) < 0.005 || !boot.physicalWidth) return;
  var width = Math.round(boot.physicalWidth / scale);
  var meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute("content", "width=" + width);
  boot.scale = scale;
  boot.width = width;
})();
