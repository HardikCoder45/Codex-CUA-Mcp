// Standalone provisioning for the official OpenAI Codex computer-use runtime.
//
// The runtime ships only inside the Codex desktop app and is published nowhere else. It is the
// `cua_node` tree: a bundled Node, the `node_repl` binary, and the @oai modules (cua, sky,
// browser-desktop, cua-repl) that carry the native "Codex Computer Use.app" service.
//
// This module installs that runtime and nothing else. It never installs or launches the Codex
// desktop app. Instead it mounts the official installer image read-only, copies out the single
// `cua_node` directory, unmounts, and throws the image away — the 1.6GB app is never written to
// /Applications and never runs.
//
// The runtime is location independent, which is what makes this work:
//   - it is configured entirely through the env vars in buildRuntimeConfig(), and
//   - the native service is already shipped signed inside cua_node (@oai/sky), so it never has
//     to be fetched or re-signed separately.
// The `openai-bundled` marketplace is deliberately untouched: `codex plugin marketplace add`
// rejects it as a reserved namespace, so this module synthesizes the hydrated configuration
// itself instead of asking Codex to hydrate one.

import { execFile } from "node:child_process";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const INSTALLER_URL = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";

// 716MB installer image plus the 270MB runtime it yields, copied through a staging directory.
const REQUIRED_FREE_BYTES = 2 * 1024 * 1024 * 1024;

const ENABLED_TOOLS = ["js", "js_reset", "turn_ended"];
const APP_CANDIDATES = ["Codex.app", "ChatGPT.app"];

export function log(message) {
  // Never stdout: this process speaks MCP over stdio.
  console.error(`[codex-computer-use-mcp] ${message}`);
}

export function isDisabled(env = process.env) {
  return env.CODEX_CUA_NO_PROVISION === "1";
}

export function resolveCodexHome(env = process.env) {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function runtimeRoot(env = process.env) {
  return env.CODEX_CUA_RUNTIME_DIR?.trim() || join(resolveCodexHome(env), "cua-runtime");
}

export function runtimePaths(env = process.env) {
  const root = runtimeRoot(env);
  const cua = join(root, "cua_node");
  return {
    root,
    cua,
    node: join(cua, "bin", "node"),
    nodeRepl: join(cua, "bin", "node_repl"),
    moduleDir: join(cua, "lib", "node_modules"),
    replEntry: join(cua, "lib", "node_modules", "@oai", "cua-repl", "bin", "cua-repl.mjs"),
    skyService: join(cua, "lib", "node_modules", "@oai", "sky", "Codex Computer Use.app"),
    configPath: join(root, "cua_repl.json"),
  };
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isProvisioned({ env = process.env } = {}) {
  const paths = runtimePaths(env);
  const missing = [];
  for (const [label, path] of [
    ["node", paths.node],
    ["node_repl", paths.nodeRepl],
    ["cua-repl", paths.replEntry],
    ["native service", join(paths.skyService, "Contents", "MacOS")],
  ]) {
    if (!(await pathExists(path))) missing.push(label);
  }
  return { ready: missing.length === 0, paths, missing };
}

// The hydrated cua_repl configuration Codex itself would have written, retargeted at the
// standalone runtime. Same tool surface, same env contract.
export function buildRuntimeConfig({ env = process.env, appVersion } = {}) {
  const codexHome = resolveCodexHome(env);
  const p = runtimePaths(env);
  return {
    mcpServers: {
      cua_repl: {
        command: p.node,
        args: [p.replEntry],
        enabled: true,
        enabled_tools: [...ENABLED_TOOLS],
        omit_tools_from: ["code_mode", "deferred"],
        startup_timeout_sec: 120,
        tools: { js: { output_token_limit: 25000 } },
        env_vars: [],
        env: {
          NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
          NODE_REPL_NODE_MODULE_DIRS: p.moduleDir,
          NODE_REPL_NODE_PATH: p.node,
          NODE_REPL_TRUSTED_CODE_PATHS: `${codexHome}:${p.moduleDir}`,
          CODEX_HOME: codexHome,
          BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab,mcpapps",
          BROWSER_USE_TINYSKY_ENABLED: "1",
          NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER:
            "Control the in-app browser in conjunction with the Browser Plugin.",
          NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME:
            "Control the Chrome browser in conjunction with the Chrome Plugin. Prefer this method of controlling Chrome over alternatives (such as Computer Use) unless the user explicitly mentions an alternative.",
          NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE: "Control desktop apps on macOS through Computer Use.",
          BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
          BROWSER_USE_CODEX_APP_VERSION: appVersion || "standalone",
          NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
            browser: "@oai/browser-desktop/service",
            sky: "@oai/sky/service",
          }),
          SKY_CUA_SERVICE_PATH: p.skyService,
          CUA_REPL_NODE_REPL_PATH: p.nodeRepl,
          CUA_REPL_ENABLED_SURFACES: "browser,computer",
        },
      },
    },
  };
}

