import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNER_PROFILE, YoloError } from "@useyolo/core";
import { createFakeNode, createTestControlPlane, USER } from "../helpers/fakes.js";
import { upsertDevice } from "../../src/store/devices.js";
import { createServices } from "../../src/services.js";
import { recordPlay, recordProgress } from "../../src/store/history.js";
import { feedDigestDue, listInterests } from "../../src/store/feed.js";
import { createProfile } from "../../src/store/profiles.js";

// What Yolo finds by itself, as screens get it
// (Agent Note 2026-11-04-living-home-and-media-pool): the digest the node gets,
// the interests its answer proposes, and the rows a profile sees.

const source = (id) => ({ plugin: "site", id });
const item = (id, fields = {}) => ({ id: `site:${id}`, source: source(id), title: `Item ${id}`, thumbnail: null, duration: 600, at: 1, ...fields });
const FOLLOW = { id: "site:channel:a", plugin: "site", kind: "channel", title: "Channel A" };

function feedNode({ rows = [], proposed = {}, needsDigest = false } = {}) {
  const digests = [];
  const state = { needsDigest };
  const node = createFakeNode({
    "GET /internal/v1/feed/rows": () => ({ rows, needsDigest: state.needsDigest, reading: false, generatedAt: 5 }),
    "POST /internal/v1/feed/digest": ({ profiles }) => {
      digests.push(profiles);
      state.needsDigest = false;
      return { proposed };
    },
  });
  return { node, digests };
}

test("the digest holds a profile's plays and interests; the interests its answer proposes are kept, and one already muted stays muted", async () => {
  const proposal = { key: FOLLOW.id, title: "Channel A", kind: "channel", follows: [FOLLOW], why: { plays: 2, title: "Item a" } };
  const { node, digests } = feedNode({ needsDigest: true, proposed: { [OWNER_PROFILE]: [proposal] } });
  const plane = createTestControlPlane({ node });
  await recordPlay(plane.db, USER, { source: source("a"), title: "Item a", duration: 1000, position: 0 });
  await recordProgress(plane.db, USER, "site:a", { position: 800, duration: 1000 });

  await plane.services.feedRows();
  assert.equal(digests.length, 1, "a node with no digest gets one, once");
  const [{ id, plays, interests }] = digests[0];
  assert.equal(id, OWNER_PROFILE);
  assert.deepEqual(plays.map((play) => [play.source.id, play.title, play.position, play.duration, play.watched]), [["a", "Item a", 800, 1000, false]]);
  assert.deepEqual(interests, []);
  const kept = await listInterests(plane.db, USER, OWNER_PROFILE);
  assert.deepEqual(kept.map((interest) => [interest.key, interest.state, interest.follows]), [[FOLLOW.id, "active", [FOLLOW]]]);

  assert.deepEqual(await plane.services.feedFeedback({ signal: "stop_following", interest: FOLLOW.id }), { ok: true });
  assert.equal(digests.length, 2, "the node hears a mute at once");
  assert.equal(digests[1][0].interests[0].state, "muted");
  await plane.services.sendFeedDigests();
  assert.equal((await listInterests(plane.db, USER, OWNER_PROFILE))[0].state, "muted", "proposed again, it stays muted");
  await assert.rejects(plane.services.feedFeedback({ signal: "stop_following", interest: "site:channel:none" }), /No such interest/);
});

test("stopping an interest the node found since the last digest keeps it, muted", async () => {
  const proposal = { key: FOLLOW.id, title: "Channel A", kind: "channel", follows: [FOLLOW] };
  const { node } = feedNode({ proposed: { [OWNER_PROFILE]: [proposal] } });
  const plane = createTestControlPlane({ node });
  await plane.services.feedFeedback({ signal: "stop_following", interest: FOLLOW.id });
  assert.deepEqual((await listInterests(plane.db, USER, OWNER_PROFILE)).map((interest) => [interest.key, interest.state]), [[FOLLOW.id, "muted"]]);
});

