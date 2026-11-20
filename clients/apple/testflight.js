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
// App Store Connect rejects it or it needs a person, 2 on a timeout or when
// App Store Connect stopped answering, which says nothing about the build.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com/v1";
const POLL_MS = 30_000;
const TIMEOUT_MS = 45 * 60_000;
// Polls in a row that may fail to get an answer before the wait gives up.
const MAX_FAILED_POLLS = 5;

/**
 * Whether a failed poll is worth another: the network failed (no status) or
 * App Store Connect answered 429 or 5xx. Any other answer, such as a 401 for
 * the key or a 403 for its role, will not change by waiting.
 */
function transientFailure(error) {
  return error.status === undefined || error.status === 429 || error.status >= 500;
}

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
 * A build number as Apple compares it: each integer without its leading
 * zeros, so archive.sh's 20261108.0901 is the 20261108.901 a record may list.
 */
function normalizedBuild(version) {
  return String(version).split(".").map((part) => (/^\d+$/.test(part) ? String(Number(part)) : part)).join(".");
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
    if (!response.ok) throw Object.assign(new Error(`App Store Connect answered ${response.status} for ${path}: ${await response.text()}`), { status: response.status });
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
  let failedPolls = 0;
  for (;;) {
    // The newest uploads, matched by the normalized number, since the
    // record may list the build with or without archive.sh's leading zeros.
    // One poll that gets no answer in 45 minutes of them says nothing about
    // the build: wait and ask again, up to MAX_FAILED_POLLS in a row.
    let builds;
    try {
      builds = await get(`/builds?filter[app]=${app.id}&filter[preReleaseVersion.platform]=${ascPlatform}&sort=-uploadedDate&limit=20&include=buildBetaDetail&fields[builds]=processingState,version,buildBetaDetail&fields[buildBetaDetails]=internalBuildState`);
      failedPolls = 0;
    } catch (error) {
      failedPolls += 1;
      if (!transientFailure(error)) throw error;
      if (failedPolls >= MAX_FAILED_POLLS) {
        console.error(`App Store Connect did not answer ${failedPolls} times in a row about build ${build}: ${error.message}`);
        process.exit(2);
      }
      console.log(`App Store Connect did not answer (${error.message.slice(0, 120)}); asking again.`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    const found = builds.data.find((each) => normalizedBuild(each.attributes.version) === normalizedBuild(build));
    const detailId = found?.relationships?.buildBetaDetail?.data?.id;
    const detail = detailId && (builds.included || []).find((each) => each.type === "buildBetaDetails" && each.id === detailId);
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
