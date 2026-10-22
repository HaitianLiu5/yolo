import assert from "node:assert/strict";
import test from "node:test";

import { askedAgent, chooseAgent, chosenAgent } from "../../src/agent-choice.js";

const status = {
  available: true, id: "codex", title: "Codex",
  agents: [{ id: "claude-code", title: "Claude Code", available: false, reason: "Out of quota" }, { id: "codex", title: "Codex", available: true }],
};

test("a screen asks the agent it chose while Yolo has it, else Yolo's pick", () => {
  assert.equal(askedAgent(status, null).id, "codex");
  // Chosen though it cannot answer now: its own error says why.
  assert.deepEqual(askedAgent(status, "claude-code"), status.agents[0]);
  assert.equal(askedAgent(status, "gone").id, "codex");
  // A node from before choosing names only its pick.
  assert.deepEqual(askedAgent({ available: true, title: "Claude Code" }, "codex"), { id: null, title: "Claude Code", available: true });
  assert.equal(askedAgent({ available: false, reason: "No agent plugin is loaded on this media node" }), null);
});

test("the choice is this screen's, and a browser without storage keeps none", () => {
  const kept = new Map();
  const storage = { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value), removeItem: (key) => kept.delete(key) };
  chooseAgent("codex", storage);
  assert.equal(chosenAgent(storage), "codex");
  chooseAgent(null, storage);
  assert.equal(chosenAgent(storage), null);
  const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } };
  chooseAgent("codex", blocked);
  assert.equal(chosenAgent(blocked), null);
});
