# Agent Note: A Transocks account as the egress layer's China proxy

Status: implemented

English | [中文](2026-10-28-transocks-proxy-provider.zh.md)

## Problem

The owner's instance sends the few hosts that only answer viewers in China, Tencent Video's playback API and Bilibili's pages, through an egress proxy in China ([egress layer](../architecture/2026-10-13-node-egress-proxy.md), [Bilibili through the egress rule](2026-10-27-bilibili-through-the-egress-rule.md)). The owner pays for Transocks, an accelerator whose browser extension routes Chrome through one of the account's lines. Until 2026-10-28 the node used one of those lines through `proxy-url`: its address and credentials, copied by hand from the extension's storage on 2026-10-26.

On 2026-10-27 that line started refusing connections, and the four other lines stored in the extension were dead too, so every Bilibili video failed on the owner's screens with "Unable to connect to proxy" until someone copied a new line again. A Transocks line is not fixed: its credentials belong to a session the account opens on it, lines come and go, and the account lists more than sixty of them, some abroad.

## Decision

An official plugin, [`plugins/proxy-transocks`](../../../../plugins/proxy-transocks/src/node.js), registers the proxy provider `transocks`. The owner gives only the account, and the plugin does what the extension does when it connects.

- **The account is in `.env`:** `TRANSOCKS_ACCOUNT` (an email address, or a phone number with `TRANSOCKS_COUNTRY_CODE`) and `TRANSOCKS_PASSWORD`. A proxy in `yolo.config.json` names the provider, `"cn": { "provider": "transocks" }`, optionally with `options.locations`, words a line's location or name must contain (`["GuangZhou"]`). The plugin is not in `plugins/official.json`.
- **It signs in the way the extension does,** against the API the extension uses ([`src/api.js`](../../../../plugins/proxy-transocks/src/api.js), the only file that knows its shape): each request is sealed with AES-256-CBC under a key derived from the extension's public client key and the request's time and signed with HMAC-SHA1, and each answer is opened the same way. The node is its own device to Transocks, named by a hash of the account (`TRANSOCKS_DEVICE_ID` overrides it), so it is the same device on every start. Sign-in sends `autokick`, as the extension does, so an account with too many devices signs out its oldest one instead of refusing the node; the owner chose that on 2026-10-28.
- **It chooses a line.** Of the account's lines it keeps the ones that exit in China, not the relays abroad (`isRelay`), and not those the API marks broken. It measures each one's TCP connect time to the line's detect port from the node, the extension's own latency test, twice, keeping the shorter, and tries the fastest five in order: it opens a session on the line, which gives the line's HTTP proxy and its credentials, and checks that the proxy takes them and opens a `CONNECT` tunnel to `www.baidu.com:443`. The first that passes is handed out. A line that fails is passed over for ten minutes. The line list is kept an hour and each line's time ten minutes.
- **It keeps the line working.** The endpoint expires after 11 hours, an hour before the extension ends its own sessions, and the node then asks for it again: the plugin opens a new session on the same line, and moves to another only if that fails. It does the same after the proxy refuses the credentials. When the node says the proxy failed ([egress layer](../architecture/2026-10-13-node-egress-proxy.md)), the plugin checks the line: one that still tunnels stays, since the site was the problem; one that does not is closed and replaced by the next fastest. It signs in again when the token is about to expire or the API says the session ended or the account signed in elsewhere.
- **Nothing secret reaches a log.** Log lines name a line by its name and location, never its address or credentials, and no error carries the password or the token.

## Alternatives considered

**Keep copying a line into `proxy-url`.** It needs no code tied to the service, but it breaks whenever that one line goes down or its session ends, and someone must notice, open the extension's storage, and copy another; that is the failure that started this.

**A local plugin outside the repository,** as the egress layer's note first decided for commercial services. It would keep the service's private API out of Yolo's code, but the owner wanted the provider to ship with every checkout and be tested with the rest; the risks are the same either way and stay the owner's.

**Reading the extension's storage on the same machine.** It would need no sign-in, but the extension's lines are only those it connected to, its storage is a browser's internal database, and the node may not run where Chrome does.

**Letting Transocks choose (`recommendLine`).** The API can pick a line itself, but it picks for the device asking, without the node's own connect times or a check that the line tunnels.

## Consequences

The owner's China rule keeps working when a line goes down: the next request after the failure finds another line, and nobody copies anything by hand. The costs:

- The plugin depends on a private API and on constants from the extension's code; when Transocks changes either, sign-in or the line list fails with the API's own message in the node's log and in `yolo doctor`'s egress status, and the plugin needs a change.
- Signing in can sign out the owner's oldest Transocks device, such as Chrome, when the account is at its device limit.
- Connect time to a line's detect port measures distance, not throughput; a nearby line that is slow is kept until it fails.
- The account's password is in the node's `.env`, readable by every plugin under the plugin trust model.

The tests in [`plugins/proxy-transocks/test/`](../../../../plugins/proxy-transocks/test/) pin the sealing, the sign-in and line requests against a fake gateway, the gateway fallback, and the provider against a fake account: the fastest China line that tunnels, a line that does not answer or tunnel passed over, `options.locations`, a failed proxy whose line still tunnels kept and one that does not replaced, a renewal on the same line, a new sign-in after the session ends, and no secret in a log line or error.
