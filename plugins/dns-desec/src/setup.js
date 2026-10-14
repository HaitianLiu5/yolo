import { createDesecClient, PROVIDER, SECRET } from "./desec.js";

// The setup entry (`yolo.setup` in package.json): what the operator's
// command line reads on the owner's machine, never the Worker
// (Agent Note 2026-10-14-dns-provider-plugins). `npm run yolo -- provision
// media-dns` prints `steps()`, checks the name with `checkZone()` and the
// token with `checkToken()` before storing it as the Worker secret `secret`;
// `doctor` checks that public DNS delegates the name to `nameservers`.

export const provider = PROVIDER;
export const secret = SECRET;
export const title = "deSEC";
export const nameservers = Object.freeze(["ns1.desec.io", "ns2.desec.org"]);

const HOSTNAME = /^(?=.{1,191}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The owner's steps at deSEC, in order: an account, a dedyn.io name, a token. */
export function steps({ zone = null } = {}) {
  const name = zone || "<name>.dedyn.io";
  return [
    `Open https://desec.io/ and sign up for a free dynDNS name, such as ${name} (any name under dedyn.io that is still free; one per account), with your email address. Open the link in the email deSEC sends to confirm it`,
    "Sign in at https://desec.io/ (an account made without a password gets one through \"Forgot password\" on the sign-in page), open Token Management, and create a token named \"Yolo media DNS\". Copy its secret at once: deSEC shows it only once. The token can change every record of your deSEC account, so keep it out of chats and files",
    `Store it in your own terminal: npm run yolo -- provision media-dns --provider ${PROVIDER} --zone ${name} --token-stdin, paste the token (nothing is shown as you type) and press Enter. Yolo checks it with deSEC and stores it as the Worker secret ${SECRET}; it never prints or saves it`,
  ];
}

/** Null for a name Yolo can use, else what is wrong with it. */
export function checkZone(zone) {
  const name = String(zone ?? "").trim().toLowerCase();
  if (!name) return "No deSEC name: give --zone <name>.dedyn.io";
  if (!HOSTNAME.test(name)) return `"${zone}" is not a DNS name such as home.dedyn.io (no scheme, no path)`;
  if (name === "dedyn.io") return "dedyn.io itself belongs to deSEC: register a name under it, such as home.dedyn.io";
  if (name.endsWith(".dedyn.io") && name.split(".").length !== 3) return `deSEC registers names directly under dedyn.io, such as ${name.split(".").slice(-3).join(".")}`;
  return null;
}

/**
 * Whether deSEC accepts `token` for `zone`: one read of the domain, which
 * also gives the TTL its records get. Never includes the token.
 * @returns {Promise<{ ok: boolean, message: string, ttl?: number }>}
 */
export async function checkToken({ token, zone, fetch, api }) {
  const { request } = createDesecClient({ token, fetch, api, sleep: async () => {} });
  try {
    const domain = await request("GET", `/domains/${encodeURIComponent(zone)}/`);
    const ttl = Math.max(60, Number(domain?.minimum_ttl) || 3600);
    return { ok: true, ttl, message: `deSEC accepts the token for ${zone} (records at a TTL of ${ttl} seconds)` };
  } catch (error) {
    if (error.code === "not_found") return { ok: false, message: `The token's deSEC account has no domain ${zone}: check the name, or register it at https://desec.io/` };
    if (error.code === "forbidden") return { ok: false, message: "deSEC rejected the token: copy it again from Token Management, or create a new one" };
    return { ok: false, message: `Cannot check the token with deSEC: ${error.message}` };
  }
}
