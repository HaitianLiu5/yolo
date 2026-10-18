import { McpServer } from "@modelcontextprotocol/server";
import { toYoloError, YoloError } from "@useyolo/core";
import { TOOLS } from "./tools.js";

// Server description (Agent Note 2026-10-07-remote-mcp-server). It must say
// what Yolo is, that agents search before playing, that playback defaults
// to the active device, and that thumbnails are image links to show as they
// are. It also heads off confusion with "YOLO mode" in coding agents.
const INSTRUCTIONS = [
  "Yolo is the user's private media service, not a \"YOLO mode\" or auto-approve setting.",
  "It plays videos from web URLs and from the user's home media library on the user's screens, such as the Yolo player in their Tesla's browser, and keeps a queue, playlists, and watch history. Which sites and libraries work depends on the source plugins on the user's home media node.",
  "Search before you play: use search or browse to get item ids, and never guess an id. A URL the user gives can be played directly.",
  "Playback goes to the active device by default. Pass device only when the user names one; list_devices shows the choices.",
  "To answer questions about what is playing, read it: get_item for details and people, get_transcript and search_transcript for what is said (with times to seek to), get_chapters and skip for chapters and the intro, and get_playback_health for why it stutters.",
  "If a tool returns node_offline, the home media node is unreachable: queue, playlists, and history still work, but playing and browsing the library do not.",
  "An item's thumbnail is its cover image: an absolute URL on the user's Yolo that loads without signing in, also later in this chat. Show it as it is, for example as a Markdown image ![Title](thumbnail). When it is null or missing, show no image; never make up, guess, or rewrite an image URL.",
].join("\n");

const SERVER_INFO = Object.freeze({ name: "yolo", title: "Yolo media service", version: "0.3.0" });

// Each tool names the one scope it needs
// (Agent Note 2026-10-07-oauth-authorization-server). Scopes do not imply each
// other: a token with only `manage` cannot read status.
function hasScope(scopes, needed) {
  return Array.isArray(scopes) && scopes.includes(needed);
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value ?? { ok: true }, null, 2) }] };
}

function failure(error) {
  const { code, message, retryable } = toYoloError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, retryable } }) }],
  };
}

// `getContext()` returns { services, scopes, images? } for the current
// request; `images` replaces every thumbnail in a result with a link an agent
// can show (image-links.js). `tools` adds plugin tools (plugins.js) after
// Yolo's own.
export function createYoloMcpServer(getContext, { tools = [] } = {}) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const tool of [...TOOLS, ...tools]) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: { title: tool.title, ...tool.annotations },
    }, async (args, ctx) => {
      try {
        const { services, scopes, images = null } = await getContext(ctx);
        if (!hasScope(scopes, tool.scope)) {
          return failure(new YoloError("forbidden", `${tool.name} needs the "${tool.scope}" scope; reconnect Yolo and allow it`));
        }
        const value = await tool.run(services, args ?? {});
        // A tool with `present` returns its own content blocks, such as an image.
        if (tool.present) return { content: tool.present(value) };
        return result(images ? await images.present(value) : value);
      } catch (error) {
        return failure(error);
      }
    });
  }
  return server;
}
