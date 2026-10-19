import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TURN_METADATA_KEY,
  createProxyState,
  rewriteClientMessage,
  rewriteServerMessage,
} from "../src/proxy.mjs";
import { runtimePaths } from "../src/provision.mjs";
import { loadHydratedRuntime } from "../src/runtime.mjs";

const ENABLED = ["js", "js_reset", "turn_ended"];

function state() {
  return createProxyState({
    enabledTools: ENABLED,
    sessionId: "session-test",
    turnId: "turn-test",
  });
}

test("injects minimal Codex turn metadata when the MCP client omits it", () => {
  const proxyState = state();
  const input = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "js", arguments: { code: "await cua.getState()" } },
  };

  const { forward, localResponse } = rewriteClientMessage(input, proxyState);
  assert.equal(localResponse, null);
  const decoded = JSON.parse(forward.params._meta[TURN_METADATA_KEY]);
  assert.deepEqual(decoded, { session_id: "session-test", turn_id: "turn-test" });
  assert.equal(proxyState.syntheticMetadataUsed, true);
});

test("preserves client-provided Codex turn metadata exactly", () => {
  const proxyState = state();
  const input = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "js",
      arguments: { code: "await cua.getState()" },
      _meta: { [TURN_METADATA_KEY]: "upstream-value", other: "kept" },
    },
  };

  const { forward } = rewriteClientMessage(input, proxyState);
  assert.equal(forward, input);
  assert.equal(proxyState.syntheticMetadataUsed, false);
});

test("filters the underlying node_repl tool list to Codex's enabled plugin surface", () => {
  const proxyState = state();
  rewriteClientMessage({ jsonrpc: "2.0", id: "list-1", method: "tools/list", params: {} }, proxyState);

  const { forward } = rewriteServerMessage({
    jsonrpc: "2.0",
    id: "list-1",
    result: {
      tools: [
        { name: "js" },
        { name: "js_add_node_module_dir" },
        { name: "js_reset" },
        { name: "turn_ended" },
      ],
    },
  }, proxyState);

  assert.deepEqual(forward.result.tools.map((tool) => tool.name), ENABLED);
});

test("rejects calls to tools disabled by the hydrated Codex plugin", () => {
  const proxyState = state();
  const { forward, localResponse } = rewriteClientMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "js_add_node_module_dir", arguments: { path: "/tmp/node_modules" } },
  }, proxyState);

  assert.equal(forward, null);
  assert.equal(localResponse.id, 3);
  assert.equal(localResponse.error.code, -32602);
});

test("loads the installed runtime and strips an inherited NODE_REPL_AUTH_TOKEN", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cua-runtime-test-"));
  try {
    const paths = runtimePaths({ CODEX_CUA_RUNTIME_DIR: root });
    // Build a complete-enough runtime tree that provisioning is a no-op and the test
    // exercises only config loading and env handling.
    await mkdir(join(paths.cua, "bin"), { recursive: true });
    await mkdir(join(paths.moduleDir, "@oai", "cua-repl", "bin"), { recursive: true });
    await mkdir(join(paths.skyService, "Contents", "MacOS"), { recursive: true });
    await writeFile(paths.node, "#!/bin/sh\n");
    await chmod(paths.node, 0o755);
    await writeFile(paths.nodeRepl, "");
    await writeFile(paths.replEntry, "");
    await writeFile(
      paths.configPath,
      JSON.stringify({
        mcpServers: {
          cua_repl: {
            enabled: true,
            command: paths.node,
            args: [paths.replEntry],
            enabled_tools: ENABLED,
            env: { OFFICIAL_RUNTIME_VALUE: "present" },
          },
        },
      }),
    );

    const runtime = await loadHydratedRuntime({
      env: {
        CODEX_CUA_RUNTIME_DIR: root,
        NODE_REPL_AUTH_TOKEN: "must-not-leak",
        AMBIENT: "kept",
      },
    });

    assert.deepEqual(runtime.enabledTools, ENABLED);
    assert.equal(runtime.command, paths.node);
    assert.equal(runtime.childEnv.NODE_REPL_AUTH_TOKEN, undefined);
    assert.equal(runtime.childEnv.AMBIENT, "kept");
    assert.equal(runtime.childEnv.OFFICIAL_RUNTIME_VALUE, "present");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
