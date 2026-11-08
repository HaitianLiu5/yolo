import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isFinished, normalizeSource, OWNER_PROFILE, sourceKey } from "@useyolo/core";
import { silentLogger } from "./log.js";

// What Yolo finds by itself for the owner
// (Agent Note 2026-11-04-living-home-and-media-pool). The control plane sends
// a digest of each profile's recent plays and interests. From the plays, source
// plugins say what each item belongs to (`follows`); what the owner keeps
// coming back to becomes an interest, which the digest's answer proposes. On
// its own timers, one request at a time, the node reads what each interest has
// on or new (`fresh`). The rows every home draws are built from that snapshot,
// kept on disk, rebuilt from the sites when deleted. A site that fails keeps
// its last answer. What comes next in a run is Continue Watching's to show.
//
// Nothing here waits for a model or an agent, and nothing names a site.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FILE_VERSION = 1;

// What counts of a profile's plays.
const WINDOW_MS = 30 * DAY_MS;
const MAX_PLAYS = 200;
const MAX_INTERESTS = 200;
// A play counts past 20% of its length or a minute, whichever comes first,
// so a press taken back says nothing. One long or nearly whole play is enough
// to follow what it belongs to; otherwise two plays are. A team needs two
// always: the other side of the one game the owner watched is no interest.
const COUNTS_AFTER_SECONDS = 60;
const COUNTS_AFTER_SHARE = 0.2;
const STRONG_AFTER_SHARE = 0.5;
const STRONG_AFTER_SECONDS = 30 * 60;
const PLAYS_TO_FOLLOW = 2;
// How much a play weighs fades by half in this long. A live stream has no
// length to measure a share of.
const WEIGHT_HALF_LIFE_MS = 14 * DAY_MS;
const UNKNOWN_SHARE = 0.5;
// An interest with no plays left in the window, such as one an agent added.
const RESTING_WEIGHT = 0.1;

// The work of one pass, one thing at a time.
const LOOKUPS_PER_PASS = 30;
const MAX_FOLLOWS_READ = 30;
const ENTRIES_PER_FOLLOW = 40;
const PASS_EVERY_MS = 60_000;
const PACE_MS = 1_000;
// A plugin that answered this fast asked no site.
const ASKED_NOBODY_MS = 50;
const RETRY_LOOKUP_MS = 6 * HOUR_MS;

// How often a follow is read: often while something is on or about to be.
const READ_BUSY_MS = 5 * 60_000;
const READ_CHANNEL_MS = 30 * 60_000;
const READ_SCHEDULE_MS = HOUR_MS;
const BUSY_WITHIN_MS = 2 * HOUR_MS;
const READ_JITTER = 0.1;

// What the rows show.
const ROW_LIMITS = Object.freeze({ live: 12, new: 30, replays: 12 });
const LIVE_WITHIN_MS = 3 * HOUR_MS;
const TEAM_WITHIN_MS = 24 * HOUR_MS;
// A game a moment past its start that the schedule has not yet marked as played.
const LIVE_GRACE_MS = 30 * 60_000;
const NEW_WITHIN_MS = 14 * DAY_MS;
const REPLAYS_WITHIN_MS = 48 * HOUR_MS;
const FRESH_HALF_LIFE_MS = 3 * DAY_MS;
// An entry without a time: its place in the site's listing, newest first.
const UNDATED_HALF_LIFE_PLACES = 4;

const MAX_LOOKUPS_KEPT = 2000;
// The cron sends a digest twice an hour: one this old is a deleted profile's,
// or a node that was off, which asks again. What nothing follows goes too.
const DIGEST_KEPT_MS = 7 * DAY_MS;
const READ_KEPT_MS = 7 * DAY_MS;
const SAVE_AFTER_MS = 2_000;

const finished = (play) => play.watched || isFinished(play.position, play.duration);

function counts(play) {
  if (play.watched || !(play.duration > 0)) return true;
  return play.position >= Math.min(COUNTS_AFTER_SECONDS, play.duration * COUNTS_AFTER_SHARE);
}

function strong(play) {
  if (play.watched) return true;
  if (!(play.duration > 0)) return false;
  return play.position >= play.duration * STRONG_AFTER_SHARE || play.position >= STRONG_AFTER_SECONDS;
}

function share(play) {
  if (play.watched) return 1;
  return play.duration > 0 ? Math.min(1, play.position / play.duration) : UNKNOWN_SHARE;
}

function normalizePlay(raw) {
  try {
    const source = normalizeSource(raw.source);
    return {
      key: sourceKey(source),
      source,
      title: String(raw.title ?? "").slice(0, 500),
      position: Number(raw.position) > 0 ? Number(raw.position) : 0,
      duration: Number(raw.duration) > 0 ? Number(raw.duration) : null,
      at: Number(raw.at) || 0,
      watched: Boolean(raw.watched),
    };
  } catch {
    return null;
  }
}

