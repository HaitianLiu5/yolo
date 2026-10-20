import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { bonjourCommand, createBonjour } from "../src/bonjour.js";

test("the node advertises the control plane's origin by the system's Bonjour responder, and follows it", () => {
  assert.deepEqual(bonjourCommand("https://yolo.example.com", "darwin"), ["dns-sd", ["-R", "yolo.example.com", "_yolo._tcp", "local", "443", "origin=https://yolo.example.com"]]);
  assert.deepEqual(bonjourCommand("https://yolo.example.com:8443", "linux"), ["avahi-publish", ["-s", "yolo.example.com", "_yolo._tcp", "8443", "origin=https://yolo.example.com:8443"]]);
  assert.equal(bonjourCommand("https://yolo.example.com", "win32"), null);

  const started = [];
  const spawn = (file, args) => {
    const child = Object.assign(new EventEmitter(), { args, killed: false, kill() { this.killed = true; } });
    started.push(child);
    return child;
  };
  let origin = null;
  const bonjour = createBonjour({ origin: () => origin, env: {}, platform: "darwin", spawn });
  bonjour.sync();
  assert.equal(started.length, 0, "nothing to advertise before the origin is known");
  origin = "https://yolo.example.com/";
  bonjour.sync();
  bonjour.sync();
  assert.deepEqual([started.length, bonjour.published()], [1, "https://yolo.example.com"]);
  origin = "https://tv.example.com";
  bonjour.sync();
  assert.deepEqual([started[0].killed, started.length, started[1].args.at(-1)], [true, 2, "origin=https://tv.example.com"]);
  started[1].emit("exit", 1);
  bonjour.sync();
  assert.equal(started.length, 3, "republished after the responder exited");
  started[2].emit("error", Object.assign(new Error("spawn dns-sd ENOENT"), { code: "ENOENT" }));
  bonjour.sync();
  assert.deepEqual([started.length, bonjour.published()], [3, null], "a missing command is not retried");
  bonjour.close();

  const off = createBonjour({ origin: () => "https://yolo.example.com", env: { BONJOUR: "0" }, platform: "darwin", spawn });
  off.sync();
  assert.equal(started.length, 3);
});
