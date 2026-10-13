// A small leveled logger for the media node. Lines go to stdout/stderr, which
// launchd keeps; LOG_LEVEL picks the threshold (debug, info, warn, error,
// silent). Fields come first so call sites can be ported from pino as is:
// log.warn({ sessionId }, "message").

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function format(fields, message) {
  if (typeof fields === "string") return fields;
  const detail = fields && typeof fields === "object" && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  return `${message ?? ""}${detail}`;
}

export function createLogger({ level = process.env.LOG_LEVEL || "info", sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const at = (name, write) => (fields, message) => {
    if (LEVELS[name] >= threshold) write(`[${name}] ${format(fields, message)}`);
  };
  return {
    debug: at("debug", (line) => sink.log(line)),
    info: at("info", (line) => sink.log(line)),
    warn: at("warn", (line) => sink.warn(line)),
    error: at("error", (line) => sink.error(line)),
  };
}

export const silentLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

// Start every line the process prints through `target` (the node's own
// logger, plugins' loggers, and plain console output) with the time in UTC,
// ISO 8601, so launchd's log files line up with Workers Logs.
export function stampConsole(target = console, clock = () => new Date()) {
  for (const name of ["debug", "info", "log", "warn", "error"]) {
    const write = target[name].bind(target);
    target[name] = (first, ...rest) => {
      const stamp = clock().toISOString();
      return typeof first === "string" ? write(`${stamp} ${first}`, ...rest) : write(stamp, first, ...rest);
    };
  }
}
