#!/usr/bin/env node
import { runHttpServer } from "./http.js";

void runHttpServer().catch((error) => {
  console.error("Failed to start Paperclip MCP HTTP server:", error);
  process.exit(1);
});
