import { api, authHeaders } from "./api.js";

// Asking the owner's agent from this screen
// (Agent Note 2026-10-18-agent-from-the-screen): a few words go to /v1/agent,
// which hands them to the agent on the media node's machine; it finds and
// plays what was asked, and the play reaches this screen through the Hub like
// any other. This module shows only one line of progress and the agent's one
// sentence, since the screen may be a car's while someone drives.
//
// The button shows only while Yolo says an agent can answer. Closing the
// panel, or asking again, stops the request still running.

// What the agent is doing, by the tool it calls, in the owner's words.
const STEPS = Object.freeze({
  search: "Searching your libraries…",
  browse: "Looking through your libraries…",
  WebSearch: "Searching the web…",
  WebFetch: "Reading a page…",
  play: "Starting it…",
  queue_add: "Adding it to the queue…",
  playlist_enqueue: "Adding it to the queue…",
  control: "Controlling playback…",
  seek: "Moving to that point…",
  skip: "Skipping…",
  set_tracks: "Changing subtitles or audio…",
  history: "Checking what you watched…",
  get_status: "Checking what is playing…",
});
// Tools after which something new plays here, so the panel can step aside.
const PLAYS = new Set(["play", "skip", "seek", "control", "transfer"]);
const STEP_AFTER_PLAY_MS = 1_500;

export function stepText(name) {
  return STEPS[name] ?? "Working on it…";
}

// The NDJSON lines of a stream, as they arrive.
export async function* readLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield line;
    }
    if (done) break;
  }
  if (buffer.trim()) yield buffer.trim();
}

export function createAsk({
  button = document.getElementById("btn-ask"),
  dialog = document.getElementById("ask"),
  form = document.getElementById("ask-form"),
  input = document.getElementById("ask-input"),
  status = document.getElementById("ask-status"),
  request = (body, signal) => fetch(`${location.origin}/v1/agent`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  }),
} = {}) {
  let running = null;
  let closeTimer = null;

  function say(text, kind = "") {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function stop() {
    running?.abort();
    running = null;
    clearTimeout(closeTimer);
  }

  async function ask(text) {
    stop();
    const controller = new AbortController();
    running = controller;
    say("Asking…", "busy");
    let played = false;
    let answered = false;
    try {
      const response = await request({ text, language: navigator.language || null }, controller.signal);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error?.message || `Yolo answered ${response.status}`);
      }
      for await (const line of readLines(response.body)) {
        if (controller.signal.aborted) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "tool") {
          if (PLAYS.has(event.name)) played = true;
          say(stepText(event.name), "busy");
        } else if (event.type === "done") {
          answered = true;
          say(event.text || "Done.", "done");
        } else if (event.type === "error") {
          answered = true;
          say(event.error?.message || "The agent could not do that.", "error");
        }
      }
      if (!answered) say("The agent stopped without an answer.", "error");
      else if (played && status.dataset.kind === "done") {
        closeTimer = setTimeout(() => {
          if (dialog.open) dialog.close();
        }, STEP_AFTER_PLAY_MS);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      say(error?.message || "Yolo could not reach the agent.", "error");
    } finally {
      if (running === controller) running = null;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.blur();
    void ask(text);
  });
  button.addEventListener("click", () => {
    say("");
    input.value = "";
    if (!dialog.open) dialog.showModal();
    input.focus();
  });
  dialog.addEventListener("close", stop);
  // A tap on the backdrop closes the panel, as on the other menus.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  return {
    // Whether an agent can answer now; on each connection to Yolo.
    async refresh() {
      try {
        const { available, title } = await api("/v1/agent", { timeoutMs: 8_000, retries: 0 });
        button.classList.toggle("hidden", !available);
        const name = title ? `Ask ${title}` : "Ask";
        button.setAttribute("aria-label", name);
        input.setAttribute("aria-label", name);
      } catch {
        // An older Yolo, or the node is away: keep the button as it was.
      }
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
