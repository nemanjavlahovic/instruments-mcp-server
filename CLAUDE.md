# instruments-mcp-server

## What This Is
An MCP server that wraps Apple's `xctrace` CLI (Instruments) to provide AI-readable performance profiling for iOS/macOS apps. Instead of dumping raw XML, it parses trace data into structured JSON with severity classifications and actionable summaries.

## Architecture
- **src/index.ts** - MCP server entry point, registers all tools
- **src/tools/** - Tool definitions (profile, list, analyze)
- **src/parsers/** - Template-specific XML→JSON parsers (time-profiler, swiftui, allocations, hangs)
- **src/utils/xctrace.ts** - Low-level xctrace CLI wrapper
- **src/utils/xml.ts** - XML parsing with fast-xml-parser

## Key Design Decisions
- Each Instruments template has its own parser with domain-specific heuristics
- Severity classification (ok/warning/critical) uses tuned thresholds per metric type
- The `profile_raw` + `analyze_trace` combo handles any template without a dedicated parser
- Traces are stored in `~/.instruments-mcp/traces/` with timestamps

## Adding New Parsers
1. Create `src/parsers/<template-name>.ts`
2. Export a parse function that takes TOC XML + table XML and returns structured data
3. Add a dedicated `profile_<name>` tool in `src/tools/profile.ts`
4. Include severity classification and a text summary

## Tech Stack
- TypeScript, Node.js >= 20, ESM modules
- @modelcontextprotocol/sdk for MCP protocol
- fast-xml-parser for XML→JS conversion
- zod for tool parameter schemas
