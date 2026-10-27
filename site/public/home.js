// The home page's demo, with no libraries and no requests beyond its two
// clips: four requests land on four screens, then the TV hands its film to
// a moving car at the same second. A line of light runs from the voice to
// each screen, a screen sweeps as it turns on and lights the black around
// it with its own picture, and the hand-off flies the TV's picture into the
// car. Reduced motion keeps the story and drops the line and the flight.

// What you say and what your agent does, in order, in the page's language.
const BEATS = {
  zh: {
    type: 55,
    beats: [
      { say: "接着放昨天没看完的财报电话会", steps: ["在播放记录里找到", "从 23:10 接着播", "笔记本 · 浏览器"], on: "laptop", from: 1390 },
      { say: "放一下这个帖子里的视频  🔗", steps: ["读取链接", "1080p", "手机"], on: "phone", from: 0 },
      { say: "客厅电视放《Tears of Steel》，跳过片头", steps: ["在片库里找到", "跳过片头 · 01:18", "Apple TV"], on: "tv", from: 78 },
      { say: "我出门了，换到车上", steps: ["交给车机", "同一秒接着播"], on: "car", handoff: "tv", from: 78, drive: true },
    ],
  },
  en: {
    type: 30,
    beats: [
      { say: "Pick up the earnings call I didn't finish", steps: ["Found in your history", "Resume at 23:10", "Laptop · browser"], on: "laptop", from: 1390 },
      { say: "Play the video in this post  🔗", steps: ["Read the link", "1080p", "Phone"], on: "phone", from: 0 },
      { say: "Tears of Steel on the living room TV, skip the intro", steps: ["Found in your library", "Skip intro · 01:18", "Apple TV"], on: "tv", from: 78 },
      { say: "I'm heading out. Move it to the car", steps: ["Hand off to the car", "Same second, carries on"], on: "car", handoff: "tv", from: 78, drive: true },
    ],
  },
};
const script = BEATS[document.documentElement.lang.startsWith("zh") ? "zh" : "en"];

const root = document.documentElement;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);
const say = document.querySelector(".say");
const said = document.querySelector(".said");
const trace = document.querySelector(".trace");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise(requestAnimationFrame);
const rect = (el) => el.getBoundingClientRect();
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clocks = {};
let run = 0;

function timecode(s) {
  s = Math.floor(s);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

// A screen plays: its clip from `at` seconds, its timecode from `from + at`.
function play(id, from, at = 0) {
  const el = $(id);
  el.classList.add("is-live");
  const clip = el.querySelector(".clip");
  if (clip) {
    clip.currentTime = at;
    clip.play().catch(() => {});
  }
  const start = performance.now() - at * 1000;
  const length = id === "laptop" ? 3600 : 734;
  clearInterval(clocks[id]);
  clocks[id] = setInterval(() => {
    const t = from + (performance.now() - start) / 1000;
    for (const tc of el.querySelectorAll(".tc")) tc.textContent = timecode(t);
    for (const bar of el.querySelectorAll(".bar span")) bar.style.width = Math.min(100, (t / length) * 100) + "%";
  }, 200);
}

function stop(id) {
  clearInterval(clocks[id]);
  $(id).classList.remove("is-live");
  const clip = $(id).querySelector(".clip");
  if (!clip) return 0;
  clip.pause();
  return clip.currentTime;
}

// Ambient light: a tiny canvas behind each screen, repainted from its
// picture and blurred wide by the stylesheet.
const ambient = {};
for (const device of document.querySelectorAll(".device")) {
  const amb = document.createElement("div");
  amb.className = "amb";
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 18;
  amb.append(canvas);
  device.prepend(amb);
  ambient[device.id] = { amb, ctx: canvas.getContext("2d"), clip: device.querySelector(".clip"), glass: device.querySelector(".glass") };
}

function placeAmbient() {
  for (const a of Object.values(ambient)) {
    a.amb.style.top = a.glass.offsetTop - a.glass.offsetHeight * 0.12 + "px";
    a.amb.style.height = a.glass.offsetHeight * 1.24 + "px";
  }
}

let lastPaint = 0;
(function paint(now) {
  requestAnimationFrame(paint);
  if (now - lastPaint < 80) return;
  lastPaint = now;
  for (const [id, a] of Object.entries(ambient)) {
    if (!$(id).classList.contains("is-live")) continue;
    if (a.clip) {
      if (a.clip.readyState >= 2) a.ctx.drawImage(a.clip, 0, 0, 32, 18);
    } else {
      a.ctx.fillStyle = "#3a3a38";
      a.ctx.fillRect(0, 0, 32, 18);
      a.ctx.fillStyle = "#77776f";
      a.ctx.fillRect(4, 5, 16, 8);
    }
  }
})(0);

// The signal: a line from the voice to the top of a screen, with a light
// running along it.
async function signal(fromEl, toId, mine) {
  if (reduced) return;
  const svg = $("signal");
  const a = rect(fromEl);
  const b = rect($(toId).querySelector(".glass"));
  const sx = a.left + a.width / 2;
  const sy = a.top + a.height / 2;
  const tx = b.left + b.width / 2;
  const ty = b.top;
  const my = (sy + ty) / 2;
  svg.innerHTML = `<path d="M${sx},${sy} C${sx},${my} ${tx},${my} ${tx},${ty}"/><circle r="3"/>`;
  const path = svg.querySelector("path");
  const dot = svg.querySelector("circle");
  const length = path.getTotalLength();
  path.style.strokeDasharray = length;
  const start = performance.now();
  for (;;) {
    if (mine !== run) {
      svg.innerHTML = "";
      return;
    }
    const t = Math.min(1, (performance.now() - start) / 700);
    const e = ease(t);
    path.style.strokeDashoffset = length * (1 - e);
    const p = path.getPointAtLength(length * e);
    dot.setAttribute("cx", p.x);
    dot.setAttribute("cy", p.y);
    if (t === 1) break;
    await frame();
  }
  path.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, fill: "forwards" });
  dot.animate([{ r: 3, opacity: 1 }, { r: 16, opacity: 0 }], { duration: 500, fill: "forwards" });
}

