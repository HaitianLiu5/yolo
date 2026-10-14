import { createMcpHandler } from "agents/mcp/server";
import { createYoloMcpServer } from "./server.js";

// Streamable HTTP endpoint at /mcp, served statelessly by the Agents SDK
// (`createMcpHandler` with MCP SDK v2). Auth has already been checked by
// OAuthProvider, which passes the grant's props and scopes in. `images`
// turns thumbnails into links agents can show (image-links.js).
export function handleMcpRequest(request, { services, scopes, allowedHostnames, tools = [], images = null }) {
  const handler = createMcpHandler(
    () => createYoloMcpServer(() => ({ services, scopes, images }), { tools }),
    { route: "/mcp", ...(allowedHostnames ? { allowedHostnames } : {}) },
  );
  return handler.fetch(request);
}
