// useyolo.app's motion, with no libraries and no requests: the window's
// edge blurs, reveals as the page scrolls, labels that decode, and the
// hero's field, a canvas of light that tells each page's story (privacy:
// your data circles inside your own boundary and nothing reaches us;
// home: a voice becomes a play on every screen; support: the path from
// your account to your screens). The field sleeps off screen and stands
// still for reduced motion.

const root = document.documentElement;
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- Edges ---------------------------------------------------------------

const edgeTop = document.querySelector(".edge-top");
const edgeBottom = document.querySelector(".edge-bottom");
const hero = document.querySelector(".hero");

function onScroll() {
  const y = scrollY;
  const below = root.scrollHeight - innerHeight - y;
  edgeTop?.classList.toggle("is-on", y > 8);
  edgeBottom?.classList.toggle("is-on", below > 24);
  if (hero) hero.style.setProperty("--leave", Math.min(1, y / (hero.offsetHeight * 0.8)).toFixed(3));
}

let scrollQueued = false;
function queueScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    onScroll();
  });
}
addEventListener("scroll", queueScroll, { passive: true });
addEventListener("resize", queueScroll);
document.addEventListener("toggle", queueScroll, true);
onScroll();

// --- Labels that decode ---------------------------------------------------

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/·—_";

function decode(el) {
  const text = el.textContent;
  if (still || !/^[\x00-\x7F·—→↗]*$/.test(text)) return;
  const start = performance.now();
  const chars = [...text];
  const frame = (now) => {
    const t = now - start;
    let done = true;
    el.textContent = chars.map((c, i) => {
      if (c === " " || t > 160 + i * 22) return c;
      done = false;
      return GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }).join("");
    if (!done) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// --- Reveals --------------------------------------------------------------

const seen = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add("in");
    entry.target.querySelectorAll("[data-decode]").forEach(decode);
    seen.unobserve(entry.target);
  }
}, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
document.querySelectorAll(".reveal").forEach((el) => seen.observe(el));

requestAnimationFrame(() => {
  root.classList.add("is-ready");
  hero?.querySelectorAll("[data-decode]").forEach(decode);
});

// --- The field ------------------------------------------------------------

const LIME = [200, 255, 58];
const RED = [255, 90, 71];
const WHITE = [236, 236, 232];
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

// Anchors are in the stage's own units (0 to 1 each way); kind says how
// an anchor is drawn. Links run from one anchor to another; both: packets
// go each way.
const SCENES = {
  privacy: {
    anchors: {
      screen: [0.06, 0.8, "ring"],
      server: [0.5, 0.1, "ring"],
      node: [0.94, 0.8, "ring"],
    },
    links: [["screen", "server", true], ["server", "node", true], ["node", "screen", true]],
    boundary: true,
    escape: { from: "server", to: [1.3, -0.12] },
  },
  home: {
    anchors: {
      voice: [0.02, 0.52, "voice"],
      agent: [0.44, 0.48, "agent"],
      car: [0.92, -0.04, "car"],
      tv: [1.0, 0.31, "tv"],
      phone: [1.0, 0.67, "phone"],
      web: [0.92, 1.02, "web"],
    },
    links: [["voice", "agent"], ["agent", "car"], ["agent", "tv"], ["agent", "phone"], ["agent", "web"]],
    narrow: { x: 0.15, y: 0.14, w: 0.58, h: 0.255 },
  },
  support: {
    anchors: {
      account: [0.04, 0.78, "step"],
      machine: [0.5, 0.18, "step"],
      screens: [0.96, 0.7, "step"],
    },
    links: [["account", "machine"], ["machine", "screens"]],
    sequential: true,
  },
};

const canvas = document.querySelector("canvas.field");
if (canvas && SCENES[canvas.dataset.scene]) field(canvas, SCENES[canvas.dataset.scene]);

