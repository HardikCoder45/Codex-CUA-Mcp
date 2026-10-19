# Provenance

This package is a launcher/proxy for the official OpenAI Codex computer-use runtime. It does **not** contain or redistribute the OpenAI runtime, native application, `node_repl` binary, or `@oai/*` packages. When the runtime is missing it installs it from OpenAI's own public installer image, outside the package, on the user's machine.

## Local runtime observed during implementation

The implementation was validated on 2026-09-12 against the following locally installed artifacts:

- Codex CLI: `0.154.0`
- Bundled plugin: `unified-computer-use@openai-bundled` version `26.903.71938`
- Hydrated plugin cache: `$CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/26.903.71938`
- CUA REPL executable supplied by the ChatGPT macOS application: `Contents/Resources/cua_node/bin/node_repl`
- `@oai/cua`: `0.2.4`
- `@oai/sky`: `0.6.26`
- `@oai/browser-desktop`: `0.1.1`
- Native Codex Computer Use service: `26.902.1000968`
- Platform of the observed binaries: macOS arm64

The local plugin manifest launches `scripts/launch.mjs`, which in turn launches the official `node_repl` executable and initializes the CUA banner/runtime. The `cua_repl` configuration supplies the exact command, arguments, environment, and enabled tool set used by this proxy.

## Runtime source and relocation

The runtime ships only inside the Codex desktop app, as `Contents/Resources/cua_node`, and is published nowhere else — `@oai/cua`, `@oai/sky`, `@oai/browser-desktop` and `@oai/cua-repl` all return 404 on the public npm registry, and the `cua-node-*.tar.gz` named by `cua_node/manifest.json` is not served from the public CDN. The native `Codex Computer Use.app` service ships inside that same tree at `cua_node/lib/node_modules/@oai/sky/`.

The runtime is location independent, which was verified rather than assumed: it contains no hardcoded `/Applications/ChatGPT.app` path in any `@oai` JavaScript package or in the `node_repl` binary, it is configured entirely through the environment, and its Developer ID signature validates at `~/.codex/computer-use/Codex Computer Use.app` as well as after being copied elsewhere. A code signature seals file contents, not absolute paths, so relocating the tree preserves it.

Provisioning therefore mounts the official installer image read-only, copies out `cua_node` alone, and discards the image. The desktop app is never installed and never launched.

`unified-computer-use@openai-bundled` is a reserved Codex marketplace that `codex plugin marketplace add` rejects, and only the desktop app writes its registration. This package consequently synthesizes the `cua_repl` configuration itself, reproducing the hydrated shape Codex produces, and never touches that marketplace.

## Tool surface observed directly

The underlying `node_repl` MCP server advertised:

- `js`
- `js_add_node_module_dir`
- `js_reset`
- `turn_ended`

The hydrated `unified-computer-use` plugin enables only:

- `js`
- `js_reset`
- `turn_ended`

This proxy therefore filters `tools/list` to that enabled set and rejects direct calls to tools disabled by the hydrated plugin. This matches the Codex plugin-facing surface rather than exposing the underlying Node REPL maintenance tool.

## Verified request metadata boundary

The browser trusted service requires Codex turn metadata at MCP request key `x-codex-turn-metadata`. A direct raw MCP probe verified that a JSON value containing `session_id` and `turn_id` is sufficient to remove the `Missing required Codex turn metadata` error for a safe `await cua.getState()` call.

When an MCP client already supplies that metadata, the proxy preserves it unchanged. When it is absent, the proxy injects a process-scoped synthetic session/turn pair so the official runtime can operate outside the Codex host.

## Redistribution boundary

No redistribution license or notice was found alongside the inspected `unified-computer-use` plugin cache or native Codex Computer Use application. The native application metadata identifies OpenAI copyright and states that rights are reserved. This package therefore ships none of those bytes in its own tarball, and instead fetches them from OpenAI's public installer image at runtime.

This document records an engineering boundary, not a legal opinion.
