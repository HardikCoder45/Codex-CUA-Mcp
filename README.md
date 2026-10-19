# codex-computer-use-mcp

A thin stdio MCP proxy for the **official OpenAI Codex unified computer-use runtime**.

This is not a Playwright/Puppeteer/Selenium/AppleScript reimplementation. The package installs and launches the **exact** official `cua_repl` runtime — same binaries, same arguments, same environment — that Codex itself uses.

The OpenAI runtime is **not vendored** in this package. If it is missing, this package installs it from OpenAI's own public installer image on first run, so `npm i` is the only command a user needs. The Codex/ChatGPT desktop app is never installed and never required. See [Provisioning](#provisioning).

## What it wraps

The locally observed Codex path is:

```text
MCP client
  ↓
codex-computer-use-mcp (this package)
  ↓
$CODEX_HOME/cua-runtime/cua_repl.json  (the official cua_repl configuration)
  ↓
cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs
  ↓
cua_node/bin/node_repl
  ↓
@oai/cua + browser/native trusted services
  ↓
Codex Computer Use.app native service / browser runtime
```

On the machine used to implement and validate this package, the relevant installed versions were:

- Codex CLI `0.154.0`
- `cua_node` runtime `0.0.27` (Node `24.21.0-cua.1`)
- `@oai/cua` `0.2.4`
- `@oai/sky` `0.6.26`
- `@oai/browser-desktop` `0.1.1`
- Codex Computer Use native service `26.902.1000968`
- macOS arm64

See [PROVENANCE.md](./PROVENANCE.md) for the discovery evidence and redistribution boundary.

## Requirements

The current package metadata intentionally targets the environment that was actually verified:

- macOS
- arm64
- Node.js 20 or newer
- normal macOS permissions required by the native computer-use service
- about 2GB of free disk space, for the first run only

A working Codex CLI is **not** required, and neither is the Codex desktop app.

The proxy does not pretend that the inspected macOS arm64 artifacts are portable to other platforms.

## Provisioning

Installing this package is enough. On first run, if the runtime is absent, it installs the
official OpenAI computer-use runtime on its own. **It does not install, and never launches, the
Codex/ChatGPT desktop app.**

### What gets installed

The runtime is the `cua_node` tree from the Codex desktop app: a bundled Node, the `node_repl`
binary, and the `@oai` modules (`cua`, `sky`, `browser-desktop`, `cua-repl`) that carry the native
`Codex Computer Use.app` service.

| Component | Size | On public npm? |
|---|---|---|
| `cua_node/bin/node`, `bin/node_repl` | 140MB | no |
| `@oai/cua`, `@oai/sky`, `@oai/browser-desktop`, `@oai/cua-repl` | 130MB | no (404) |
| `Codex Computer Use.app` (native service, inside `@oai/sky`) | 72MB | no |

It is installed to `$CODEX_HOME/cua-runtime` (override with `CODEX_CUA_RUNTIME_DIR`) and totals
about 270MB. The desktop app itself is never copied to `/Applications`.

### How

1. If a Codex app is already installed, its runtime is copied from there. No download.
2. Otherwise the official installer image is downloaded from
   `https://persistent.oaistatic.com/codex-app-prod/Codex.dmg` (716MB, no authentication),
   mounted **read-only** with `hdiutil`, and only the `cua_node` directory is copied out. The image
   is then unmounted and deleted. The 1.6GB app inside it is never written anywhere.

Relocation is safe: the runtime is configured entirely through environment variables, contains no
hardcoded `/Applications` path, and its native service carries an intact Developer ID signature
after being copied (a code signature seals file contents, not absolute paths).

Every run after the first is a fast no-op.

### Why the config is synthesized rather than hydrated

`unified-computer-use@openai-bundled` lives in a *reserved* marketplace. `codex plugin marketplace
add` rejects it outright:

```
Error: marketplace `openai-bundled` is reserved and cannot be added from this source
```

Only the Codex app writes that registration, so a CLI-only path to hydration does not exist. This
package therefore writes the hydrated `cua_repl` configuration itself, reproducing exactly what
Codex produces — same command, same arguments, same environment, same `enabled_tools` — pointed at
the standalone runtime. The reserved marketplace is never involved.

### Opting out

Set `CODEX_CUA_NO_PROVISION=1` to refuse self-installation and fail with instructions instead.

