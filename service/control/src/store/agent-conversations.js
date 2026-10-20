import { newId } from "@useyolo/core";
import { parseJson } from "./rows.js";

// Conversations with the owner's agent (Agent Note
// 2026-10-18-agent-from-the-screen): the questions and answers a screen
// shows, never the agent's tool results or reasoning.

export const CONVERSATION_LIMIT = 500;
export const CONVERSATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const TITLE_LENGTH = 80;
export const MAX_ANSWER_TEXT = 4000;
export const MAX_STEPS = 20;
const STEP_LENGTH = 120;

function conversationFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id ?? null,
    deviceId: row.device_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromRow(row) {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    ...(row.role === "agent" ? { steps: parseJson(row.steps, []), status: row.status } : {}),
    createdAt: row.created_at,
  };
}

// A new conversation, titled by its first question. Creating one keeps the
// owner's newest CONVERSATION_LIMIT and drops those idle past the retention.
export async function createConversation(db, userId, { title, deviceId = null, now = Date.now() }) {
  const id = newId("cnv");
  await db.batch([
    db.prepare(`
      INSERT INTO agent_conversations (id, user_id, title, device_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, userId, String(title).slice(0, TITLE_LENGTH), deviceId, now, now),
    db.prepare("DELETE FROM agent_conversations WHERE user_id = ? AND updated_at < ?")
      .bind(userId, now - CONVERSATION_RETENTION_MS),
    db.prepare(`
      DELETE FROM agent_conversations WHERE user_id = ? AND id NOT IN (
        SELECT id FROM agent_conversations WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?
      )
    `).bind(userId, userId, CONVERSATION_LIMIT),
  ]);
  return { id, title: String(title).slice(0, TITLE_LENGTH), agentId: null, deviceId, createdAt: now, updatedAt: now };
}

// The conversation with its CLI session, or null.
export async function getConversation(db, userId, id) {
  const row = await db.prepare("SELECT * FROM agent_conversations WHERE user_id = ? AND id = ?").bind(userId, id).first();
  return row ? { ...conversationFromRow(row), agentSession: row.agent_session ?? null } : null;
}

export async function listConversations(db, userId, { limit = 50 } = {}) {
  const capped = Math.max(1, Math.min(CONVERSATION_LIMIT, Math.floor(Number(limit) || 50)));
  const { results } = await db.prepare(`
    SELECT * FROM agent_conversations WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?
  `).bind(userId, capped).all();
  return results.map(conversationFromRow);
}

export async function listMessages(db, userId, conversationId) {
  const { results } = await db.prepare(`
    SELECT * FROM agent_messages WHERE user_id = ? AND conversation_id = ? ORDER BY created_at, rowid
  `).bind(userId, conversationId).all();
  return results.map(messageFromRow);
}

// A question and the row its answer fills in when it ends, so an answer
// stays next to its question however late it is recorded. Resolves the
// answer's id; its status stays null until then.
export async function addQuestion(db, userId, conversationId, text, now = Date.now()) {
  const answerId = newId("msg");
  await db.batch([
    db.prepare(`
      INSERT INTO agent_messages (id, user_id, conversation_id, role, text, created_at)
      VALUES (?, ?, ?, 'user', ?, ?)
    `).bind(newId("msg"), userId, conversationId, String(text), now),
    db.prepare(`
      INSERT INTO agent_messages (id, user_id, conversation_id, role, text, created_at)
      VALUES (?, ?, ?, 'agent', '', ?)
    `).bind(answerId, userId, conversationId, now),
    db.prepare("UPDATE agent_conversations SET updated_at = ? WHERE user_id = ? AND id = ?").bind(now, userId, conversationId),
  ]);
  return answerId;
}

// The agent's answer as the screen saw it end. `agentId` and `session` come
// with a finished answer; a session replaces the one the conversation had.
export async function addAnswer(db, userId, conversationId, answerId, { text, steps = [], status, agentId = null, session = null }, now = Date.now()) {
  const kept = steps.slice(0, MAX_STEPS).map((step) => String(step).slice(0, STEP_LENGTH));
  await db.batch([
    db.prepare(`
      UPDATE agent_messages SET text = ?, steps = ?, status = ?
      WHERE user_id = ? AND conversation_id = ? AND id = ?
    `).bind(String(text ?? "").slice(0, MAX_ANSWER_TEXT), JSON.stringify(kept), status, userId, conversationId, answerId),
    db.prepare(`
      UPDATE agent_conversations SET
        updated_at = ?,
        agent_id = COALESCE(?, agent_id),
        agent_session = COALESCE(?, agent_session)
      WHERE user_id = ? AND id = ?
    `).bind(now, agentId, session, userId, conversationId),
  ]);
}

export async function deleteConversation(db, userId, id) {
  const result = await db.prepare("DELETE FROM agent_conversations WHERE user_id = ? AND id = ?").bind(userId, id).run();
  return result.meta?.changes ?? 0;
}
