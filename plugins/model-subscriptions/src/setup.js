import { createCredentialFile } from "./credentials.js";
import { createSubscriptionsProvider } from "./node.js";
import { OFFERED, piModels } from "./own.js";

// The setup entry (`yolo.setup` in package.json): what `npm run yolo --
// models` reads on the node's machine (Agent Note
// 2026-10-25-models-for-plugins). `status()` says which source answers;
// `login()` signs Yolo in to a subscription of its own, for a node with no
// signed-in agent, and stores the credential in the plugin's state
// directory, where the node reads it.

export const provider = "models";
export const title = "Model subscriptions";

/** The subscriptions `login()` offers, in order: [{ id, label }]. */
export async function offered({ load } = {}) {
  const models = await piModels(createCredentialFile("/nonexistent"), load ? { load } : {});
  return OFFERED.map((id) => {
    const oauth = models.getProvider(id)?.auth?.oauth;
    return { id, label: oauth?.loginLabel || oauth?.name || id };
  });
}

/**
 * Signs in to `subscription` through its provider's flow and stores the
 * credential. `interaction` is pi-ai's: `prompt()` asks the owner (a
 * `manual_code` prompt takes the redirected address pasted back, racing the
 * local callback server), `notify()` shows the URL or device code.
 */
export async function login({ stateDir, subscription, interaction, load }) {
  if (!OFFERED.includes(subscription)) throw new Error(`Yolo signs in to ${OFFERED.join(", ")}, not ${subscription}`);
  const models = await piModels(createCredentialFile(stateDir), load ? { load } : {});
  await models.login(subscription, "oauth", interaction);
  return { subscription };
}

/** Removes Yolo's own sign-in to `subscription`. */
export async function logout({ stateDir, subscription }) {
  await createCredentialFile(stateDir).delete(subscription);
}

/** Each source and whether it answers, as the node would see them. */
export function status({ stateDir, env = process.env, options = {} }) {
  return createSubscriptionsProvider({ env, options, stateDir, log: {} }).status();
}
