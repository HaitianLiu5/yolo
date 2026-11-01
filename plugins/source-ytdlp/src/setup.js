import { cookiesFileFor } from "./node.js";
import { createTencentAccount, removeSignIn, signInWithCode, wechatCode, wechatQrCode, writeSignIn } from "./tencent-account.js";

// The setup entry (`yolo.setup` in package.json): what `npm run yolo --
// accounts` reads on the node's machine. `login()` signs Yolo in to an
// account of a site this plugin plays from and keeps it in the plugin's
// state directory, where the node reads it without a restart
// (Agent Note 2026-10-26-tencent-sports-replays).

export const provider = "accounts";
export const title = "Video site accounts";

const ACCOUNTS = [{ id: "tencent", label: "Tencent Video and Tencent Sports, with WeChat" }];

/** The accounts `login()` offers: [{ id, label }]. */
export const offered = async () => ACCOUNTS;

/** Each account and whether Yolo is signed in to it. */
export async function status({ stateDir, env = {}, options = {} }) {
  const account = createTencentAccount({ stateDir, cookiesFile: cookiesFileFor(options, env) });
  return { accounts: ACCOUNTS.map(({ id, label }) => ({ id, label, ...account.status() })) };
}

/**
 * Signs Yolo in to `account`: shows a WeChat QR code through
 * `interaction.notify({ type: "qr", text, url, message })`, waits for the
 * owner to scan and confirm it, and keeps the sign-in.
 */
export async function login({ stateDir, account = "tencent", interaction, fetchImpl = globalThis.fetch, signal }) {
  if (account !== "tencent") throw new Error(`Yolo signs in to ${ACCOUNTS.map(({ id }) => id).join(", ")}, not ${account}`);
  const qr = await wechatQrCode({ fetchImpl });
  interaction.notify({ type: "qr", text: qr.text, url: qr.image, message: "Scan this QR code with WeChat, signed in to the account that pays for Tencent Video or Tencent Sports, and confirm." });
  const code = await wechatCode(qr.uuid, { fetchImpl, signal, onScanned: () => interaction.notify({ message: "Scanned: confirm the sign-in in WeChat." }) });
  const signIn = await signInWithCode(code, { fetchImpl });
  writeSignIn(stateDir, signIn);
  return { account, sessionUntil: new Date(signIn.until).toISOString() };
}

/** Removes Yolo's own sign-in to `account`. */
export async function logout({ stateDir, account = "tencent" }) {
  if (account !== "tencent") throw new Error(`Yolo signs in to ${ACCOUNTS.map(({ id }) => id).join(", ")}, not ${account}`);
  removeSignIn(stateDir);
}
