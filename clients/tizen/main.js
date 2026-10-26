// The Tizen app hosts the player Yolo serves at its site root: it asks the
// TV for the remote's media keys, which only an installed app's own page can,
// then hands the whole window to the player. The app's default CSP allows
// only its own files, so nothing here is inline; origin.js, written by
// build.js, names the instance.
(function () {
  var MEDIA_KEYS = ["MediaPlay", "MediaPause", "MediaPlayPause", "MediaStop", "MediaFastForward", "MediaRewind", "MediaTrackNext", "MediaTrackPrevious"];
  try {
    if (window.tizen && tizen.tvinputdevice) tizen.tvinputdevice.registerKeyBatch(MEDIA_KEYS);
  } catch (error) {
    console.warn("media keys", error);
  }
  location.replace(window.YOLO_ORIGIN + "/");
})();