function normalizeInterest(raw) {
  if (!raw || typeof raw.key !== "string" || !raw.key) return null;
  const follows = Array.isArray(raw.follows) ? raw.follows.filter((follow) => follow?.id && follow.plugin && follow.kind && follow.title) : [];
  return { key: raw.key, state: raw.state === "muted" ? "muted" : "active", follows };
}

// The newest plays in the window, in a whole digest's worth at most.
const normalizeDigest = (raw, now) => ({
  at: now,
  plays: (Array.isArray(raw?.plays) ? raw.plays : []).map(normalizePlay).filter((play) => play && now - play.at <= WINDOW_MS)
    .sort((left, right) => right.at - left.at).slice(0, MAX_PLAYS),
  interests: (Array.isArray(raw?.interests) ? raw.interests : []).map(normalizeInterest).filter(Boolean).slice(0, MAX_INTERESTS),
});

function loadSnapshot(path) {
  const empty = { digests: {}, lookups: {}, reads: {} };
  if (!path) return empty;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8"));
    return stored?.v === FILE_VERSION ? { ...empty, ...stored } : empty;
  } catch {
    return empty;
  }
}

function keepNewest(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  keys.sort((left, right) => (map[left].at ?? 0) - (map[right].at ?? 0));
  for (const key of keys.slice(0, keys.length - max)) delete map[key];
}

/**
 * `sources` is the source registry; `dir` where the snapshot is kept, or null
 * for memory only. The rest are for tests.
 */
