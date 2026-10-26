// The player's CSS for web engines as old as Chromium 85, a 2022 Samsung
// TV's (Agent Note 2026-10-26-tv-web-client). Vite's own CSS lowering
// (build.target) covers nesting, :is(), and logical properties; this
// PostCSS plugin covers what it leaves, without changing what newer
// browsers draw:
//
// - oklch() colors inside sRGB become rgb(), the same color everywhere;
// - inset becomes top, right, bottom, and left, var() and calc() included;
// - container units (cqw, cqh) get viewport units under
//   @supports not (width: 1cqw): #app, their container, fills the window
//   unless the owner chose a display size (display-scale.js);
// - a :focus-visible rule gets a :focus copy under
//   @supports not selector(:focus-visible);
// - aspect-ratio gets --yolo-aspect-ratio beside it, which src/old-engine.js
//   reads to size those boxes where aspect-ratio does not exist.

/** Splits a value at its top-level spaces, leaving calc(), var(), and min() whole. */
export function words(value) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

const channel = (x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));

/** An oklch() color's rgb() equal, or null when it lies outside sRGB or is not plain numbers. */
export function oklchToRgb(args) {
  const [main, alpha] = args.split("/");
  const parts = main.trim().split(/\s+/);
  if (parts.length !== 3 || /[a-z(]/i.test(parts.join("").replace(/deg$/, "").replace(/%/g, ""))) return null;
  const number = (text, percentOf) => (text.endsWith("%") ? (parseFloat(text) / 100) * percentOf : parseFloat(text));
  const L = number(parts[0], 1);
  const C = number(parts[1], 0.4);
  const h = (parseFloat(parts[2]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  if (linear.some((x) => x < -1e-4 || x > 1 + 1e-4)) return null;
  const rgb = linear.map((x) => channel(Math.min(1, Math.max(0, x)))).join(" ");
  return alpha === undefined ? `rgb(${rgb})` : `rgb(${rgb} / ${alpha.trim()})`;
}

const OKLCH = /oklch\(([^()]*)\)/g;
const CONTAINER_UNITS = /(\d*\.?\d+)(cqw|cqh|cqi|cqb|cqmin|cqmax)\b/g;
const VIEWPORT = { cqw: "vw", cqi: "vw", cqh: "vh", cqb: "vh", cqmin: "vmin", cqmax: "vmax" };

export const lowerColors = (value) => value.replace(OKLCH, (text, args) => oklchToRgb(args) ?? text);
export const viewportUnits = (value) => value.replace(CONTAINER_UNITS, (_, n, unit) => `${n}${VIEWPORT[unit]}`);

/** inset's four sides as top, right, bottom, left. */
export function insetSides(value) {
  const [top, right = top, bottom = top, left = right] = words(value);
  return { top, right, bottom, left };
}

/** aspect-ratio's width over height, or null for auto. */
export function ratioOf(value) {
  const match = value.match(/^\s*(?:auto\s+)?([\d.]+)\s*(?:\/\s*([\d.]+))?\s*$/);
  return match ? Number(match[1]) / Number(match[2] ?? 1) : null;
}

const NO_CONTAINER_UNITS = "not (width: 1cqw)";
const NO_FOCUS_VISIBLE = "not selector(:focus-visible)";

export function oldEngineCss() {
  return {
    postcssPlugin: "yolo-old-engines",
    prepare() {
      // A rule's copy under an @supports, made once and filled as its
      // declarations are visited.
      const copies = new Map();
      function copyUnder(rule, condition, postcss) {
        const key = copies.get(rule) ?? new Map();
        copies.set(rule, key);
        if (key.has(condition)) return key.get(condition);
        const copy = postcss.rule({ selector: rule.selector, source: rule.source });
        const block = postcss.atRule({ name: "supports", params: condition, source: rule.source });
        block.append(copy);
        rule.after(block);
        key.set(condition, copy);
        return copy;
      }

      return {
        Declaration(decl, { postcss }) {
          if (OKLCH.test(decl.value)) decl.value = lowerColors(decl.value);
          OKLCH.lastIndex = 0;
          if (decl.prop === "inset") {
            const sides = insetSides(decl.value);
            // Each side keeps the source, which Vite reads to resolve url().
            decl.replaceWith(Object.entries(sides).map(([prop, value]) => postcss.decl({ prop, value, important: decl.important, source: decl.source })));
            return;
          }
          if (decl.prop === "aspect-ratio" && decl.next()?.prop !== "--yolo-aspect-ratio") {
            const ratio = ratioOf(decl.value);
            if (ratio) decl.cloneAfter({ prop: "--yolo-aspect-ratio", value: String(Number(ratio.toFixed(4))) });
          }
          const rule = decl.parent;
          if (rule?.type !== "rule" || (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name))) return;
          if (rule.parent?.type === "atrule" && rule.parent.params === NO_CONTAINER_UNITS) return;
          CONTAINER_UNITS.lastIndex = 0;
          if (CONTAINER_UNITS.test(decl.value)) {
            copyUnder(rule, NO_CONTAINER_UNITS, postcss).append(decl.clone({ value: viewportUnits(decl.value) }));
          }
          CONTAINER_UNITS.lastIndex = 0;
        },
        RuleExit(rule, { postcss }) {
          if (!rule.selector.includes(":focus-visible")) return;
          if (rule.parent?.type === "atrule" && rule.parent.params === NO_FOCUS_VISIBLE) return;
          const copy = rule.clone({ selector: rule.selector.replaceAll(":focus-visible", ":focus") });
          const block = postcss.atRule({ name: "supports", params: NO_FOCUS_VISIBLE, source: rule.source });
          block.append(copy);
          // After the rule's own container-unit copy, so the cascade keeps its order.
          const after = rule.next()?.type === "atrule" && rule.next().params === NO_CONTAINER_UNITS ? rule.next() : rule;
          after.after(block);
        },
      };
    },
  };
}
oldEngineCss.postcss = true;