function ignite(id) {
  const el = $(id);
  el.classList.remove("is-igniting");
  void el.offsetWidth;
  el.classList.add("is-igniting");
}

// The hand-off: the TV's picture lifts off, arcs over, and lands on the
// car's screen, playing all the way.
async function fly(fromId, toEl) {
  if (reduced) return;
  const clip = $(fromId).querySelector(".clip");
  const a = rect($(fromId).querySelector(".glass"));
  const b = rect(toEl);
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 270;
  canvas.className = "flight";
  const ctx = canvas.getContext("2d");
  const draw = () => {
    const vw = clip.videoWidth || 16;
    const vh = clip.videoHeight || 9;
    const cw = (vh * 16) / 9;
    ctx.drawImage(clip, (vw - cw) / 2, 0, cw, vh, 0, 0, 480, 270);
  };
  draw();
  document.body.append(canvas);
  const box = (r) => ({ left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  const mid = {
    left: (a.left + b.left) / 2 + "px",
    top: Math.min(a.top, b.top) - 60 + "px",
    width: ((a.width + b.width) / 2) * 1.06 + "px",
    height: ((a.height + b.height) / 2) * 1.06 + "px",
  };
  const flight = canvas.animate([box(a), { ...mid, offset: 0.45 }, box(b)], { duration: 1100, easing: "cubic-bezier(.55, 0, .25, 1)", fill: "forwards" });
  let flying = true;
  (async () => {
    while (flying) {
      draw();
      await frame();
    }
  })();
  await flight.finished;
  flying = false;
  canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: "forwards" }).finished.then(() => canvas.remove());
}

async function type(text, mine) {
  said.textContent = "";
  say.classList.add("is-listening");
  for (const ch of text) {
    if (mine !== run) return;
    said.textContent += ch;
    await wait(/[，,.]/.test(ch) ? 220 : script.type);
  }
  say.classList.remove("is-listening");
}

async function drive(mine) {
  $("car").classList.add("is-moving");
  $("gear").textContent = "D";
  for (let v = 0; v <= 60; v += 2) {
    if (mine !== run) return;
    $("speed").textContent = v;
    await wait(45);
  }
}

async function sequence() {
  const mine = ++run;
  for (const id of ["phone", "laptop", "tv", "car"]) stop(id);
  $("car").classList.remove("is-moving");
  $("speed").textContent = "0";
  $("gear").textContent = "P";
  trace.replaceChildren();
  said.textContent = "";
  await wait(600);
  for (const beat of script.beats) {
    if (mine !== run) return;
    trace.replaceChildren();
    await type(beat.say, mine);
    await wait(250);
    const items = beat.steps.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      trace.append(li);
      return li;
    });
    for (const li of items) {
      if (mine !== run) return;
      li.classList.add("is-on");
      await wait(420);
      li.classList.add("is-done");
    }
    if (mine !== run) return;
    if (beat.handoff) {
      // The TV's clip plays on, hidden, while its picture flies; the car
      // takes it up where it is when the picture lands.
      const clip = $(beat.handoff).querySelector(".clip");
      const flight = fly(beat.handoff, $(beat.on).querySelector(".web-area"));
      await wait(120);
      const at = stop(beat.handoff);
      clip.play().catch(() => {});
      await flight;
      clip.pause();
      if (mine !== run) return;
      play(beat.on, beat.from, Math.max(at, clip.currentTime));
    } else {
      await signal(say.querySelector("i"), beat.on, mine);
      if (mine !== run) return;
      play(beat.on, beat.from);
    }
    ignite(beat.on);
    if (beat.drive) {
      await wait(500);
      await drive(mine);
    }
    await wait(beat.drive ? 1600 : 2200);
  }
  if (mine !== run) return;
  // The finale: every screen lit, the TV and the car on the same second.
  trace.replaceChildren();
  await signal($("car").querySelector(".glass"), "tv", mine);
  said.textContent = "";
  if (mine !== run) return;
  play("tv", 78, $("car").querySelector(".clip").currentTime);
  ignite("tv");
  await wait(5200);
  if (mine === run) sequence();
}

// The clips play from memory: the site's static assets answer whole files,
// not ranges, and a clip the browser streamed cannot seek to the second the
// hand-off needs. If a fetch fails, the clip keeps its own address.
async function loadClips() {
  const clips = [...document.querySelectorAll(".clip")];
  const sources = [...new Set(clips.map((clip) => clip.getAttribute("src")))];
  await Promise.all(sources.map(async (src) => {
    try {
      const response = await fetch(src);
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      for (const clip of clips) if (clip.getAttribute("src") === src) clip.src = url;
    } catch {}
  }));
}

root.classList.add("is-ready");
placeAmbient();
addEventListener("resize", placeAmbient);
loadClips().then(sequence);
