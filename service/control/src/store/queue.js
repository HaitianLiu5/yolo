import { newId, YoloError } from "@useyolo/core";
import { itemColumns, itemFromRow } from "./rows.js";

// Spotify-style queue, one per screen (Agent Note 2026-10-31-screen-sessions):
// `deviceId` names the screen whose queue it is. Positions are REAL so "play
// next" can go before the head without renumbering. `device_id IS ?` also
// matches the rows the previous release wrote without one, which the Hub
// gives a screen when it first loads (HubCore.migrateStorage()).

export async function listQueue(db, userId, deviceId) {
  const { results } = await db.prepare(
    "SELECT * FROM queue_items WHERE user_id = ? AND device_id IS ? ORDER BY position ASC, added_at ASC",
  ).bind(userId, deviceId ?? null).all();
  return results.map(itemFromRow);
}

async function getQueueItem(db, userId, deviceId, id) {
  return itemFromRow(await db.prepare("SELECT * FROM queue_items WHERE user_id = ? AND device_id IS ? AND id = ?").bind(userId, deviceId ?? null, id).first());
}

async function edgePosition(db, userId, deviceId, where) {
  const row = await db.prepare(
    "SELECT MIN(position) AS head, MAX(position) AS tail FROM queue_items WHERE user_id = ? AND device_id IS ?",
  ).bind(userId, deviceId ?? null).first();
  if (where === "next") return Number.isFinite(row?.head) ? row.head - 1 : 1;
  return Number.isFinite(row?.tail) ? row.tail + 1 : 1;
}

export async function addQueueItems(db, userId, deviceId, inputs, { position = "end" } = {}) {
  if (!["next", "end"].includes(position)) throw new YoloError("invalid_request", "position must be next or end");
  const now = Date.now();
  // "next" inserts the batch before the head in its original order.
  const step = position === "next" ? -1 : 1;
  const ordered = (position === "next" ? [...inputs].reverse() : inputs).map((input) => ({ id: newId("itm"), columns: itemColumns(input) }));
  let base = await edgePosition(db, userId, deviceId, position);
  const items = [];
  const statements = ordered.map(({ id, columns }) => {
    items.push({ id, ...columns, added_at: now });
    const statement = db.prepare(`
      INSERT INTO queue_items (id, user_id, source, title, thumbnail, duration, metadata, position, added_at, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, userId, columns.source, columns.title, columns.thumbnail, columns.duration, columns.metadata, base, now, deviceId ?? null);
    base += step;
    return statement;
  });
  if (statements.length) await db.batch(statements);
  const added = items.map(itemFromRow);
  return position === "next" ? added.reverse() : added;
}

export async function removeQueueItem(db, userId, deviceId, id) {
  const item = await getQueueItem(db, userId, deviceId, id);
  if (!item) throw new YoloError("not_found", `Queue item ${id} not found`);
  await db.prepare("DELETE FROM queue_items WHERE user_id = ? AND id = ?").bind(userId, id).run();
  return item;
}

export async function clearQueue(db, userId, deviceId) {
  const result = await db.prepare("DELETE FROM queue_items WHERE user_id = ? AND device_id IS ?").bind(userId, deviceId ?? null).run();
  return result.meta?.changes ?? 0;
}

export async function reorderQueue(db, userId, deviceId, ids) {
  const current = await listQueue(db, userId, deviceId);
  const known = new Set(current.map((item) => item.id));
  if (!Array.isArray(ids) || ids.some((id) => !known.has(id))) {
    throw new YoloError("invalid_request", "ids must be existing queue item ids");
  }
  // Items not mentioned keep their relative order after the listed ones.
  const order = [...new Set(ids), ...current.map((item) => item.id).filter((id) => !ids.includes(id))];
  await db.batch(order.map((id, index) => (
    db.prepare("UPDATE queue_items SET position = ? WHERE user_id = ? AND id = ?").bind(index + 1, userId, id)
  )));
  return listQueue(db, userId, deviceId);
}

// Remove and return the head, or a specific item.
export async function shiftQueue(db, userId, deviceId, id = null) {
  const item = id ? await getQueueItem(db, userId, deviceId, id) : (await listQueue(db, userId, deviceId))[0];
  if (!item) return null;
  await db.prepare("DELETE FROM queue_items WHERE user_id = ? AND id = ?").bind(userId, item.id).run();
  return item;
}

// A takeover: `from`'s queue moves ahead of `to`'s, in its order. → how
// many moved.
export async function moveQueue(db, userId, from, to) {
  const moving = await listQueue(db, userId, from);
  if (!moving.length || from === to) return 0;
  const head = await edgePosition(db, userId, to, "next");
  const start = head - moving.length + 1;
  await db.batch(moving.map((item, index) => (
    db.prepare("UPDATE queue_items SET device_id = ?, position = ? WHERE user_id = ? AND id = ?").bind(to, start + index, userId, item.id)
  )));
  return moving.length;
}

// Rows the previous release wrote, with no screen, become `deviceId`'s.
export async function adoptQueue(db, userId, deviceId) {
  const result = await db.prepare("UPDATE queue_items SET device_id = ? WHERE user_id = ? AND device_id IS NULL").bind(deviceId, userId).run();
  return result.meta?.changes ?? 0;
}

// A removed screen's queue goes with its session.
export async function dropQueue(db, userId, deviceId) {
  await db.prepare("DELETE FROM queue_items WHERE user_id = ? AND device_id = ?").bind(userId, deviceId).run();
}
