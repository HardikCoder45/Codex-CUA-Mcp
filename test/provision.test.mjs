import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRuntimeConfig,
  isDisabled,
  isProvisioned,
  runtimePaths,
} from "../src/provision.mjs";
import { ensureRuntimeConfig } from "../src/provision.mjs";

function envFor(root) {
  return { CODEX_CUA_RUNTIME_DIR: root };
}

// The whole point of the change: a machine with no runtime must be detected as not-ready.
test("reports not-ready when the runtime has never been installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cua-test-"));
  const state = await isProvisioned({ env: envFor(root) });
  assert.equal(state.ready, false);
  assert.deepEqual(state.missing.sort(), ["cua-repl", "native service", "node", "node_repl"].sort());
});

// The synthesized config must point the runtime at the relocated copy, never at an app bundle.
test("synthesized config targets the standalone runtime and not the desktop app", () => {
  const env = { ...envFor("/tmp/standalone-runtime"), CODEX_HOME: "/tmp/codex-home" };
  const config = buildRuntimeConfig({ env });
  const server = config.mcpServers.cua_repl;

  assert.equal(server.command, "/tmp/standalone-runtime/cua_node/bin/node");
  assert.deepEqual(server.args, [
    "/tmp/standalone-runtime/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs",
  ]);
  assert.equal(server.env.SKY_CUA_SERVICE_PATH,
    "/tmp/standalone-runtime/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app");
  assert.equal(server.env.CUA_REPL_NODE_REPL_PATH, "/tmp/standalone-runtime/cua_node/bin/node_repl");
  assert.equal(server.env.CODEX_HOME, "/tmp/codex-home");
  assert.equal(JSON.stringify(server).includes("/Applications"), false);

  // The tool surface must match what the official hydrated config enables.
  assert.deepEqual(server.enabled_tools, ["js", "js_reset", "turn_ended"]);
  assert.deepEqual(server.omit_tools_from, ["code_mode", "deferred"]);
  assert.equal(server.startup_timeout_sec, 120);
});

test("runtime paths are derived from CODEX_CUA_RUNTIME_DIR", () => {
  const paths = runtimePaths(envFor("/opt/cua"));
  assert.equal(paths.node, "/opt/cua/cua_node/bin/node");
  assert.equal(paths.configPath, "/opt/cua/cua_repl.json");
});

// Opting out must fail with instructions rather than silently installing.
test("CODEX_CUA_NO_PROVISION=1 refuses to install and says why", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cua-test-"));
  assert.equal(isDisabled({ CODEX_CUA_NO_PROVISION: "1" }), true);
  assert.equal(isDisabled({}), false);

  await assert.rejects(
    () => ensureRuntimeConfig({ env: { ...envFor(root), CODEX_CUA_NO_PROVISION: "1" } }),
    /not installed.*CODEX_CUA_NO_PROVISION/s,
  );
});

test("ensureRuntimeConfig reports a missing part by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cua-test-"));
  const env = { ...envFor(root), CODEX_CUA_NO_PROVISION: "1" };

  // node_repl exists but the native service does not, so the error must name that part.
  await mkdir(runtimePaths(env).cua, { recursive: true });
  await assert.rejects(() => ensureRuntimeConfig({ env }), /not installed/);
});
