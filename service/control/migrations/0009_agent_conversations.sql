-- Conversations with the owner's agent from a screen (Agent Note
-- 2026-10-18-agent-from-the-screen). A conversation belongs to the owner,
-- not a screen, and holds only what the screen shows: each question and the
-- agent's answer with the names of the tools it used, never tool results or
-- reasoning. The agent's own transcript stays with its CLI on the node's
-- machine; agent_session is that CLI's session id, so the next question
-- continues it.
--   agent_id       the node's agent that answered, once one has
--   title          the first question, cut to 80 characters
--   device_id      the screen that started it
--   role           'user' (a question) or 'agent' (an answer)
--   steps          JSON array of the tool names the agent called, at most 20
--   status         an answer's end: 'done', 'error', or 'stopped'; null while
--                  the answer, reserved with its question, has not ended
-- Each new conversation keeps the newest 500 per user and drops those idle
-- for 90 days; each question keeps its conversation's newest 200 messages.
-- The previous release never reads these tables.

CREATE TABLE agent_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  agent_session TEXT,
  title TEXT NOT NULL,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_conversations_user_updated ON agent_conversations(user_id, updated_at DESC);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  text TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT CHECK (status IN ('done', 'error', 'stopped')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_messages_conversation ON agent_messages(conversation_id, created_at);
