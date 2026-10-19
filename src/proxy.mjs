import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { loadHydratedRuntime } from "./runtime.mjs";

export const TURN_METADATA_KEY = "x-codex-turn-metadata";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function idKey(id) {
  return JSON.stringify(id);
}

function writeLine(stream, value) {
  const line = typeof value === "string" ? value : JSON.stringify(value);
  stream.write(`${line}\n`);
}

export function createProxyState({ enabledTools, sessionId, turnId }) {
  return {
    enabledTools: new Set(enabledTools),
    sessionId,
    turnId,
    pendingToolsListIds: new Set(),
    initialized: false,
    syntheticMetadataUsed: false,
    cleanupSent: false,
    internalCleanup: null,
  };
}

export function rewriteClientMessage(message, state) {
  if (!isObject(message)) return { forward: message, localResponse: null };

  if (message.method === "notifications/initialized") {
    state.initialized = true;
  }

  if (message.method === "tools/list" && Object.hasOwn(message, "id")) {
    state.pendingToolsListIds.add(idKey(message.id));
  }

  if (message.method !== "tools/call") {
    return { forward: message, localResponse: null };
  }

  const params = isObject(message.params) ? message.params : {};
  const toolName = params.name;
  if (typeof toolName === "string" && !state.enabledTools.has(toolName)) {
    const localResponse = Object.hasOwn(message, "id")
      ? {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: `Tool '${toolName}' is not enabled by the hydrated unified-computer-use plugin.`,
          },
        }
      : null;
    return { forward: null, localResponse };
  }

  const existingMeta = isObject(params._meta) ? params._meta : {};
  if (Object.hasOwn(existingMeta, TURN_METADATA_KEY)) {
    return { forward: message, localResponse: null };
  }

  state.syntheticMetadataUsed = true;
  const injectedMeta = {
    ...existingMeta,
    [TURN_METADATA_KEY]: JSON.stringify({
      session_id: state.sessionId,
      turn_id: state.turnId,
    }),
  };
  const forward = {
    ...message,
    params: {
      ...params,
      _meta: injectedMeta,
    },
  };
  return { forward, localResponse: null };
}

export function rewriteServerMessage(message, state) {
  if (!isObject(message)) return { forward: message, consumed: false };

  if (state.internalCleanup && Object.hasOwn(message, "id") && idKey(message.id) === state.internalCleanup.idKey) {
    const cleanup = state.internalCleanup;
    state.internalCleanup = null;
    cleanup.resolve(message);
    return { forward: null, consumed: true };
  }

  if (Object.hasOwn(message, "id") && state.pendingToolsListIds.delete(idKey(message.id))) {
    const tools = message?.result?.tools;
    if (Array.isArray(tools)) {
      return {
        forward: {
          ...message,
          result: {
            ...message.result,
            tools: tools.filter((tool) => state.enabledTools.has(tool?.name)),
          },
        },
        consumed: false,
      };
    }
  }

  return { forward: message, consumed: false };
}

async function requestSyntheticTurnCleanup(child, state, hookEventName) {
  if (!state.initialized || !state.syntheticMetadataUsed || state.cleanupSent || !child.stdin.writable) {
    return;
  }
  state.cleanupSent = true;

  const id = `codex-computer-use-mcp:cleanup:${randomUUID()}`;
  const cleanupPromise = new Promise((resolve) => {
    state.internalCleanup = { idKey: idKey(id), resolve };
  });
  const timeoutPromise = new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    timer.unref?.();
  });

  writeLine(child.stdin, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "turn_ended",
      arguments: {
        hook_event_name: hookEventName,
        session_id: state.sessionId,
        turn_id: state.turnId,
      },
      _meta: {
        [TURN_METADATA_KEY]: JSON.stringify({
          session_id: state.sessionId,
          turn_id: state.turnId,
        }),
      },
    },
  });

  await Promise.race([cleanupPromise, timeoutPromise]);
  state.internalCleanup = null;
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 1;
}

export async function runProxy({ env = process.env } = {}) {
  // Installs the official Codex runtime on first use if it is missing. No-op afterwards,
  // and it never runs when CODEX_CUA_NO_PROVISION=1.
  const runtime = await loadHydratedRuntime({ env });
  const sessionId = env.CODEX_CUA_SESSION_ID?.trim() || `standalone-${randomUUID()}`;
  const turnId = env.CODEX_CUA_TURN_ID?.trim() || `standalone-${randomUUID()}`;
  const state = createProxyState({
    enabledTools: runtime.enabledTools,
    sessionId,
    turnId,
  });

  if (env.CODEX_CUA_DEBUG === "1") {
    console.error(`[codex-computer-use-mcp] cua_repl runtime ${runtime.version}`);
    console.error(`[codex-computer-use-mcp] command: ${runtime.command}`);
  }

  const child = spawn(runtime.command, runtime.args, {
    cwd: process.cwd(),
    env: runtime.childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.pipe(process.stderr);

  const childLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const clientLines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  let requestedSignal = null;
  let shuttingDown = false;

  childLines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Preserve the official runtime's stdout byte-for-byte enough for line-framed
      // stdio clients even if it unexpectedly emits a non-JSON line.
      writeLine(process.stdout, line);
      return;
    }
    const { forward } = rewriteServerMessage(message, state);
    if (forward !== null) writeLine(process.stdout, forward);
  });

  clientLines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeLine(child.stdin, line);
      return;
    }
    const { forward, localResponse } = rewriteClientMessage(message, state);
    if (localResponse !== null) writeLine(process.stdout, localResponse);
    if (forward !== null) writeLine(child.stdin, forward);
  });

  let shutdownPromise = null;
  const shutdown = (hookEventName, signal = null) => {
    if (shutdownPromise) return shutdownPromise;
    requestedSignal = signal || requestedSignal;
    shuttingDown = true;
    shutdownPromise = (async () => {
      try {
        await requestSyntheticTurnCleanup(child, state, hookEventName);
      } catch (error) {
        if (env.CODEX_CUA_DEBUG === "1") {
          console.error(`[codex-computer-use-mcp] turn_ended cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (child.stdin.writable) child.stdin.end();
      if (signal && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }

      const fallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }, 2000);
      fallback.unref?.();
    })();
    return shutdownPromise;
  };

  const onSigint = () => void shutdown("Interrupt", "SIGINT");
  const onSigterm = () => void shutdown("Interrupt", "SIGTERM");
  const onSighup = () => void shutdown("Interrupt", "SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  process.stdin.once("end", () => void shutdown("Stop"));

  const closeResult = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  childLines.close();
  clientLines.close();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("SIGHUP", onSighup);

  if (requestedSignal) {
    process.exitCode = signalExitCode(requestedSignal);
  } else if (typeof closeResult.code === "number") {
    process.exitCode = closeResult.code;
  } else if (closeResult.signal && !shuttingDown) {
    process.exitCode = signalExitCode(closeResult.signal);
  } else {
    process.exitCode = 1;
  }

  return { runtime, closeResult };
}
