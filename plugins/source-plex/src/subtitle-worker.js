import { parentPort, workerData } from "node:worker_threads";
import { analyzeSubtitle } from "./subtitles.js";

// Converts one subtitle off the main thread (large ASS files are slow).
try {
  parentPort.postMessage(analyzeSubtitle(workerData.stream, workerData.buffer));
} catch (error) {
  parentPort.postMessage({ error: error.message || String(error) });
}
