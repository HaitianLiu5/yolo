// Yolo is one protected resource, the deployment's origin, so one token
// covers /mcp and /v1 (Agent Note 2026-10-07-oauth-authorization-server). An
// MCP client may name the URL it was given instead, as the MCP authorization
// spec has clients do: `resource=https://yolo.example/mcp`, sometimes beside
// the origin itself. RFC 8707 lets the authorization server
// map such a value to its resource, so every `resource` on Yolo's origin
// becomes the origin, once, before the provider reads it. Any other value is
// left for the provider to refuse.

const RESOURCE = "resource";

function sameOrigin(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

// The params with their `resource` values mapped, or null when none changes.
function mapped(params, origin) {
  const values = params.getAll(RESOURCE);
  if (!values.some((value) => value !== origin && sameOrigin(value, origin))) return null;
  const kept = [...new Set(values.map((value) => (sameOrigin(value, origin) ? origin : value)))];
  const next = new URLSearchParams(params);
  next.delete(RESOURCE);
  for (const value of kept) next.append(RESOURCE, value);
  return next;
}

// The authorization or token request with its resource indicators on Yolo's
// origin named as the origin; any other request as it is.
export async function withOriginResource(request, origin, { authorizePath, tokenPath }) {
  const url = new URL(request.url);
  if (url.pathname === authorizePath && request.method === "GET") {
    const params = mapped(url.searchParams, origin);
    if (!params) return request;
    url.search = params.toString();
    return new Request(url, request);
  }
  if (url.pathname === tokenPath && request.method === "POST" && /application\/x-www-form-urlencoded/i.test(request.headers.get("content-type") || "")) {
    const params = mapped(new URLSearchParams(await request.clone().text()), origin);
    if (!params) return request;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return new Request(request, { headers, body: params.toString() });
  }
  return request;
}
