import { createAccountKey, createAcmeClient, csrFromPem, dnsChallengeValue, LETS_ENCRYPT_STAGING_DIRECTORY, YoloError } from "@useyolo/core";

// What the node's two media names share (Agent Note 2026-10-12-lan-direct-play,
// Agent Note 2026-10-13-media-off-the-worker): the zone token, a label in the
// owner's zone outside the passkey relying party, and a certificate for
// exactly that name by ACME DNS-01, renewed two thirds into its lifetime,
// with failures backing off up to a day. Each name keeps its own state, ACME
// account, and certificate, so one path's renewal or failure never touches
// the other's.

const RETRY_BASE_MS = 30 * 60_000;
const RETRY_MAX_MS = 24 * 60 * 60_000;

/**
 * The Cloudflare API token for the media names: MEDIA_DNS_TOKEN, or
 * LAN_DNS_TOKEN, its name before 0.5, until the release after it
 * (Agent Note 2026-10-13-versions-and-releases).
 */
export const dnsToken = (env) => env.MEDIA_DNS_TOKEN || env.LAN_DNS_TOKEN || null;

export const acmeDirectory = (env) => env.LAN_ACME_DIRECTORY || LETS_ENCRYPT_STAGING_DIRECTORY;

/** When the certificate is due: two thirds into its lifetime. */
export function renewAt({ notBefore, notAfter }) {
  if (!notAfter) return null;
  const start = Number(notBefore) || Number(notAfter) - 90 * 24 * 60 * 60_000;
  return Math.round(start + (Number(notAfter) - start) * 2 / 3);
}

const randomLabel = (prefix) => `${prefix}${[...crypto.getRandomValues(new Uint8Array(4))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

/** Sets `state.zone` and `state.name` (`<prefix><8 hex digits>.<zone>`), once. */
export async function nameInZone(state, { dns, pageHost, prefix }) {
  if (!state.zone) {
    state.zone = await dns.findZone(pageHost);
    if (!state.zone) throw new YoloError("forbidden", `MEDIA_DNS_TOKEN cannot read a zone that contains ${pageHost}; give it Zone Read and DNS Edit on that zone`);
  }
  if (!state.name || !state.name.endsWith(`.${state.zone.name}`)) state.name = `${randomLabel(prefix)}.${state.zone.name}`;
  // A name under the relying party's host could ask for the owner's passkeys.
  if (state.name === pageHost || state.name.endsWith(`.${pageHost}`)) {
    throw new YoloError("invalid_request", `The zone ${state.zone.name} has no name outside ${pageHost} for the node`);
  }
}

/**
 * Runs an ACME order for `state.name` when the node's certificate (its
 * `listener` status, with `csr`) is missing or due and no backoff holds, and
 * installs the chain with `install(chain)`, which answers the node's new
 * status. Returns that status, or null when nothing was due. Sets
 * `state.step` as it goes, for the error the caller records.
 */
export async function issueIfDue(state, { listener, dns, directory, install, fetchImpl, sleep, waitForTxt, now }) {
  const due = !listener.notAfter || now() >= renewAt(listener);
  if (!due || state.retryAt > now()) return null;
  state.step = "certificate";
  if (!state.account || state.account.directory !== directory) state.account = { directory, key: await createAccountKey(), url: null };
  const acme = createAcmeClient({ directoryUrl: directory, accountKey: state.account.key, accountUrl: state.account.url, fetchImpl, sleep });
  const txtName = `_acme-challenge.${state.name}`;
  const chain = await acme.issue({
    identifiers: [{ type: "dns", value: state.name }],
    csr: csrFromPem(listener.csr),
    solve: () => ({
      type: "dns-01",
      present: async ({ token }) => {
        const value = await dnsChallengeValue(token, state.account.key);
        return { id: await dns.createTxt(state.zone.id, txtName, value), value };
      },
      ready: ({ value }) => waitForTxt(txtName, value),
      remove: ({ id }) => dns.deleteRecord(state.zone.id, id).catch(() => {}),
    }),
  });
  state.account.url = acme.accountUrl;
  state.step = "install";
  const installed = await install(chain);
  state.failures = 0;
  state.retryAt = null;
  return installed;
}

/** After a failed certificate step: the next try waits 30 minutes, doubling up to a day. */
export function backOff(state, now) {
  state.failures = (Number(state.failures) || 0) + 1;
  state.retryAt = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (state.failures - 1));
}
