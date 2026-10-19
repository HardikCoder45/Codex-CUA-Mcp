import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";

import { ensureRuntimeConfig, resolveCodexHome } from "./provision.mjs";

export { resolveCodexHome };

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be a non-empty string array in the cua_repl MCP config.`);
  }
  return value;
}

// Resolves the official cua_repl runtime, installing it on first use if it is missing. The
// config describes the exact command, args and environment the official runtime expects.
export async function loadHydratedRuntime({ env = process.env, codexHome = resolveCodexHome(env) } = {}) {
  const config = await ensureRuntimeConfig({ env });

  if (config.enabled !== true) {
    throw new Error("cua_repl is not enabled in the runtime configuration.");
  }
  if (typeof config.command !== "string" || !config.command) {
    throw new Error("cua_repl does not define a command in the runtime configuration.");
  }
  if (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string")) {
    throw new Error("cua_repl args are invalid in the runtime configuration.");
  }

  const enabledTools = assertStringArray(config.enabled_tools, "cua_repl.enabled_tools");
  const officialEnv = config.env && typeof config.env === "object" && !Array.isArray(config.env) ? config.env : {};

  await access(config.command, fsConstants.X_OK);
  for (const arg of config.args) {
    if (arg.startsWith("/")) {
      await access(arg, fsConstants.R_OK);
    }
  }

  // Codex treats NODE_REPL_AUTH_TOKEN as sensitive/non-inheritable. Do not forward
  // an ambient token into the official runtime. If the runtime config itself
  // explicitly sets the variable, that explicit official value wins below.
  const inheritedEnv = { ...env };
  delete inheritedEnv.NODE_REPL_AUTH_TOKEN;
  const childEnv = { ...inheritedEnv, ...officialEnv };

  return {
    version: officialEnv.BROWSER_USE_CODEX_APP_VERSION,
    codexHome,
    command: config.command,
    args: [...config.args],
    childEnv,
    enabledTools: [...enabledTools],
    startupTimeoutSec: Number(config.startup_timeout_sec) || 120,
  };
}