function field(canvas, scene) {
  const ctx = canvas.getContext("2d");
  const callouts = [...document.querySelectorAll(".callout[data-at]")];
  const layer = document.querySelector(".callouts");
  let w = 0;
  let h = 0;
  let dpr = 1;
  let stage = { x: 0, y: 0, w: 0, h: 0 };
  let points = {};
  let paths = [];
  let particles = [];
  let sparks = [];
  let dust = [];
  let escaper = null;
  let nextEscape = 3.2;
  const glow = {};
  const pointer = { x: -1e4, y: -1e4, nx: 0.5, ny: 0.5, sx: 0, sy: 0 };
  const born = performance.now();
  let last = born;
  let running = false;
  let visible = true;

  function layout() {
    const rect = canvas.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const narrow = w < 720;
    stage = narrow
      ? { x: w * (scene.narrow?.x ?? 0.18), y: h * (scene.narrow?.y ?? 0.15), w: w * (scene.narrow?.w ?? 0.64), h: h * (scene.narrow?.h ?? 0.27) }
      : { x: w * 0.55, y: h * 0.17, w: Math.min(w * 0.34, 540), h: h * 0.3 };
    if (!narrow) stage.x = Math.min(stage.x, w - stage.w - w * 0.1);

    points = {};
    for (const [name, [ax, ay]] of Object.entries(scene.anchors)) {
      points[name] = { x: stage.x + ax * stage.w, y: stage.y + ay * stage.h };
      glow[name] ??= 0;
    }
    const centre = { x: stage.x + stage.w / 2, y: stage.y + stage.h * 0.56 };
    paths = scene.links.map(([a, b, both], i) => {
      const p0 = points[a];
      const p3 = points[b];
      const mx = (p0.x + p3.x) / 2;
      const my = (p0.y + p3.y) / 2;
      let nx = mx - centre.x;
      let ny = my - centre.y;
      const nl = Math.hypot(nx, ny) || 1;
      const bend = Math.hypot(p3.x - p0.x, p3.y - p0.y) * 0.16;
      nx = (nx / nl) * bend;
      ny = (ny / nl) * bend;
      if (scene.sequential || !scene.boundary) {
        nx = 0;
        ny = -bend * 0.6;
      }
      return {
        a, b, both, i,
        p0, p3,
        p1: { x: p0.x + (mx - p0.x) * 0.66 + nx, y: p0.y + (my - p0.y) * 0.66 + ny },
        p2: { x: p3.x + (mx - p3.x) * 0.66 + nx, y: p3.y + (my - p3.y) * 0.66 + ny },
      };
    });

    const count = Math.round(Math.min(900, Math.max(260, (w * h) / 1900)) * (narrow ? 0.6 : 1));
    particles = Array.from({ length: count }, () => spawn(Math.random()));
    dust = Array.from({ length: narrow ? 50 : 110 }, () => ({
      a: Math.random() * Math.PI * 2,
      r: Math.sqrt(Math.random()) * 0.95,
      spin: (Math.random() - 0.5) * 0.04,
      size: 0.4 + Math.random() * 0.7,
      alpha: 0.05 + Math.random() * 0.18,
    }));
    positionCallouts();
  }

  function bezier(p, t) {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * p.p0.x + b * p.p1.x + c * p.p2.x + d * p.p3.x,
      y: a * p.p0.y + b * p.p1.y + c * p.p2.y + d * p.p3.y,
    };
  }

  function normal(p, t) {
    const e = 0.002;
    const q0 = bezier(p, Math.max(0, t - e));
    const q1 = bezier(p, Math.min(1, t + e));
    const dx = q1.x - q0.x;
    const dy = q1.y - q0.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: -dy / l, y: dx / l };
  }

  function spawn(t = 0) {
    const path = paths[(Math.random() * paths.length) | 0];
    const reverse = path.both && Math.random() < 0.5;
    const hot = Math.random() < 0.08;
    return {
      path,
      reverse,
      t,
      speed: 0.07 + Math.random() * 0.11,
      spread: (Math.random() + Math.random() + Math.random() - 1.5) * (hot ? 4 : 16),
      size: hot ? 1.4 + Math.random() : 0.5 + Math.random() * 0.9,
      alpha: hot ? 0.95 : 0.25 + Math.random() * 0.45,
      hot,
    };
  }

  function boundary() {
    return {
      x: stage.x + stage.w / 2,
      y: stage.y + stage.h * 0.5,
      rx: stage.w * 0.64,
      ry: stage.h * 0.82,
    };
  }

  function positionCallouts() {
    for (const el of callouts) {
      const at = el.dataset.at;
      let p = points[at];
      if (at === "dev" && scene.escape) p = devPoint();
      if (!p) continue;
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    }
  }

  function devPoint() {
    const [ex, ey] = scene.escape.to;
    return {
      x: Math.min(w - 24, stage.x + ex * stage.w),
      y: Math.max(110, stage.y + ey * stage.h),
    };
  }

  function drawAnchor(name, kind, p, intro, time) {
    const g = glow[name];
    const s = ease((intro - 0.15) / 0.6);
    if (s <= 0) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(s, s);
    ctx.lineWidth = 1;

    if (kind === "ring" || kind === "step") {
      ctx.strokeStyle = rgba(WHITE, 0.5 + g * 0.5);
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = rgba(LIME, 0.55 + g * 0.45);
      ctx.beginPath();
      ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
      ctx.fill();
      const phase = ((time * 0.42 + name.length * 0.13) % 1);
      ctx.strokeStyle = rgba(LIME, (1 - phase) * 0.35);
      ctx.beginPath();
      ctx.arc(0, 0, 6 + phase * 26, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === "voice") {
      ctx.lineCap = "round";
      ctx.lineWidth = 1.5;
      for (let i = -7; i <= 7; i++) {
        const amp = (Math.sin(time * 3.1 + i * 0.7) * 0.5 + 0.5) * (Math.sin(time * 1.3 + i) * 0.4 + 0.6);
        const len = 4 + amp * 48 * (1 - Math.abs(i) / 9);
        ctx.strokeStyle = rgba(i === 0 ? LIME : WHITE, i === 0 ? 0.9 : 0.35 + amp * 0.4);
        ctx.beginPath();
        ctx.moveTo(i * 6, -len / 2);
        ctx.lineTo(i * 6, len / 2);
        ctx.stroke();
      }
    } else if (kind === "agent") {
      ctx.strokeStyle = rgba(WHITE, 0.16);
      ctx.beginPath();
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = rgba(LIME, 0.8);
      ctx.beginPath();
      ctx.arc(0, 0, 22, time * 1.4, time * 1.4 + 1.1);
      ctx.stroke();
      ctx.fillStyle = rgba(LIME, 0.5 + g * 0.5);
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const size = { car: [54, 22], tv: [58, 34], phone: [22, 38], web: [42, 30] }[kind];
      const [bw, bh] = size;
      ctx.strokeStyle = rgba(g > 0.5 ? LIME : WHITE, 0.35 + g * 0.5);
      ctx.beginPath();
      ctx.roundRect(-bw / 2, -bh / 2, bw, bh, 5);
      ctx.stroke();
      ctx.fillStyle = rgba(LIME, 0.03 + g * 0.08);
      ctx.fill();
      ctx.fillStyle = rgba(g > 0.2 ? LIME : WHITE, 0.4 + g * 0.6);
      ctx.beginPath();
      ctx.moveTo(-3.5, -5);
      ctx.lineTo(5.5, 0);
      ctx.lineTo(-3.5, 5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const time = (now - born) / 1000;
    const intro = still ? 9 : time;

    pointer.sx += ((pointer.nx - 0.5) * 18 - pointer.sx) * 0.05;
    pointer.sy += ((pointer.ny - 0.5) * 12 - pointer.sy) * 0.05;

    // Fade the last frame instead of clearing it: light leaves a trail.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = still ? "#050505" : "rgba(5,5,5,0.24)";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(pointer.sx, pointer.sy);
    if (layer) layer.style.transform = `translate(${pointer.sx.toFixed(2)}px, ${pointer.sy.toFixed(2)}px)`;

    // The boundary: everything inside is the owner's.
    if (scene.boundary) {
      const b = boundary();
      const k = ease((intro - 0.6) / 1.4);
      ctx.strokeStyle = rgba(WHITE, 0.14);
      ctx.setLineDash([2, 7]);
      ctx.lineDashOffset = -time * 6;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.rx, b.ry, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Dust: the quiet inside of the owner's boundary.
    {
      const b = boundary();
      const k = ease((intro - 0.8) / 2);
      ctx.fillStyle = rgba(WHITE, 1);
      for (const m of dust) {
        if (!still) m.a += m.spin * dt;
        ctx.globalAlpha = m.alpha * k;
        ctx.fillRect(b.x + Math.cos(m.a) * m.r * b.rx * 0.92, b.y + Math.sin(m.a) * m.r * b.ry * 0.92, m.size, m.size);
      }
      ctx.globalAlpha = 1;
    }

    // The links, traced in.
    for (const path of paths) {
      const k = ease((intro - 0.35 - path.i * 0.18) / 1.1);
      if (k <= 0) continue;
      ctx.strokeStyle = rgba(LIME, 0.12);
      ctx.beginPath();
      const steps = 48;
      for (let s = 0; s <= steps * k; s++) {
        const q = bezier(path, s / steps);
        s ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
      ctx.stroke();
    }

    // The way out: dashed, and cut.
    if (scene.escape && intro > 1.6) {
      const from = points[scene.escape.from];
      const to = devPoint();
      ctx.strokeStyle = rgba(RED, 0.22);
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Where the boundary cuts the way out.
      const b = boundary();
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        const x = from.x + (to.x - from.x) * mid;
        const y = from.y + (to.y - from.y) * mid;
        ((x - b.x) / b.rx) ** 2 + ((y - b.y) / b.ry) ** 2 < 1 ? (lo = mid) : (hi = mid);
      }
      const cx = from.x + (to.x - from.x) * lo;
      const cy = from.y + (to.y - from.y) * lo;
      ctx.strokeStyle = rgba(RED, 0.9);
      ctx.beginPath();
      ctx.moveTo(cx - 4, cy - 4);
      ctx.lineTo(cx + 4, cy + 4);
      ctx.moveTo(cx + 4, cy - 4);
      ctx.lineTo(cx - 4, cy + 4);
      ctx.stroke();
      ctx.fillStyle = rgba(RED, 0.9);
      ctx.beginPath();
      ctx.arc(to.x, to.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Packets.
    const fadeIn = ease((intro - 1.0) / 1.4);
    ctx.globalCompositeOperation = "lighter";
    for (const pt of particles) {
      if (!still) {
        const sequentialGate = scene.sequential && pt.path.i > 0 && intro < 2.2 ? 0 : 1;
        pt.t += pt.speed * dt * sequentialGate;
        if (pt.t >= 1) {
          glow[pt.reverse ? pt.path.a : pt.path.b] = Math.min(1, glow[pt.reverse ? pt.path.a : pt.path.b] + 0.012);
          Object.assign(pt, spawn(0));
        }
      }
      const t = pt.reverse ? 1 - pt.t : pt.t;
      const q = bezier(pt.path, t);
      const n = normal(pt.path, t);
      const taper = Math.sin(Math.PI * t);
      let x = q.x + n.x * pt.spread * taper;
      let y = q.y + n.y * pt.spread * taper;
      const dx = x - (pointer.x - pointer.sx);
      const dy = y - (pointer.y - pointer.sy);
      const d = Math.hypot(dx, dy);
      if (d < 130) {
        const push = Math.pow(1 - d / 130, 2) * 34;
        x += (dx / (d || 1)) * push;
        y += (dy / (d || 1)) * push;
      }
      const a = pt.alpha * fadeIn * (0.35 + taper * 0.65);
      ctx.fillStyle = rgba(pt.hot ? WHITE : LIME, a);
      ctx.beginPath();
      ctx.arc(x, y, pt.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Now and then a packet tries to leave. It never gets out.
    if (scene.escape && !still && intro > 2.4) {
      nextEscape -= dt;
      if (!escaper && nextEscape <= 0) {
        const from = points[scene.escape.from];
        escaper = { x: from.x, y: from.y, life: 0 };
        nextEscape = 3.4 + Math.random() * 2.2;
      }
      if (escaper) {
        const to = devPoint();
        const dx = to.x - escaper.x;
        const dy = to.y - escaper.y;
        const l = Math.hypot(dx, dy) || 1;
        const v = 120 * dt;
        escaper.x += (dx / l) * v;
        escaper.y += (dy / l) * v;
        escaper.life += dt;
        const b = boundary();
        const inside = ((escaper.x - b.x) / b.rx) ** 2 + ((escaper.y - b.y) / b.ry) ** 2;
        ctx.fillStyle = rgba(WHITE, 0.95);
        ctx.beginPath();
        ctx.arc(escaper.x, escaper.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
        if (inside >= 1 || escaper.life > 6) {
          for (let i = 0; i < 18; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 20 + Math.random() * 70;
            sparks.push({ x: escaper.x, y: escaper.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1 });
          }
          sparks.push({ ring: true, x: escaper.x, y: escaper.y, life: 1 });
          escaper = null;
        }
      }
    }

    for (const s of sparks) {
      s.life -= dt * (s.ring ? 1.4 : 1.8);
      if (s.ring) {
        ctx.strokeStyle = rgba(RED, Math.max(0, s.life) * 0.7);
        ctx.beginPath();
        ctx.arc(s.x, s.y, (1 - s.life) * 26 + 2, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.94;
      s.vy *= 0.94;
      ctx.fillStyle = rgba(RED, Math.max(0, s.life));
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    sparks = sparks.filter((s) => s.life > 0);

    ctx.globalCompositeOperation = "source-over";
    for (const [name, [, , kind]] of Object.entries(scene.anchors)) {
      glow[name] *= 0.96;
      drawAnchor(name, kind, points[name], intro, time);
    }
    ctx.restore();

    if (!still && running) requestAnimationFrame(frame);
  }

  function start() {
    if (running || still || !visible || document.hidden) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
  }

  layout();
  if (still) {
    for (const pt of particles) pt.t = Math.random();
    frame(performance.now());
  } else {
    start();
  }
  hero?.classList.add("is-ready");

  let resizeTimer = 0;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      layout();
      if (still) frame(performance.now());
    }, 120);
  });

  addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.nx = event.clientX / innerWidth;
    pointer.ny = event.clientY / innerHeight;
  }, { passive: true });
  document.addEventListener("pointerleave", () => {
    pointer.x = pointer.y = -1e4;
  });

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    visible ? start() : stop();
  }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
}
