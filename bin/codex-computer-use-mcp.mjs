#!/usr/bin/env node

import { runProxy } from "../src/proxy.mjs";

try {
  await runProxy();
} catch (error) {
  console.error(`[codex-computer-use-mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
