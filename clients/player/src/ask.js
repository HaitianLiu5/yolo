import { api, ApiError, authHeaders } from "./api.js";
import { canRecord, createVoiceController } from "./voice.js";

// Asking the owner's agent from this screen
// (Agent Note 2026-10-18-agent-from-the-screen): a few words go to Yolo,
// which hands them to the agent on the media node's machine; it finds and
// plays what was asked, and the play reaches this screen through the Hub like
// any other. Yolo keeps the conversation for the owner, so it is still there
// after the panel closes, the page reloads, or another screen opens Ask. Each
// answer shows one line for the step the agent is on, then its sentence or
// two, since the screen may be a car's while someone drives.
//
// The button shows only while Yolo says an agent can answer. Closing the
// panel leaves an answer running; Stop, or asking again, stops it.
//
// The microphone shows when the media node has a transcriber and this
// browser can record (voice.js): tap to speak, tap again or pause to stop;
// the words fill the field and are sent two seconds later unless the field
// is touched to edit them.

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
// The panel reopens on the last conversation until it is this old.
export const REMEMBER_MS = 6 * 60 * 60 * 1000;
const STORAGE_KEY = "yolo.ask.conversation";
const HISTORY_LIMIT = 30;

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

const blank = () => ({ id: null, title: "", messages: [] });

// A stored answer as the panel shows it. One with no status has not ended
// yet, or its screen went away before Yolo could record it.
function shown(message) {
  if (message.role !== "agent") return { role: "user", text: message.text };
  if (message.status === "done" || message.status === "error") return { role: "agent", text: message.text, kind: message.status };
  return { role: "agent", text: message.text || (message.status === "stopped" ? "Stopped." : "No answer yet."), kind: "stopped" };
}

// The conversation this screen shows, without the page: `request(id, body,
// signal)` posts a question (`id` "new" starts one), `load(id)` and
// `list()` read Yolo's. `onChange` gets the conversation after each change,
// `onPlayed` an answer that played something here.
export function createChat({
  request,
  load,
  list,
  storage = globalThis.localStorage,
  now = () => Date.now(),
  onChange = () => {},
  onPlayed = () => {},
} = {}) {
  let current = blank();
  let running = null; // { controller, conversation }
  // Bumped by each question and each change of conversation, so a load that
  // resolves after one of them is dropped.
  let generation = 0;

  const change = () => onChange(current, Boolean(running && running.conversation === current));
  const remember = (conversation) => {
    try {
      if (conversation.id) storage?.setItem(STORAGE_KEY, JSON.stringify({ id: conversation.id, at: now() }));
      else storage?.removeItem(STORAGE_KEY);
    } catch {
      // Private browsing: the panel starts anew each time.
    }
  };
  const remembered = () => {
    try {
      const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
      return value && typeof value.id === "string" && now() - Number(value.at) < REMEMBER_MS ? value.id : null;
    } catch {
      return null;
    }
  };

  function stop() {
    running?.controller.abort();
    running = null;
  }

  async function ask(text, language = null) {
    generation += 1;
    stop();
    const conversation = current;
    const controller = new AbortController();
    running = { controller, conversation };
    const answer = { role: "agent", text: "Asking…", kind: "busy" };
    conversation.messages.push({ role: "user", text }, answer);
    change();
    let played = false;
    const end = (text, kind) => {
      answer.text = text;
      answer.kind = kind;
    };
    try {
      const response = await request(conversation.id ?? "new", { text, language }, controller.signal);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error?.message || `Yolo answered ${response.status}`);
      }
      for await (const line of readLines(response.body)) {
        if (controller.signal.aborted) break;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "conversation") {
          conversation.id = event.id;
          conversation.title ||= event.title ?? text;
          if (conversation === current) remember(conversation);
        } else if (event.type === "tool") {
          if (PLAYS.has(event.name)) played = true;
          end(stepText(event.name), "busy");
        } else if (event.type === "done") {
          end(event.text || "Done.", "done");
        } else if (event.type === "error") {
          end(event.error?.message || "The agent could not do that.", "error");
        }
        change();
      }
      if (controller.signal.aborted) end("Stopped.", "stopped");
      else if (answer.kind === "busy") end("The agent stopped without an answer.", "error");
      else if (answer.kind === "done" && played && conversation === current) onPlayed();
    } catch (error) {
      if (controller.signal.aborted) end("Stopped.", "stopped");
      else end(error?.message || "Yolo could not reach the agent.", "error");
    } finally {
      if (running?.controller === controller) running = null;
      if (conversation.id && conversation === current) remember(conversation);
      change();
    }
  }

  // A conversation from Yolo. An answer still running in it keeps the
  // messages this screen has.
  async function open(id) {
    const asked = (generation += 1);
    if (running?.conversation.id === id) {
      current = running.conversation;
      change();
      return;
    }
    const conversation = await load(id);
    if (asked !== generation) return;
    current = { id: conversation.id, title: conversation.title, messages: conversation.messages.map(shown) };
    remember(current);
    change();
  }

  return {
    ask,
    stop,
    open,
    list: () => list(),
    get current() {
      return current;
    },
    get running() {
      return Boolean(running && running.conversation === current);
    },
    startNew() {
      generation += 1;
      current = blank();
      remember(current);
      change();
    },
    // On opening the panel: the last conversation, unless it is old or this
    // screen already shows one.
    async resume() {
      if (current.id || current.messages.length) return;
      const id = remembered();
      if (!id) return;
      const asked = generation + 1;
      try {
        await open(id);
      } catch {
        // Forget it only if nothing on this screen has moved on since.
        if (asked === generation) remember(blank());
      }
    },
  };
}