The install needs about 2GB of free disk space (716MB image plus the 270MB runtime it yields); the
free space is checked before downloading.

### The desktop app does not need to be running

Once the runtime is installed, the Codex desktop app does **not** need to be installed, open, or
running. `node_repl` is an ordinary background child process of this proxy, exactly as it is when
Codex drives it.

## Install / build

There are no runtime npm dependencies.

```bash
npm install
npm run check
```

To build an npm tarball without publishing it:

```bash
npm pack
```

To expose the executable globally from this checkout:

```bash
npm link
```

No npm publication is required.

## Run

After `npm link`:

```bash
codex-computer-use-mcp
```

Or run the executable directly:

```bash
node ./bin/codex-computer-use-mcp.mjs
```

The process speaks MCP over stdio. Do not write application logs to its stdout; diagnostics from this wrapper and the official child runtime go to stderr.

Set `CODEX_CUA_DEBUG=1` for wrapper resolution diagnostics on stderr.

## MCP client configuration

Using a linked executable:

```json
{
  "mcpServers": {
    "codex-computer-use": {
      "command": "codex-computer-use-mcp"
    }
  }
}
```

Using the local package directly:

```json
{
  "mcpServers": {
    "codex-computer-use": {
      "command": "node",
      "args": [
        "/absolute/path/to/codex-computer-use-mcp/bin/codex-computer-use-mcp.mjs"
      ]
    }
  }
}
```

## Exposed tools

The underlying installed `node_repl` server directly advertised four tools during validation:

- `js`
- `js_add_node_module_dir`
- `js_reset`
- `turn_ended`

However, the `unified-computer-use` configuration enables only:

- `js`
- `js_reset`
- `turn_ended`

This package reads `enabled_tools` from the runtime configuration at startup, filters `tools/list` to that set, and rejects direct calls to disabled tools. That keeps the public surface aligned with what the Codex plugin enables instead of exposing an extra Node-REPL maintenance tool.

The schemas, descriptions, annotations, image content, structured content, errors, and child-initiated MCP requests come from the official runtime and are forwarded rather than recreated here.

## `js` and the verified `cua` API

The official CUA documentation requires the first call after startup/reset to be:

```js
await cua.getState()
```

A direct call to the installed runtime verified that the CUA object includes the following public operations in the tested version:

```text
cua.getState(...)
cua.getApp(...)
cua.listApps(...)
cua.getBrowser(...)
cua.createBrowserTab(...)
cua.getTab(...)
cua.listBrowsers(...)
cua.listTabs(...)
```

Targets returned by the runtime expose operations including state/screenshot retrieval, paste, click, drag, key presses, scrolling, text selection, value setting, text typing, and secondary actions. The runtime's own `js` tool description is authoritative; this package does not synthesize method names or tool schemas.

Example MCP tool arguments:

```json
{
  "name": "js",
  "arguments": {
    "title": "Inspect current state",
    "code": "await cua.getState()"
  }
}
```

## Codex turn metadata

The installed browser trusted service requires MCP request metadata under:

```text
x-codex-turn-metadata
```

The verified minimum value contains:

```json
{
  "session_id": "...",
  "turn_id": "..."
}
```

Codex normally supplies this metadata from its host MCP execution layer. A generic MCP client often does not.

This proxy follows these rules:

1. If the client already supplies `params._meta["x-codex-turn-metadata"]`, it is preserved unchanged.
2. If it is absent, the proxy injects one synthetic, process-scoped session ID and turn ID.
3. The same synthetic pair is reused for the lifetime of that proxy process, which preserves persistent `js` state across calls.
4. On a graceful MCP disconnect or handled termination signal, the proxy attempts one official `turn_ended` call for the synthetic turn before closing the child runtime.

Advanced clients can provide deterministic synthetic IDs through:

```text
CODEX_CUA_SESSION_ID
CODEX_CUA_TURN_ID
```

Those variables affect only metadata synthesized by this wrapper. Client-provided Codex turn metadata still wins.

## Lifecycle

The original Codex plugin hooks `Stop`, `Interrupt`, and `SubagentStop` to `cua_repl.turn_ended`.

This wrapper does **not** call `turn_ended` after every `js` invocation because Codex keeps a CUA/Node-REPL session alive across multiple tool calls within a turn. Instead, when this wrapper had to synthesize its own process-scoped turn, it attempts a single cleanup notification on normal stdio disconnect or SIGINT/SIGTERM/SIGHUP and then closes/signals the exact official child process.

