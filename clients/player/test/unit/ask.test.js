import assert from "node:assert/strict";
import test from "node:test";

import { createAsk, readLines, stepText } from "../../src/ask.js";

class FakeElement extends EventTarget {
  constructor() {
    super();
    this.value = "";
    this.textContent = "";
    this.dataset = {};
    this.attributes = {};
    this.classList = { hidden: true, toggle: (_name, on) => { this.classList.hidden = on; } };
    this.open = false;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  blur() {}
  showModal() { this.open = true; }
  close() {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  }
}

const ndjson = (...events) => new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), { headers: { "content-type": "application/x-ndjson" } });

function setup(respond) {
  const parts = { button: new FakeElement(), dialog: new FakeElement(), form: new FakeElement(), input: new FakeElement(), status: new FakeElement() };
  const sent = [];
  const ask = createAsk({ ...parts, request: async (body, signal) => { sent.push(body); return respond(body, signal); } });
  const submit = async (text) => {
    parts.input.value = text;
    const event = new Event("submit", { cancelable: true });
    parts.form.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { ...parts, ask, sent, submit };
}

test("lines arrive whole however the stream splits them", async () => {
  const chunks = ['{"a":', '1}\n{"b"', ':2}\n\n{"c":3}'];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const lines = [];
  for await (const line of readLines(body)) lines.push(line);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("the panel shows what the agent does, then its sentence", async () => {
  const seen = [];
  const { button, dialog, status, sent, submit } = setup(() => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "tool", name: "WebSearch" })}\n`));
        setTimeout(() => {
          seen.push(status.textContent);
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "done", text: "Playing Friends S1E1." })}\n`));
          controller.close();
        }, 5);
      },
    });
    return new Response(body);
  });
  button.dispatchEvent(new Event("click"));
  assert.equal(dialog.open, true);
  await submit("  play friends  ");
  assert.deepEqual(sent.map((body) => body.text), ["play friends"]);
  assert.deepEqual(seen, [stepText("WebSearch")]);
  assert.equal(status.textContent, "Playing Friends S1E1.");
  assert.equal(status.dataset.kind, "done");
  // Nothing played here, so the panel stays for the answer.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  assert.equal(dialog.open, true);
});

test("after a play the panel steps aside", async () => {
  const { button, dialog, submit } = setup(() => ndjson({ type: "tool", name: "play" }, { type: "done", text: "Playing." }));
  button.dispatchEvent(new Event("click"));
  await submit("play it");
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  assert.equal(dialog.open, false);
});

test("an error from Yolo or the agent is the one line shown", async () => {
  const refused = setup(() => Response.json({ error: { code: "not_found", message: "Upgrade the media node" } }, { status: 404 }));
  await refused.submit("play");
  assert.equal(refused.status.textContent, "Upgrade the media node");
  const failed = setup(() => ndjson({ type: "error", error: { code: "resolve_failed", message: "Connect Yolo to Claude Code" } }));
  await failed.submit("play");
  assert.equal(failed.status.textContent, "Connect Yolo to Claude Code");
  assert.equal(failed.status.dataset.kind, "error");
});

test("closing the panel stops the request", async () => {
  let aborted = false;
  const { button, dialog, submit } = setup((_body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("aborted", "AbortError"));
    });
  }));
  button.dispatchEvent(new Event("click"));
  await submit("play");
  dialog.close();
  assert.equal(aborted, true);
});
