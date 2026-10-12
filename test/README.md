# Test architecture

Yolo has three test layers with different jobs:

- `*/test/unit` (and the `test/*.test.js` of the service and plugin workspaces) test deterministic policy and state transitions: the Hub, the device pairing flow, the source plugins' `prepare()`, the media pipeline against local HTTP origins. They do not depend on ffmpeg, a browser, or the network.
- `clients/tesla/test/integration` and `service/control/test/integration` test one real boundary such as HTTP bodies, WebCodecs orchestration, or the `/v1` API over the real service layer and D1 schema. External dependencies are injected.
- `test/e2e` runs the new stack: the media node and the control plane under `wrangler dev --local` (generated config, local D1 and KV, no fixed ports, nothing sent to Cloudflare), with the Tesla client served as the Worker's static assets. Chromium pairs with the device code flow and plays the four stream types (`direct`, `hls`, `dash_split`, `plex`) through `/m/*`, started by an agent over MCP. Media is made with ffmpeg; yt-dlp and Plex are local fixtures (`test/e2e/fixtures.js`).

An assertion belongs at the lowest layer that can prove the behavior. E2E tests cover a complete user journey and should not repeat every edge case from unit tests.

Tests must not use the repository's normal runtime state: the node gets `YOLO_RUNTIME_DIR` and its own socket under a temporary directory, and `DRIVEIN_ENV_FILE=""`. Network tests use local origins or injected transports. Do not share ports, call YouTube or Plex, or depend on a running Yolo node.

Run the layers independently:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e      # builds clients/tesla first if dist/ is missing
```

`npm run check` builds the client and the Worker, then runs all three layers.