const ICON_SEND = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>';

function when(at) {
  const date = new Date(at);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function createAsk({
  doc = document,
  button = doc.getElementById("btn-ask"),
  dialog = doc.getElementById("ask"),
  form = doc.getElementById("ask-form"),
  input = doc.getElementById("ask-input"),
  send = doc.getElementById("ask-send"),
  title = doc.getElementById("ask-title"),
  newButton = doc.getElementById("ask-new"),
  historyButton = doc.getElementById("ask-history-button"),
  messages = doc.getElementById("ask-messages"),
  history = doc.getElementById("ask-history"),
  request = (id, body, signal) => fetch(`${location.origin}/v1/agent/conversations/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  }),
  load = (id) => api(`/v1/agent/conversations/${encodeURIComponent(id)}`, { timeoutMs: 8_000, retries: 0 }),
  list = async () => (await api(`/v1/agent/conversations?limit=${HISTORY_LIMIT}`, { timeoutMs: 8_000, retries: 0 })).conversations,
  storage,
  mic = doc.getElementById("ask-mic"),
  voiceStatus = doc.getElementById("ask-voice-status"),
  transcribe = async (wav, signal) => {
    const language = navigator.language ? `?language=${encodeURIComponent(navigator.language)}` : "";
    const response = await fetch(`${location.origin}/v1/agent/transcriptions${language}`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "audio/wav" }),
      body: wav,
      signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = data?.error;
      throw new ApiError(error?.message || `Speech to text failed with ${response.status}`, { code: error?.code || "internal", status: response.status });
    }
    return data;
  },
  report = () => {},
  // Turns the player down while the microphone listens, and back up.
  duck = () => {},
  recordable = () => canRecord(),
} = {}) {
  let agentName = "Ask";
  let closeTimer = null;
  let showingHistory = false;

  function render(conversation, busy) {
    title.textContent = conversation.title || agentName;
    messages.replaceChildren(...conversation.messages.map((message) => {
      const item = doc.createElement("li");
      item.className = "ask-message";
      item.dataset.role = message.role;
      if (message.kind) item.dataset.kind = message.kind;
      item.textContent = message.text;
      return item;
    }));
    messages.classList.toggle("hidden", showingHistory || !conversation.messages.length);
    messages.scrollTop = messages.scrollHeight;
    send.innerHTML = busy ? ICON_STOP : ICON_SEND;
    send.setAttribute("aria-label", busy ? "Stop" : "Send");
    send.dataset.busy = busy ? "true" : "";
  }

  const chat = createChat({
    request,
    load,
    list,
    ...(storage !== undefined ? { storage } : {}),
    onChange: render,
    onPlayed: () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (dialog.open) dialog.close();
      }, STEP_AFTER_PLAY_MS);
    },
  });

  function hideHistory() {
    showingHistory = false;
    history.classList.add("hidden");
    historyButton.setAttribute("aria-expanded", "false");
    render(chat.current, chat.running);
  }

  async function showHistory() {
    showingHistory = true;
    historyButton.setAttribute("aria-expanded", "true");
    render(chat.current, chat.running);
    const note = (text) => {
      const item = doc.createElement("li");
      item.className = "ask-history-note";
      item.textContent = text;
      history.replaceChildren(item);
    };
    note("Loading…");
    history.classList.remove("hidden");
    let conversations;
    try {
      conversations = await chat.list();
    } catch (error) {
      note(error?.message || "Yolo could not list your conversations.");
      return;
    }
    if (!showingHistory) return;
    if (!conversations.length) return note("No conversations yet.");
    history.replaceChildren(...conversations.map((conversation) => {
      const item = doc.createElement("li");
      const pick = doc.createElement("button");
      pick.type = "button";
      pick.className = "ask-history-item";
      const name = doc.createElement("span");
      name.textContent = conversation.title;
      const time = doc.createElement("span");
      time.className = "ask-history-time";
      time.textContent = when(conversation.updatedAt);
      pick.append(name, time);
      pick.addEventListener("click", async () => {
        clearTimeout(closeTimer);
        try {
          await chat.open(conversation.id);
          hideHistory();
        } catch (error) {
          note(error?.message || "Yolo could not open that conversation.");
        }
      });
      item.append(pick);
      return item;
    }));
  }

  function askNow(text) {
    input.value = "";
    input.blur();
    clearTimeout(closeTimer);
    if (showingHistory) hideHistory();
    void chat.ask(text, navigator.language || null);
  }

  // --- Voice ---------------------------------------------------------------
  const VOICE_STATUS = {
    starting: "Waiting for the microphone…",
    recording: "Listening… tap the microphone when you are done",
    transcribing: "Turning it into words…",
    countdown: "Sending… tap the field to edit",
  };
  let ducked = false;
  const voice = createVoiceController({
    transcribe,
    report,
    onSend: (text) => {
      if (input.value.trim() === text) askNow(text);
    },
    onChange: (next) => {
      const listening = next.phase === "starting" || next.phase === "recording";
      if (listening !== ducked) {
        ducked = listening;
        duck(listening);
      }
      mic.dataset.phase = next.phase;
      mic.setAttribute("aria-pressed", String(next.phase === "recording"));
      mic.setAttribute("aria-label", next.phase === "recording" ? "Stop listening" : "Speak");
      mic.style.setProperty("--voice-level", String(next.phase === "recording" ? Math.min(1, (next.level ?? 0) * 8) : 0));
      if (next.phase === "starting") input.value = "";
      if (next.phase === "countdown") input.value = next.text;
      input.readOnly = listening || next.phase === "transcribing";
      voiceStatus.textContent = next.phase === "error" ? next.message : VOICE_STATUS[next.phase] ?? "";
      voiceStatus.classList.toggle("hidden", !voiceStatus.textContent);
    },
  });
  mic.addEventListener("click", (event) => {
    event.preventDefault();
    clearTimeout(closeTimer);
    if (showingHistory) hideHistory();
    void voice.toggle();
  });
  // Touching the field keeps the words for editing instead of sending them.
  for (const type of ["pointerdown", "keydown", "focus"]) input.addEventListener(type, () => voice.hold());

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    voice.cancel();
    if (chat.running && !input.value.trim()) return chat.stop();
    const text = input.value.trim();
    if (!text) return;
    askNow(text);
  });
  // While an answer runs the send button is Stop.
  send.addEventListener("click", (event) => {
    if (!chat.running || input.value.trim()) return;
    event.preventDefault();
    chat.stop();
  });
  // Anything the owner does in the panel keeps it open.
  input.addEventListener("input", () => clearTimeout(closeTimer));
  newButton.addEventListener("click", () => {
    clearTimeout(closeTimer);
    if (showingHistory) hideHistory();
    chat.startNew();
    input.focus();
  });
  historyButton.addEventListener("click", () => {
    clearTimeout(closeTimer);
    if (showingHistory) hideHistory();
    else void showHistory();
  });
  button.addEventListener("click", async () => {
    clearTimeout(closeTimer);
    if (!dialog.open) dialog.showModal();
    render(chat.current, chat.running);
    input.focus();
    await chat.resume();
  });
  dialog.addEventListener("close", () => {
    clearTimeout(closeTimer);
    voice.cancel();
    if (showingHistory) hideHistory();
  });
  // A tap on the backdrop closes the panel, as on the other menus.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  return {
    chat,
    // Whether an agent can answer now; on each connection to Yolo.
    async refresh() {
      try {
        const { available, title: agent, speech } = await api("/v1/agent", { timeoutMs: 8_000, retries: 0 });
        button.classList.toggle("hidden", !available);
        mic.classList.toggle("hidden", !(speech && recordable()));
        agentName = agent ? `Ask ${agent}` : "Ask";
        button.setAttribute("aria-label", agentName);
        input.setAttribute("aria-label", agentName);
        if (!chat.current.title) title.textContent = agentName;
      } catch {
        // An older Yolo, or the node is away: keep the button as it was.
      }
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