If a sophisticated MCP host supplies real Codex turn metadata and invokes `turn_ended` itself, those calls are simply forwarded.

`js_reset` retains its official semantics: it resets the persistent JavaScript kernel/bindings; it is not treated here as a substitute for turn or native-service cleanup.

## Images and screenshots

The proxy works at the MCP JSON-RPC envelope level. It does not stringify or convert image content into file paths. Official MCP content such as:

```json
{
  "type": "image",
  "data": "...",
  "mimeType": "image/png"
}
```

is forwarded as MCP image content. Structured content and text content are likewise preserved.

## Runtime discovery

At startup the wrapper:

1. resolves `$CODEX_HOME` and the runtime root (`$CODEX_HOME/cua-runtime`);
2. checks whether the runtime is installed, and installs it if not (see [Provisioning](#provisioning));
3. loads the `cua_repl` configuration, which names the exact `command`, `args` and environment;
4. validates that the command is executable and that the entry point is readable;
5. launches the official runtime and proxies MCP to it.

Optional resolution overrides:

```text
CODEX_HOME
CODEX_CUA_RUNTIME_DIR
CODEX_CUA_NO_PROVISION
```

## Secret handling

An ambient `NODE_REPL_AUTH_TOKEN` is intentionally removed from the inherited environment before launching the official runtime. If a future Codex hydrated configuration explicitly defines that value itself, the explicit official configuration takes precedence.

The package does not persist, print, or commit runtime auth tokens.

## Security boundary: standalone MCP vs. Codex host

This distinction is important.

Codex normally invokes computer use through additional host-side controls, including its MCP authorization/approval path, Guardian review, and application-access policy. Those controls are outside the `cua_repl` runtime.

Running this package independently therefore **does not reproduce the complete Codex host safety boundary**. In particular, do not assume that the standalone package has all Guardian or Codex application-access enforcement that would have occurred before a tool call inside Codex.

The official CUA/browser runtime itself still contains its own computer-use/browser instructions, permission checks, confirmation/elicitation paths, and trusted-service behavior. This proxy forwards child-initiated MCP requests (including elicitation requests) to the client unchanged. A client that does not implement the required MCP elicitation capability may therefore fail closed for operations that require confirmation.

Do not use this wrapper as a way to bypass application permissions, browser security checks, or authorization requirements.

## Redistribution / licensing boundary

The inspected installed OpenAI artifacts did not include a redistribution license or notice, and the native service's metadata states OpenAI copyright with rights reserved.

For that reason this npm package does **not** copy any of those bytes into its own tarball:

- `node_repl`
- the bundled Node executable
- `@oai/cua`, `@oai/sky`, `@oai/browser-desktop`, `@oai/cua-repl`
- `Codex Computer Use.app`

Instead it fetches them from OpenAI's own public installer image at runtime, on the user's
machine, and installs them outside the package. The package itself ships only the proxy.

This is an engineering packaging decision, not legal advice.

## Troubleshooting

### The runtime is not installed

This is the normal first run: the package installs the runtime itself. Watch stderr for progress.
To see what it resolved, set `CODEX_CUA_DEBUG=1`.

To install ahead of time without starting the proxy, set `CODEX_CUA_RUNTIME_DIR` and run the
server once, or point `CODEX_CUA_RUNTIME_DIR` at a runtime you already have.

### `CODEX_CUA_NO_PROVISION=1 is set`

Self-installation is disabled and no runtime was found. Unset the variable, or point
`CODEX_CUA_RUNTIME_DIR` at an existing runtime.

### Not enough disk space

The first run needs about 2GB free. The package checks before downloading and reports the shortfall.

### Browser state is empty

An empty browser list is different from a metadata error. The proxy supplies the required turn
metadata when the client omits it, but there may simply be no currently available browser
target/backend.

### Confirmation/elicitation requests fail

Use an MCP client that supports the elicitation capability expected by the official runtime. This
proxy intentionally forwards those requests instead of auto-approving them.

## Development

```bash
npm run build
npm test
npm run check
```

The tests cover metadata injection/preservation, enabled-tool filtering, disabled-tool rejection, runtime config generation, and sensitive-token non-inheritance.
# Codex-CUA-Mcp
