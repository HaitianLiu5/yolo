import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_PROTOCOL } from "@useyolo/core";
import { localMigrations } from "../lib/d1.js";

export const summary = "This checkout's version, internal protocol, and newest migration";
export const usage = "version";
export const options = {};

export async function run({ p }) {
  const version = JSON.parse(readFileSync(join(p.root, "package.json"), "utf8")).version;
  const migration = localMigrations(p.migrations).at(-1) ?? null;
  return { command: "version", status: "ok", summary: `Yolo ${version}, protocol ${NODE_PROTOCOL}, migrations through ${migration}`, version, protocol: NODE_PROTOCOL, migration };
}
