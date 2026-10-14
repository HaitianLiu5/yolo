import { createDesecProvider, PROVIDER, SECRET } from "./desec.js";

// The control entry (Agent Note 2026-10-14-dns-provider-plugins): it only
// registers the provider. The control plane creates it on each run when
// the instance's media.dns.provider is "desec", with the DESEC_TOKEN secret
// and media.dns.zone; otherwise it stays unused.

/** @param {import("@useyolo/plugin-api").YoloControlAPI} yolo */
export default function desec(yolo) {
  yolo.registerDnsProvider(PROVIDER, {
    title: "deSEC",
    secret: SECRET,
    create: ({ token, zone, fetch, sleep }) => createDesecProvider({ token, zone, fetch, sleep }),
  });
}
