// What this screen showed last (Agent Note 2026-10-11-yolo-web-client): its
// home rows, the Hub's state for the now-playing bar, and Yolo's devices,
// kept in localStorage for the paired device, so the next start shows them
// at once while the realtime channel connects. It is for showing only:
// everything that decides (where a tap plays, what a returning page
// resumes, a kept player, missed commands) waits for the welcome, and what
// Yolo sends then replaces it. index.html's first script reads the same
// key, to start without the launch mark when there is something to show.

const PREFIX = "yolo.home.";
const VERSION = 1;
// A row as the home screen shows it; the API's own limit for a library.
const MAX_ITEMS = 200;
// Kept well inside the browser's storage for this origin (about 5 MB).
const MAX_BYTES = 1_500_000;
const WRITE_AFTER_MS = 1_000;
const ROWS = ["queue", "playlists", "history", "movies", "shows"];

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const keyFor = (deviceId) => `${PREFIX}${deviceId}`;

// What a start shows of the Hub's state: what plays, where, and how. A
// change of position alone (every report while playing) waits for the
// next write, or the page going away, instead of writing on its own: the
// car decodes on the thread that would write.
const hubShape = (hub) => (hub ? JSON.stringify([
  hub.deviceId, hub.sessionId, hub.status, hub.leftAt, hub.kept, hub.interruptedAt, hub.item?.source, hub.item?.title, hub.item?.thumbnail,
]) : null);

function valid(record) {
  return Boolean(record) && typeof record === "object" && record.v === VERSION && record.rows && typeof record.rows === "object";
}

/** Every device's record goes: this screen was unpaired or forgotten. */
export function forgetHomeCaches() {
  const store = storage();
  if (!store) return;
  try {
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX)) store.removeItem(key);
    }
  } catch {
    // Private mode: nothing was kept.
  }
}

/**
 * The record of `deviceId` (the device credential's): `read()` gives what
 * the last page kept, `remember(patch)` replaces its parts (`rows.<name>`,
 * `hub`, `devices`) and writes a moment later, `flush()` writes now.
 * Without a device id nothing is read or kept.
 */
export function createHomeCache(deviceId) {
  let record = null;
  let timer = null;

  function read() {
    const store = storage();
    if (!deviceId || !store) return null;
    try {
      const value = JSON.parse(store.getItem(keyFor(deviceId)) || "null");
      return valid(value) ? value : null;
    } catch {
      return null;
    }
  }

  function write() {
    clearTimeout(timer);
    timer = null;
    const store = storage();
    if (!record || !store) return;
    record.savedAt = Date.now();
    // Library rows go first when the record grows too big, then everything
    // but the Hub's state: what is playing matters most on the next start.
    const attempts = [
      record,
      { ...record, rows: { ...record.rows, movies: null, shows: null } },
      { ...record, rows: {} },
    ];
    for (const attempt of attempts) {
      try {
        const text = JSON.stringify(attempt);
        if (text.length > MAX_BYTES) continue;
        store.setItem(keyFor(deviceId), text);
        // One record: an older pairing's goes.
        for (let index = store.length - 1; index >= 0; index -= 1) {
          const key = store.key(index);
          if (key?.startsWith(PREFIX) && key !== keyFor(deviceId)) store.removeItem(key);
        }
        return;
      } catch {
        // Over the quota: try smaller.
      }
    }
  }

  return {
    read() {
      record ??= read();
      return record;
    },
    remember(patch) {
      if (!deviceId) return;
      record ??= read() ?? { v: VERSION, rows: {}, hub: null, devices: null, savedAt: 0 };
      const rows = { ...record.rows };
      for (const name of ROWS) {
        if (!(name in (patch.rows || {}))) continue;
        const items = patch.rows[name];
        rows[name] = Array.isArray(items) ? items.slice(0, MAX_ITEMS) : null;
      }
      const quiet = Object.keys(patch).length === 1 && "hub" in patch && hubShape(patch.hub) === hubShape(record.hub);
      record = { ...record, rows };
      if ("hub" in patch) record.hub = patch.hub ?? null;
      if ("devices" in patch) record.devices = Array.isArray(patch.devices) ? patch.devices : null;
      if (!quiet) timer ??= setTimeout(write, WRITE_AFTER_MS);
    },
    flush: write,
  };
}
