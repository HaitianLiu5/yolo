import assert from "node:assert/strict";
import { test } from "node:test";
import { withDefaults } from "../lib/instance.js";
import { paths } from "../lib/paths.js";
import { cloudflaredSpec, nodeSpec, renderPlist, renderSystemdUnit, serviceFile } from "../lib/service.js";

const p = paths({ root: "/srv/yolo", env: {} });
const instance = withDefaults({ version: 1, domain: "yolo.example.com" });

test("the node's service runs main.js from the checkout under a Yolo label", () => {
  const spec = nodeSpec({ p, instance });
  assert.equal(spec.label, "app.useyolo.node");
  assert.equal(spec.program[1], "/srv/yolo/service/node/src/main.js");
  assert.equal(spec.workingDirectory, "/srv/yolo");
  assert.equal(spec.log, "/srv/yolo/.logs/node.log");
  assert.equal(spec.environment.DRIVEIN_ENV_FILE, undefined);
  assert.match(spec.environment.PATH, /\/usr\/bin/);
  // A runtime directory and an env file elsewhere move the log and reach the node.
  const moved = nodeSpec({ p: paths({ root: "/srv/yolo", env: { DRIVEIN_ENV_FILE: "/etc/yolo/.env" } }), instance, envValues: { YOLO_RUNTIME_DIR: "/var/yolo" }, envFileIsDefault: false });
  assert.equal(moved.log, "/var/yolo/.logs/node.log");
  assert.equal(moved.environment.DRIVEIN_ENV_FILE, "/etc/yolo/.env");
});

test("cloudflared runs the instance's tunnel from its token file with local metrics", () => {
  const spec = cloudflaredSpec({ p, instance: withDefaults({ ...instance, tunnel: { metrics: "127.0.0.1:20299" } }), cloudflared: "/opt/homebrew/bin/cloudflared" });
  assert.equal(spec.label, "app.useyolo.cloudflared");
  assert.deepEqual(spec.program, ["/opt/homebrew/bin/cloudflared", "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:20299", "run", "--token-file", "/srv/yolo/.yolo/tunnel-token"]);
});

test("a launchd plist escapes its values and restarts the job when it exits", () => {
  const spec = { ...nodeSpec({ p, instance }), workingDirectory: "/srv/a & b <c>" };
  const plist = renderPlist(spec);
  assert.match(plist, /<string>\/srv\/a &amp; b &lt;c&gt;<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n {2}<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
  assert.doesNotMatch(plist, /UserName/);
  assert.match(renderPlist(spec, { user: "owner" }), /<key>UserName<\/key>\n {2}<string>owner<\/string>/);
  assert.equal(serviceFile(spec, { platform: "darwin", home: "/Users/owner" }), "/Users/owner/Library/LaunchAgents/app.useyolo.node.plist");
  assert.equal(serviceFile(spec, { platform: "darwin", daemon: true }), "/Library/LaunchDaemons/app.useyolo.node.plist");
});

test("a systemd user unit is the Linux equivalent", () => {
  const spec = { ...nodeSpec({ p, instance }), program: ["/usr/bin/node", "/srv/my yolo/service/node/src/main.js"] };
  const unit = renderSystemdUnit(spec);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node "\/srv\/my yolo\/service\/node\/src\/main\.js"$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.equal(serviceFile(spec, { platform: "linux", home: "/home/owner" }), "/home/owner/.config/systemd/user/app.useyolo.node.service");
});
