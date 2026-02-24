#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerListTools } from "./tools/list.js";
import { registerAnalyzeTools } from "./tools/analyze.js";
import { registerBaselineTools } from "./tools/baseline.js";

const server = new McpServer({
  name: "InstrumentsMCP",
  version: "0.1.0",
});

// Register all tool groups
registerProfileTools(server);
registerListTools(server);
registerAnalyzeTools(server);
registerBaselineTools(server);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