test("rows carry the profile's progress and drop what it watched or dismissed, keeping a game being played", async () => {
  const rows = [
    { id: "live", role: "live", items: [item("game", { live: { state: "live" } })] },
    { id: "new", role: "new", items: [item("fresh"), item("seen"), item("half"), item("no")] },
    { id: "replays", role: "replays", items: [item("over", { live: { state: "ended" } })] },
  ];
  const { node } = feedNode({ rows });
  const plane = createTestControlPlane({ node });
  for (const [id, position] of [["game", 600], ["seen", 600], ["half", 300], ["over", 600]]) {
    await recordPlay(plane.db, USER, { source: source(id), title: id, duration: 600, position });
    await recordProgress(plane.db, USER, `site:${id}`, { position, duration: 600 });
  }
  await plane.services.feedFeedback({ signal: "not_interested", source: source("no") });

  const answer = await plane.services.feedRows({ limit: 20 });
  assert.equal(answer.available, true);
  assert.deepEqual(answer.rows.map((row) => [row.id, row.items.map((entry) => entry.id)]), [["live", ["site:game"]], ["new", ["site:fresh", "site:half"]]]);
  assert.equal(answer.rows[1].items[1].resumeAt, 300);
  assert.equal(node.calls.find((call) => call.path === "/internal/v1/feed/rows").query.limit, 20);
});

test("each screen sees its own profile's rows and interests", async () => {
  const proposal = { key: FOLLOW.id, title: "Channel A", kind: "channel", follows: [FOLLOW] };
  const { node, digests } = feedNode({ needsDigest: true, proposed: { placeholder: [] } });
  const plane = createTestControlPlane({ node });
  const family = await createProfile(plane.db, USER, { name: "Family" });
  const tv = await upsertDevice(plane.db, USER, { name: "TV", kind: "tv", capabilities: {} });
  await plane.db.prepare("UPDATE devices SET profile_id = ? WHERE id = ?").bind(family.id, tv.id).run();
  await recordPlay(plane.db, USER, { source: source("owners"), title: "The owner's", duration: 600, position: 300 });
  const onTv = createServices({ db: plane.db, userId: USER, hub: plane.hub, node, requester: tv.id });

  await onTv.feedRows();
  assert.equal(node.calls.at(-1).query.profile, family.id);
  assert.deepEqual(digests[0].map((profile) => [profile.id, profile.plays.length]), [[family.id, 0]]);
  await onTv.feedFeedback({ signal: "not_interested", source: source("x") });
  assert.equal((await plane.services.feedRows()).rows.length, 0);
  node.routes["POST /internal/v1/feed/digest"] = ({ profiles }) => ({ proposed: Object.fromEntries(profiles.map((profile) => [profile.id, profile.id === family.id ? [proposal] : []])) });
  await plane.services.sendFeedDigests();
  assert.equal((await listInterests(plane.db, USER, OWNER_PROFILE)).length, 0);
  assert.equal((await listInterests(plane.db, USER, family.id)).length, 1);
});

test("an older node has no rows, and an offline one says so", async () => {
  const plane = createTestControlPlane({ node: createFakeNode({}) });
  assert.deepEqual(await plane.services.feedRows(), { available: false, rows: [], reading: false });
  plane.node.offline = true;
  await assert.rejects(plane.services.feedRows(), (error) => error instanceof YoloError && error.code === "node_offline");
});

test("feedback must say what it means", async () => {
  const plane = createTestControlPlane({ node: createFakeNode({}) });
  await assert.rejects(plane.services.feedFeedback({ signal: "maybe" }), /signal must be/);
  await assert.rejects(plane.services.feedFeedback({ signal: "stop_following" }), /interest is required/);
});

test("the five-minute cron sends digests twice an hour", () => {
  assert.equal(feedDigestDue(Date.parse("2026-11-05T04:00:00Z")), true);
  assert.equal(feedDigestDue(Date.parse("2026-11-05T04:30:00Z")), true);
  assert.equal(feedDigestDue(Date.parse("2026-11-05T04:05:00Z")), false);
});
