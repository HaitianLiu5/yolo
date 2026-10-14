// A secret read from stdin, never echoed: a token the owner pastes into
// their own terminal, or one piped in. On a terminal the input is read in
// raw mode, so nothing typed appears, and Backspace and Ctrl-C work; the
// prompt goes to `output` (stderr), so --json output on stdout stays clean.
// The value is returned trimmed and never written anywhere.

export async function readSecret({ input = process.stdin, output = process.stderr, prompt = "Token (input hidden): " } = {}) {
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) text += chunk;
    return text.trim();
  }
  output.write(prompt);
  input.setEncoding?.("utf8");
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    function onData(chunk) {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
      return undefined;
    }
    input.on("data", onData);
  });
}
