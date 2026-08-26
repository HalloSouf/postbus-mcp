#!/usr/bin/env node
import { PostbusError } from "./types.js";

// Imported inside the try on purpose. Config and crypto validate at module
// scope, and ESM evaluates a static import before any of this file's body
// runs — so PORT=abc used to produce a bare stack trace and never reached the
// message below.
try {
  const { main } = await import("./main.js");
  main();
} catch (error) {
  if (error instanceof PostbusError) {
    console.error(`postbus-mcp could not start: ${error.message}`);
    if (error.hint) console.error(`Tip: ${error.hint}`);
  } else {
    console.error("postbus-mcp could not start:", error);
  }
  process.exit(1);
}
