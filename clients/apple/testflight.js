#!/usr/bin/env node
// Waits for App Store Connect to process an uploaded build and says whether
// TestFlight's internal testers can install it (Agent Note
// 2026-10-19-apple-tv-client, Building and installing). archive.sh runs it
// after an upload when Local.xcconfig names an App Store Connect API key:
//
//   ASC_KEY_ID = ABC123DEFG
//   ASC_ISSUER_ID = 00000000-0000-0000-0000-000000000000
//
// The key itself stays at ~/.appstoreconnect/private_keys/AuthKey_<id>.p8,
// where Xcode and altool look for it, never in the repository.
//
//   node testflight.js <tvos|ios> <build number>
//
// Exits 0 once the build is processed and ready for internal testing, 1 when
// App Store Connect rejects it or it needs a person, 2 on a timeout.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com/v1";
const POLL_MS = 30_000;
const TIMEOUT_MS = 45 * 60_000;

/** The settings Local.xcconfig and Base.xcconfig give, the local file last. */
function readXcconfig(text) {
  const settings = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith("//")) settings[match[1]] = match[2];
  }
  return settings;
}

/** An App Store Connect API token: ES256, valid for 20 minutes. */
function token({ keyId, issuerId, privateKey, now = Date.now() }) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(now / 1000);
  const body = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({ iss: issuerId, iat, exp: iat + 1200, aud: "appstoreconnect-v1" })}`;
  const signature = sign("sha256", Buffer.from(body), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${body}.${signature.toString("base64url")}`;
}

/**
 * What a build's state means for the owner: `wait` while App Store Connect
 * works, `ready` once internal testers can install it, `fail` otherwise.
 */
function verdict(processingState, internalBuildState) {
  if (processingState === "PROCESSING" || !processingState) return "wait";
  if (processingState !== "VALID") return "fail";
  if (internalBuildState === "PROCESSING" || !internalBuildState) return "wait";
  if (internalBuildState === "READY_FOR_BETA_TESTING" || internalBuildState === "IN_BETA_TESTING") return "ready";
  return "fail";
}

async function main([platform, build]) {
  if (!["tvos", "ios"].includes(platform) || !build) {
    console.error("usage: node testflight.js <tvos|ios> <build number>");
    process.exit(64);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const settings = {
    ...readXcconfig(readFileSync(join(here, "Config/Base.xcconfig"), "utf8")),
    ...readXcconfig(readFileSync(join(here, "Local.xcconfig"), "utf8")),
  };
  const keyId = process.env.ASC_KEY_ID || settings.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID || settings.ASC_ISSUER_ID;
  if (!keyId || !issuerId) {
    console.error("No App Store Connect API key: set ASC_KEY_ID and ASC_ISSUER_ID in Local.xcconfig.");
    process.exit(64);
  }
  const keyPath = process.env.ASC_KEY_PATH || join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${keyId}.p8`);
  const privateKey = createPrivateKey(readFileSync(keyPath));
  const bundleId = `${settings.BUNDLE_ID_PREFIX}.yolo`;

  const get = async (path) => {
    const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token({ keyId, issuerId, privateKey })}` } });
    if (!response.ok) throw new Error(`App Store Connect answered ${response.status} for ${path}: ${await response.text()}`);
    return response.json();
  };

  const apps = await get(`/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId`);
  const app = apps.data.find((each) => each.attributes.bundleId === bundleId);
  if (!app) {
    console.error(`No App Store Connect record for ${bundleId}.`);
    process.exit(1);
  }
  const ascPlatform = platform === "tvos" ? "TV_OS" : "IOS";
  const started = Date.now();
  let last = "";
  for (;;) {
    const builds = await get(`/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(build)}&filter[preReleaseVersion.platform]=${ascPlatform}&include=buildBetaDetail&fields[builds]=processingState,version&fields[buildBetaDetails]=internalBuildState`);
    const found = builds.data[0];
    const detail = found && (builds.included || []).find((each) => each.type === "buildBetaDetails");
    const processing = found?.attributes.processingState;
    const internal = detail?.attributes.internalBuildState;
    const state = found ? `${processing}${internal ? `, ${internal}` : ""}` : "not listed yet";
    if (state !== last) console.log(`Build ${build} (${platform}): ${state}`);
    last = state;
    const result = found ? verdict(processing, internal) : "wait";
    if (result === "ready") {
      console.log(`Build ${build} is processed; TestFlight's internal testers can install it.`);
      return;
    }
    if (result === "fail") {
      console.error(`Build ${build} needs a look in App Store Connect: ${state}.`);
      process.exit(1);
    }
    if (Date.now() - started > TIMEOUT_MS) {
      console.error(`Build ${build} is still ${state} after ${TIMEOUT_MS / 60_000} minutes.`);
      process.exit(2);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
