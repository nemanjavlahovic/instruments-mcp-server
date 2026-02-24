#!/usr/bin/env node

// Route to interactive CLI mode if invoked with 'record' subcommand
if (process.argv[2] === "record") {
  const { runInteractiveRecord } = await import("./cli.js");
  await runInteractiveRecord(process.argv.slice(3));
} else {
  // MCP server mode (default — used by Claude Code, Cursor, etc.)
  const { readFileSync } = await import("fs");
  const { fileURLToPath } = await import("url");
  const { dirname, resolve } = await import("path");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { registerProfileTools } = await import("./tools/profile.js");
  const { registerListTools } = await import("./tools/list.js");
  const { registerAnalyzeTools } = await import("./tools/analyze.js");
  const { registerBaselineTools } = await import("./tools/baseline.js");
  const { registerSimulatorTools } = await import("./tools/simulator.js");

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
  registerSimulatorTools(server);

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
