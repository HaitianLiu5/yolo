import { createAccountKey, createAcmeClient, csrFromPem, dnsChallengeValue, LETS_ENCRYPT_STAGING_DIRECTORY, YoloError } from "@useyolo/core";
import { BUILT_IN_PROVIDER } from "./dns.js";

// What the node's two media names share (Agent Note 2026-10-12-lan-direct-play,
// Agent Note 2026-10-13-media-off-the-worker,
// Agent Note 2026-10-14-dns-provider-plugins): the DNS provider (dns.js), a
// label in its zone outside the passkey relying party, and a certificate for
// exactly that name by ACME DNS-01, renewed two thirds into its lifetime,
// with failures backing off up to a day. Each name keeps its own state, ACME
// account, and certificate, so one path's renewal or failure never touches
// the other's.

const RETRY_BASE_MS = 30 * 60_000;
const RETRY_MAX_MS = 24 * 60 * 60_000;

export const acmeDirectory = (env) => env.LAN_ACME_DIRECTORY || LETS_ENCRYPT_STAGING_DIRECTORY;

/** When the certificate is due: two thirds into its lifetime. */
export function renewAt({ notBefore, notAfter }) {
  if (!notAfter) return null;
  const start = Number(notBefore) || Number(notAfter) - 90 * 24 * 60 * 60_000;
  return Math.round(start + (Number(notAfter) - start) * 2 / 3);
}

const randomLabel = (prefix) => `${prefix}${[...crypto.getRandomValues(new Uint8Array(4))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

/**
 * Sets `state.zone` and `state.name` (`<prefix><8 hex digits>.<zone>`), once
 * per DNS provider and zone. `state.dns` records a provider other than the
 * built-in one, so a state from before providers reads as Cloudflare's.
 * After a move to another provider or zone the name, its records, and the
 * certificate backoff start over; what the previous provider holds stays
 * there.
 */
export async function nameInZone(state, { dns, pageHost, prefix }) {
  if ((state.dns ?? BUILT_IN_PROVIDER) !== dns.key) {
    for (const field of ["zone", "name", "failures", "retryAt"]) delete state[field];
  }
  if (dns.key === BUILT_IN_PROVIDER) delete state.dns;
  else state.dns = dns.key;
  if (!state.zone) {
    state.zone = await dns.zone(pageHost);
    if (!state.zone?.name) throw new YoloError("internal", `The DNS provider ${dns.id} gave no zone`);
  }
  const before = state.name;
  if (!state.name || !state.name.endsWith(`.${state.zone.name}`)) state.name = `${randomLabel(prefix)}.${state.zone.name}`;
  // The remote name's records are kept by type: a new name has none yet.
  if (state.name !== before && state.records) state.records = {};
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
 * `state.step` as it goes, for the error the caller records. The CA checks
 * the challenge once public DNS answers it and the provider's `settleMs`
 * has passed.
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
        return { handle: await dns.setTxt(state.zone, txtName, value), value };
      },
      ready: async ({ value }) => {
        await waitForTxt(txtName, value);
        if (dns.settleMs > 0) await sleep(dns.settleMs);
      },
      remove: ({ handle, value }) => Promise.resolve().then(() => dns.clearTxt(state.zone, txtName, value, handle)).catch(() => {}),
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