async function freeBytes(path) {
  try {
    const { stdout } = await execFileAsync("df", ["-k", path], { encoding: "utf8" });
    return Number(stdout.trim().split("\n").at(-1).trim().split(/\s+/)[3]) * 1024;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export async function downloadInstaller(destDir, onProgress = () => {}) {
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, "Codex.dmg");
  const response = await fetch(INSTALLER_URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`downloading ${INSTALLER_URL} failed with HTTP ${response.status}`);

  const total = Number(response.headers.get("content-length")) || 0;
  let seen = 0;
  let lastLogged = -1;
  const source = Readable.fromWeb(response.body);
  source.on("data", (chunk) => {
    seen += chunk.length;
    const pct = total ? Math.floor((seen / total) * 100) : 0;
    if (pct >= lastLogged + 10) {
      lastLogged = pct;
      onProgress(`download ${pct}%`);
    }
  });
  await pipeline(source, createWriteStream(dest));
  return dest;
}

async function plistString(plistPath, key) {
  try {
    const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], {
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// Install `cua_node` at `target` from a Codex app bundle. `app` may be inside a mounted
// read-only installer image; it is only ever read from.
async function installFromAppBundle(app, target, env, onProgress) {
  const source = join(app, "Contents", "Resources", "cua_node");
  if (!(await pathExists(join(source, "bin", "node_repl")))) return false;

  onProgress?.(`copying the cua_node runtime (about 270MB) from ${app}`);
  const staging = `${target}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  // The only symlinks inside are .bin shims, so resolving them keeps the tree self-contained.
  await cp(source, join(staging, "cua_node"), { recursive: true, dereference: true, preserveTimestamps: true });

  const version =
    (await plistString(join(app, "Contents", "Info.plist"), "CFBundleShortVersionString")) ?? "standalone";
  await writeFile(
    join(staging, "cua_repl.json"),
    `${JSON.stringify(buildRuntimeConfig({ env, appVersion: version }), null, 2)}\n`,
    "utf8",
  );

  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(staging, target, { recursive: true, dereference: true, preserveTimestamps: true });
  await rm(staging, { recursive: true, force: true });
  return true;
}

async function findInstalledApp() {
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    for (const name of APP_CANDIDATES) {
      const app = join(dir, name);
      if (await pathExists(join(app, "Contents", "Resources", "cua_node", "bin", "node_repl"))) return app;
    }
  }
  return null;
}

async function installFromImage(dmgPath, target, env, onProgress) {
  const { stdout } = await execFileAsync(
    "hdiutil",
    ["attach", "-nobrowse", "-readonly", "-plist", dmgPath],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const mountPoint = stdout
    .slice(stdout.indexOf("<?xml"))
    .match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!mountPoint) throw new Error("could not determine the mount point of the Codex installer image");

  try {
    onProgress?.("mounting the official installer image (read-only)");
    for (const name of APP_CANDIDATES) {
      // Read-only mount, and only the cua_node subdirectory is copied out. The desktop app
      // itself is never installed and never launched.
      if (await installFromAppBundle(join(mountPoint, name), target, env, onProgress)) return true;
    }
    throw new Error(`the Codex installer image contains no cua_node runtime (looked for ${APP_CANDIDATES.join(", ")})`);
  } finally {
    await execFileAsync("hdiutil", ["detach", mountPoint, "-quiet"]).catch(() => {});
  }
}

export async function provisionRuntime({ env = process.env, onProgress = log } = {}) {
  const target = runtimeRoot(env);
  const current = await isProvisioned({ env });
  if (current.ready) return current;

  // An existing Codex install already has the runtime: read it instead of downloading 716MB.
  const existing = await findInstalledApp();
  if (existing) {
    onProgress(`reusing the runtime already installed at ${existing}`);
    if (await installFromAppBundle(existing, target, env, onProgress)) {
      const state = await isProvisioned({ env });
      if (state.ready) return state;
    }
  }

  const free = await freeBytes(tmpdir());
  if (free < REQUIRED_FREE_BYTES) {
    throw new Error(
      `installing the Codex computer-use runtime needs about 2GB of free disk space, but only ${Math.round(free / 1024 / 1024)}MB is available`,
    );
  }

  const dmgDir = join(tmpdir(), "codex-computer-use-mcp-install");
  try {
    onProgress("downloading the official Codex installer image (about 716MB); the app itself is never installed");
    const dmgPath = await downloadInstaller(dmgDir, onProgress);
    if (!(await installFromImage(dmgPath, target, env, onProgress))) {
      throw new Error("the installer image did not yield a usable computer-use runtime");
    }
  } finally {
    await rm(dmgDir, { recursive: true, force: true }).catch(() => {});
  }

  const installed = await isProvisioned({ env });
  if (!installed.ready) {
    throw new Error(`the runtime was installed but these parts are missing: ${installed.missing.join(", ")}`);
  }
  onProgress(`installed the Codex computer-use runtime to ${target}`);
  return installed;
}

// Ensure the runtime exists and return its hydrated cua_repl configuration.
export async function ensureRuntimeConfig({ env = process.env } = {}) {
  const state = await isProvisioned({ env });
  if (!state.ready) {
    if (isDisabled(env)) {
      throw new Error(
        `the Codex computer-use runtime is not installed at ${runtimeRoot(env)}, and CODEX_CUA_NO_PROVISION=1 is set. ` +
          "Unset it to let this package install the runtime, or point CODEX_CUA_RUNTIME_DIR at an existing one.",
      );
    }
    await provisionRuntime({ env });
  }

  const { configPath } = runtimePaths(env);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`unable to read the installed runtime config at ${configPath}: ${error.message}`);
  }
  const config = parsed?.mcpServers?.cua_repl;
  if (!config || typeof config.command !== "string") {
    throw new Error(`the installed runtime config at ${configPath} does not define mcpServers.cua_repl.`);
  }
  return config;
}
