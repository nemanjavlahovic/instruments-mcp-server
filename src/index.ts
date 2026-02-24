#!/usr/bin/env node

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerListTools } from "./tools/list.js";
import { registerAnalyzeTools } from "./tools/analyze.js";
import { registerBaselineTools } from "./tools/baseline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));

const server = new McpServer({
  name: "InstrumentsMCP",
  version: pkg.version,
});

// Register all tool groups
registerProfileTools(server);
registerListTools(server);
registerAnalyzeTools(server);
registerBaselineTools(server);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
