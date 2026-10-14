import assert from "node:assert/strict";
import test from "node:test";
import { createKeptPlayer, KEPT_CHECK_AFTER_MS, keptReleaseReason, planReopen, probeStreamSession, reopenPlan } from "../../src/kept-player.js";

// The player kept behind the home screen after Back
// (Agent Note 2026-10-11-yolo-owns-progress-and-resume).

const hub = (fields = {}) => ({
  status: "paused", deviceId: "dev_car", sessionId: "ses_kept", item: { title: "Movie", source: { plugin: "library", id: "42" } }, leftAt: 1, kept: true, ...fields,
});
const state = (fields) => ({ type: "state", hub: hub(fields), self: "dev_car" });

// A fake clock and a kept player whose reports and disposals are recorded.
function keeper() {
  const clock = { at: 1_000_000 };
  const reports = [];
  const disposed = [];
  const kept = createKeptPlayer({
    now: () => clock.at,
    report: (record, { keep }) => reports.push({ sessionId: record.sessionId, position: record.position, keep }),
    dispose: (record, reason) => disposed.push({ player: record.player, reason }),
  });
  return { clock, reports, disposed, kept };
}
const entry = (fields = {}) => ({ player: { id: "engine" }, sessionId: "ses_kept", position: 312.4, duration: 600, network: "lan", ...fields });

test("the kept player stays until another stream, a stop, a move, or the page going away releases it", () => {
  const { clock, reports, disposed, kept } = keeper();
  kept.keep(entry());
  assert.deepEqual(reports, [{ sessionId: "ses_kept", position: 312.4, keep: true }], "Back says idle with keep: the node's session goes on");

  // Nothing releases it with time, memory, a pause, a seek, tracks, or danmaku,
  // nor a state that still has it here: one video plays at a time.
  clock.at += 30 * 24 * 60 * 60_000;
  for (const event of [state(), state({ leftAt: undefined }), state({ position: 500 }), { type: "pause" }, { type: "seek" }, { type: "tracks" }, { type: "danmaku" }, { type: "memory" }]) {
    assert.equal(kept.note(event), null, JSON.stringify(event));
  }
  kept.remind();
  assert.equal(kept.current?.sessionId, "ses_kept");
  assert.deepEqual(disposed, []);

  // Each rule releases it once and disposes the engine. Yolo's Hub replaced
  // or stopped the session for the first three; only a page going away says
  // so, so the Hub stops the node's session.
  for (const [event, reason, told] of [
    [{ type: "load" }, "another_stream", false],
    [{ type: "stop" }, "stopped", false],
    [{ type: "deactivate" }, "moved", false],
    [{ type: "unload" }, "unload", true],
  ]) {
    kept.keep(entry());
    reports.length = 0;
    disposed.length = 0;
    assert.equal(kept.note(event), reason);
    assert.equal(kept.current, null);
    assert.deepEqual(disposed, [{ player: { id: "engine" }, reason }]);
    assert.deepEqual(reports, told ? [{ sessionId: "ses_kept", position: 312.4, keep: false }] : [], reason);
    assert.equal(kept.note(event), null, "nothing left to release");
  }

  // The Hub's state says so too, also after this screen was away (a
  // welcome): another item here, playback on another screen, or none.
  for (const [event, reason] of [
    [state({ sessionId: "ses_next" }), "another_stream"],
    [state({ deviceId: "dev_browser" }), "moved"],
    [state({ item: null, sessionId: null, status: "idle" }), "stopped"],
    [{ type: "state", hub: null, self: "dev_car" }, "stopped"],
  ]) {
    kept.keep(entry());
    reports.length = 0;
    assert.equal(kept.note(event), reason, JSON.stringify(event));
    assert.deepEqual(reports, [], "never an answer to a broadcast");
  }

  // Shown again, the caller takes it: nothing is disposed or reported.
  kept.keep(entry());
  disposed.length = 0;
  reports.length = 0;
  assert.equal(kept.take().sessionId, "ses_kept");
  assert.deepEqual([kept.current, disposed, reports], [null, [], []]);
  assert.equal(keptReleaseReason(null, { type: "stop" }), null);
});

