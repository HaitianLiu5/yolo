import assert from "node:assert/strict";
import test from "node:test";

import { pluginGroups } from "../../src/plugins-settings.js";

const plugin = (name, kinds, extra = {}) => ({ name, kinds, ...extra });

test("the plugins no place or Built in shows are listed once, by what they are for", () => {
  const groups = pluginGroups({
    plugins: [
      plugin("web-links", ["source"], { builtIn: true }),
      plugin("plex", ["source"]),
      plugin("own-source", ["source"]),
      plugin("agent-a", ["agent"]),
      plugin("agent-b", ["agent"]),
      plugin("names", ["metadata"]),
      plugin("subtitles", ["speech"]),
      plugin("new-kind", ["telepathy"]),
    ],
    places: [
      { id: "plex", plugins: ["plex"] },
      { id: "agent", plugins: ["agent-a", "agent-b"] },
    ],
  });
  assert.deepEqual(groups.map((group) => [group.id, group.plugins.map((entry) => entry.name)]), [
    ["sources", ["own-source"]],
    ["ai", ["agent-a", "agent-b", "subtitles"]],
    ["names", ["names"]],
    ["other", ["new-kind"]],
  ]);
});
