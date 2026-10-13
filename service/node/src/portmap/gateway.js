import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { promisify } from "node:util";

// The default IPv4 gateway: the home router that NAT-PMP, PCP, and UPnP
// requests go to. Linux reads /proc/net/route; macOS and the BSDs ask
// `route -n get default`, which only reads the routing table.

const run = promisify(execFile);

// /proc/net/route: the default route's gateway, hex in host byte order.
export function parseProcRoute(text) {
  for (const line of String(text).split("\n").slice(1)) {
    const [, destination, gateway, flags] = line.trim().split(/\s+/);
    if (destination !== "00000000" || !gateway || !(parseInt(flags, 16) & 2)) continue;
    const value = parseInt(gateway, 16);
    const address = [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24].join(".");
    if (isIPv4(address) && address !== "0.0.0.0") return address;
  }
  return null;
}

export function parseRouteGet(text) {
  const address = /^\s*gateway:\s*(\S+)/m.exec(String(text))?.[1] ?? null;
  return address && isIPv4(address) ? address : null;
}

export async function defaultGateway({ platform = process.platform, read = (path) => readFile(path, "utf8"), exec = (file, args) => run(file, args, { timeout: 3_000 }) } = {}) {
  try {
    if (platform === "linux") return parseProcRoute(await read("/proc/net/route"));
    return parseRouteGet((await exec("route", ["-n", "get", "default"])).stdout);
  } catch {
    return null;
  }
}
