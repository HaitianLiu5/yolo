// JSON with comments and trailing commas, as wrangler.jsonc uses them.
// Comments and trailing commas outside strings are dropped; strings are kept
// byte for byte, so a "//" inside a URL survives.

export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new SyntaxError("Unterminated /* comment");
      out += text.slice(i, end + 2).replace(/[^\n]/g, " ");
      i = end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

// Trailing commas before } or ], outside strings (comments already gone).
function stripTrailingCommas(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += char;
  }
  return out;
}

export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}
