import { mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Yolo's own sign-ins, as pi-ai's CredentialStore: one file, mode 0600, in
// the plugin's state directory, which Yolo never deletes. Every write is a
// read-modify-write under a lock file, so the node and `npm run yolo --
// models login` never refresh or write over each other
// (Agent Note 2026-10-25-models-for-plugins).

const LOCK_WAIT_MS = 15_000;
// A lock older than this was left by a process that died holding it.
const STALE_LOCK_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCredentialFile(dir) {
  const file = join(dir, "credentials.json");
  const lock = join(dir, "credentials.lock");

  function readAll() {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function writeAll(credentials) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  }

  async function locked(work, signal) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      signal?.throwIfAborted();
      try {
        closeSync(openSync(lock, "wx", 0o600));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
        } catch {}
        if (Date.now() > deadline) throw new Error(`The model sign-ins are locked by another process (${lock})`);
        await sleep(50);
      }
    }
    try {
      return await work();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  return {
    file,
    /** The providers signed in, without reading their secrets out. */
    providers: () => Object.keys(readAll()),

    async read(providerId) {
      return readAll()[providerId];
    },
    async list() {
      return Object.entries(readAll()).map(([providerId, credential]) => ({ providerId, type: credential?.type }));
    },
    async modify(providerId, fn, options) {
      return locked(async () => {
        const all = readAll();
        const next = await fn(all[providerId]);
        if (next === undefined) delete all[providerId];
        else all[providerId] = next;
        writeAll(all);
        return next;
      }, options?.signal);
    },
    async delete(providerId, options) {
      await locked(async () => {
        const all = readAll();
        delete all[providerId];
        writeAll(all);
      }, options?.signal);
    },
  };
}