test("shown again after the session expired while hidden, the player recovers at the same position", async () => {
  const { clock, kept } = keeper();
  const record = kept.keep(entry());
  const probes = [];
  const probe = (answer) => async () => {
    probes.push(clock.at);
    return answer;
  };
  const plan = (answer, path = "lan") => planReopen(kept.current, { now: clock.at, path, probe: probe(answer) });

  // Back a moment ago: in place at once, without asking the node.
  clock.at += KEPT_CHECK_AFTER_MS - 1;
  assert.deepEqual(reopenPlan(record, { now: clock.at, path: "lan" }), { action: "resume", startTime: 312.4 });
  assert.deepEqual(await plan("expired"), { action: "resume", startTime: 312.4 });
  assert.equal(probes.length, 0);

  // Hidden longer: the node is asked first, and a stream it still serves (or
  // one it could not be asked about) goes on in place.
  clock.at += 1;
  assert.equal(reopenPlan(record, { now: clock.at, path: "lan" }).action, "check");
  assert.deepEqual(await plan("alive"), { action: "resume", startTime: 312.4 });
  assert.deepEqual(await plan("unknown"), { action: "resume", startTime: 312.4 });

  // Plex dropped the transcode, or the node its session, while the car
  // slept: a new stream through the recovery path, where it was left.
  clock.at += 6 * 60 * 60_000;
  assert.deepEqual(await plan("expired"), { action: "rebuild", startTime: 312.4, why: "session_expired" });
  assert.equal(probes.length, 3);

  // An agent's seek while it was hidden moves where it goes on.
  kept.seek(90);
  assert.deepEqual(await plan("expired"), { action: "rebuild", startTime: 90, why: "session_expired" });
  kept.seek(9_999);
  assert.equal(kept.current.seekTo, 600, "not past the end");
  kept.seek(90);

  // The engine failed while hidden: rebuilt, without asking.
  const failed = createKeptPlayer({ report() {}, dispose() {} });
  const engine = { id: "engine" };
  failed.keep(entry({ player: engine }));
  failed.fail({ id: "another" }, new Error("ignored"));
  assert.equal(failed.current.failed, null);
  failed.fail(engine, new Error("decode"));
  assert.deepEqual(reopenPlan(failed.current, { now: Date.now(), path: "lan" }), { action: "rebuild", startTime: 312.4, why: "failed" });

  // The screen left the home network meanwhile: the LAN stream would not
  // answer, so a new stream comes by the path it takes now. A relayed
  // stream, or a screen with no path found yet, goes on as it is.
  clock.at = record.keptAt + 1_000;
  assert.deepEqual(reopenPlan(record, { now: clock.at, path: "wan" }), { action: "rebuild", startTime: 90, why: "path" });
  assert.deepEqual(reopenPlan({ ...record, network: "relay" }, { now: clock.at, path: "lan" }), { action: "resume", startTime: 90 });
  assert.deepEqual(reopenPlan(record, { now: clock.at, path: null }), { action: "resume", startTime: 90 });
});

test("the node's answer about a kept stream: 410 on the stream or its first variant is expired", async () => {
  const fetchFrom = (routes) => async (url, init) => {
    const answer = routes[`${init.method} ${url}`];
    if (answer instanceof Error) throw answer;
    return new Response(answer?.body ?? null, { status: answer?.status ?? 404 });
  };
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nv0/index.m3u8\n";
  const url = "https://lan.example/m/tok/hls/master.m3u8";
  const variant = "https://lan.example/m/tok/hls/v0/index.m3u8";

  assert.equal(await probeStreamSession(url, { fetchFn: fetchFrom({ [`GET ${url}`]: { status: 200, body: master }, [`HEAD ${variant}`]: { status: 200 } }) }), "alive");
  assert.equal(await probeStreamSession(url, { fetchFn: fetchFrom({ [`GET ${url}`]: { status: 200, body: master }, [`HEAD ${variant}`]: { status: 410 } }) }), "expired", "the source dropped its transcode");
  assert.equal(await probeStreamSession(url, { fetchFn: fetchFrom({ [`GET ${url}`]: { status: 410 } }) }), "expired", "the node ended the session");
  assert.equal(await probeStreamSession(url, { fetchFn: fetchFrom({ [`GET ${url}`]: new TypeError("offline") }) }), "unknown");
  const file = "https://lan.example/m/tok/f/0";
  assert.equal(await probeStreamSession(file, { fetchFn: fetchFrom({ [`HEAD ${file}`]: { status: 200 } }) }), "alive");
  assert.equal(await probeStreamSession(file, { fetchFn: fetchFrom({ [`HEAD ${file}`]: { status: 410 } }) }), "expired");
});