export function createFeed({ sources, dir = null, logger = silentLogger, now = () => Date.now(), paceMs = PACE_MS, random = Math.random, passEveryMs = PASS_EVERY_MS }) {
  const path = dir ? resolve(dir, "feed.json") : null;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      logger.warn?.({ err: error.message }, "Feed directory unavailable");
    }
  }
  const snapshot = loadSnapshot(path);
  let saveTimer = null;
  let passTimer = null;
  let running = null;
  let again = false;

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!path) return;
    keepNewest(snapshot.lookups, MAX_LOOKUPS_KEPT);
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify({ v: FILE_VERSION, ...snapshot }));
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      logger.warn?.({ err: error.message }, "Could not keep the feed's snapshot");
    }
  }

  function save() {
    if (!path || saveTimer) return;
    saveTimer = setTimeout(saveNow, SAVE_AFTER_MS);
    saveTimer.unref?.();
  }

  // What each follow's plays add up to: how many, whether one was long or
  // nearly whole, how much they weigh, and the newest.
  function tally(digest) {
    const tallies = new Map();
    const time = now();
    for (const play of digest.plays) {
      if (!counts(play)) continue;
      const weight = share(play) * 2 ** (-(time - play.at) / WEIGHT_HALF_LIFE_MS);
      for (const follow of snapshot.lookups[play.key]?.follows ?? []) {
        const seen = tallies.get(follow.id) ?? { follow, plays: 0, strong: false, weight: 0, newest: play };
        seen.plays += 1;
        seen.strong ||= strong(play);
        seen.weight += weight;
        tallies.set(follow.id, seen);
      }
    }
    return tallies;
  }

  const qualifies = ({ follow, plays, strong: wasStrong }) => plays >= PLAYS_TO_FOLLOW || (follow.kind !== "team" && wasStrong);

  // What a profile follows now, by follow id: its active interests, and what
  // its plays would make one that the owner has not muted.
  function activeFollows(digest) {
    const tallies = tally(digest);
    const known = new Set(digest.interests.map((interest) => interest.key));
    const active = new Map();
    const add = (follow, key) => active.set(follow.id, { follow, key, weight: tallies.get(follow.id)?.weight ?? RESTING_WEIGHT });
    for (const interest of digest.interests) {
      if (interest.state === "active") for (const follow of interest.follows) add(follow, interest.key);
    }
    for (const seen of tallies.values()) {
      if (!known.has(seen.follow.id) && qualifies(seen)) add(seen.follow, seen.follow.id);
    }
    return active;
  }

  function proposals(digest) {
    const known = new Set(digest.interests.map((interest) => interest.key));
    return [...tally(digest).values()].filter((seen) => !known.has(seen.follow.id) && qualifies(seen)).map((seen) => ({
      key: seen.follow.id,
      title: seen.follow.title,
      kind: seen.follow.kind,
      follows: [seen.follow],
      why: { plays: seen.plays, title: seen.newest.title },
    }));
  }

  const digests = () => Object.values(snapshot.digests);
  const pause = (startedAt) => (now() - startedAt >= ASKED_NOBODY_MS && paceMs > 0
    ? new Promise((done) => {
      setTimeout(done, paceMs).unref?.();
    })
    : Promise.resolve());

  // What the plays that count belong to, newest first, each asked once.
  async function lookUpFollows() {
    const time = now();
    const wanted = new Map();
    for (const digest of digests()) {
      for (const play of digest.plays) {
        if (!counts(play) || !sources.canFollow(play.source)) continue;
        const known = snapshot.lookups[play.key];
        if (known && !(known.failed && time - known.at >= RETRY_LOOKUP_MS)) continue;
        wanted.set(play.key, play);
      }
    }
    for (const play of [...wanted.values()].slice(0, LOOKUPS_PER_PASS)) {
      const startedAt = now();
      try {
        snapshot.lookups[play.key] = { at: now(), follows: await sources.follows(play.source) };
      } catch (error) {
        logger.info?.({ key: play.key, err: error.message }, "Could not say what an item belongs to");
        snapshot.lookups[play.key] = { at: now(), follows: [], failed: true };
      }
      save();
      await pause(startedAt);
    }
  }

  // Something is on, or is about to be: read it again soon.
  function busy(entries) {
    const time = now();
    return entries.some((entry) => entry.live?.state === "live"
      || (entry.live?.state === "upcoming" && entry.live.startsAt && entry.live.startsAt - time <= BUSY_WITHIN_MS));
  }

  function nextRead(follow, entries) {
    const every = busy(entries) ? READ_BUSY_MS : follow.kind === "schedule" ? READ_SCHEDULE_MS : READ_CHANNEL_MS;
    return now() + every * (1 - READ_JITTER + random() * READ_JITTER * 2);
  }

  // What is read for these active follows: the most followed first.
  const toRead = (seen) => [...seen].filter(({ follow }) => follow.kind !== "team" && sources.has(follow.plugin))
    .sort((left, right) => right.weight - left.weight).slice(0, MAX_FOLLOWS_READ);

  // Each only when due. A failed read keeps what it had and says so.
  async function readFollows() {
    const followed = new Map();
    for (const digest of digests()) {
      for (const seen of activeFollows(digest).values()) {
        const known = followed.get(seen.follow.id);
        if (!known || known.weight < seen.weight) followed.set(seen.follow.id, seen);
      }
    }
    const due = toRead(followed.values()).filter(({ follow }) => !(snapshot.reads[follow.id]?.next > now()));
    for (const { follow } of due) {
      const startedAt = now();
      const read = snapshot.reads[follow.id];
      try {
        const { entries } = await sources.fresh(follow, { limit: ENTRIES_PER_FOLLOW });
        snapshot.reads[follow.id] = { at: now(), next: nextRead(follow, entries), entries };
      } catch (error) {
        logger.warn?.({ follow: follow.id, err: error.message }, "Could not read what a follow has");
        snapshot.reads[follow.id] = { at: read?.at ?? null, next: nextRead(follow, []), entries: read?.entries ?? [], error: error.message };
      }
      save();
      await pause(startedAt);
    }
  }

  function forget() {
    const time = now();
    for (const [profile, digest] of Object.entries(snapshot.digests)) {
      if (time - digest.at > DIGEST_KEPT_MS) delete snapshot.digests[profile];
    }
    const followed = new Set(digests().flatMap((digest) => [...activeFollows(digest).keys()]));
    for (const [id, read] of Object.entries(snapshot.reads)) {
      if (!followed.has(id) && time - (read.at ?? 0) > READ_KEPT_MS) delete snapshot.reads[id];
    }
  }

  async function pass() {
    forget();
    await lookUpFollows();
    await readFollows();
  }

  // One pass at a time; one asked for meanwhile runs after it.
  function work() {
    if (running) {
      again = true;
      return running;
    }
    running = pass().catch((error) => logger.warn?.({ err: error.message }, "A pass of the feed failed")).then(() => {
      running = null;
      if (!again) return undefined;
      again = false;
      return work();
    });
    return running;
  }

  function startPasses() {
    if (passTimer) return;
    passTimer = setInterval(() => void work(), passEveryMs);
    passTimer.unref?.();
  }

  function scored(digest, active) {
    const time = now();
    const best = new Map();
    for (const { follow, key, weight } of active.values()) {
      if (follow.kind === "team") continue;
      (snapshot.reads[follow.id]?.entries ?? []).forEach((entry, place) => {
        if (!sources.has(entry.source.plugin)) return;
        const teams = (entry.related ?? []).map((id) => active.get(id)).filter(Boolean).sort((left, right) => right.weight - left.weight);
        const team = teams[0] ?? null;
        const moment = entry.live?.startsAt ?? entry.at;
        const freshness = moment
          ? 2 ** (-Math.max(0, time - moment) / FRESH_HALF_LIFE_MS)
          : 2 ** (-place / UNDATED_HALF_LIFE_PLACES);
        const score = (team ? team.weight + weight : weight) * freshness;
        const known = best.get(entry.id);
        if (known && known.score >= score) return;
        const about = team ?? { follow, key };
        best.set(entry.id, { entry, score, teamWeight: team?.weight ?? 0, why: { kind: about.follow.kind, title: about.follow.title, interest: about.key } });
      });
    }
    return [...best.values()];
  }

  function present({ entry, why }) {
    const { related: _related, ...shown } = entry;
    return { ...shown, why };
  }

  // One channel does not fill a row: each interest takes a turn, the one with
  // the best entry first.
  function inTurns(items) {
    const turns = new Map();
    for (const item of items) {
      if (!turns.has(item.why.interest)) turns.set(item.why.interest, []);
      turns.get(item.why.interest).push(item);
    }
    const lines = [...turns.values()];
    const mixed = [];
    while (mixed.length < items.length) {
      for (const line of lines) if (line.length) mixed.push(line.shift());
    }
    return mixed;
  }

  function rows(profile, { limit = ROW_LIMITS.new } = {}) {
    const digest = snapshot.digests[profile];
    const time = now();
    if (!digest) return { rows: [], needsDigest: true, reading: false, generatedAt: time };
    const active = activeFollows(digest);
    const watched = new Set(digest.plays.filter(finished).map((play) => play.key));
    const entries = scored(digest, active).filter(({ entry }) => entry.live?.state === "live" || !watched.has(entry.id));
    const startsIn = ({ entry }) => (entry.live.startsAt ?? Infinity) - time;
    const live = entries.filter((item) => {
      if (item.entry.live?.state === "live") return true;
      if (item.entry.live?.state !== "upcoming") return false;
      const within = item.teamWeight ? TEAM_WITHIN_MS : LIVE_WITHIN_MS;
      return startsIn(item) <= within && startsIn(item) > -LIVE_GRACE_MS;
    }).sort((left, right) => Number(right.entry.live.state === "live") - Number(left.entry.live.state === "live")
      || right.teamWeight - left.teamWeight
      || startsIn(left) - startsIn(right));
    const inLive = new Set(live.map((item) => item.entry.id));
    const replays = entries.filter(({ entry }) => entry.live?.state === "ended" && time - (entry.live.startsAt ?? entry.at ?? 0) <= REPLAYS_WITHIN_MS)
      .sort((left, right) => right.teamWeight - left.teamWeight || (right.entry.at ?? 0) - (left.entry.at ?? 0));
    const fresh = entries.filter(({ entry }) => {
      if (inLive.has(entry.id) || entry.live?.state === "ended" || entry.live?.state === "live") return false;
      // A game too far off for the live row says nothing yet; a channel's
      // next broadcast is news.
      if (entry.live?.state === "upcoming") return !entry.matchup;
      return !entry.at || time - entry.at <= NEW_WITHIN_MS;
    }).sort((left, right) => right.score - left.score);
    const limited = (name) => Math.min(ROW_LIMITS[name], Math.max(1, Math.floor(Number(limit) || ROW_LIMITS[name])));
    const built = [
      ["live", live.slice(0, limited("live")).map(present)],
      ["new", inTurns(fresh).slice(0, limited("new")).map(present)],
      ["replays", replays.slice(0, limited("replays")).map(present)],
    ].filter(([, items]) => items.length).map(([id, items]) => ({ id, role: id, items }));
    const lookupPending = digest.plays.some((play) => counts(play) && sources.canFollow(play.source) && !snapshot.lookups[play.key]);
    const readPending = toRead(active.values()).some(({ follow }) => !snapshot.reads[follow.id]);
    return { rows: built, needsDigest: false, reading: lookupPending || readPending, generatedAt: time };
  }

  if (digests().length) startPasses();

  return {
    /** Each profile's plays and interests → the interests its plays propose, by profile. */
    digest(profiles) {
      const proposed = {};
      for (const raw of Array.isArray(profiles) ? profiles : []) {
        const profile = typeof raw?.id === "string" && raw.id ? raw.id : OWNER_PROFILE;
        snapshot.digests[profile] = normalizeDigest(raw, now());
        proposed[profile] = proposals(snapshot.digests[profile]);
      }
      save();
      startPasses();
      void work();
      return { proposed };
    },
    rows,
    /** Runs when any work now in progress has finished; for tests. */
    settled: () => running ?? Promise.resolve(),
    /** Stops the timers and writes the snapshot. */
    close() {
      clearInterval(passTimer);
      passTimer = null;
      if (saveTimer) saveNow();
    },
  };
}
