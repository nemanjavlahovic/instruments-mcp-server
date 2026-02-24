# InstrumentsMCP

## What This Is
AI-native performance profiling for iOS and macOS apps. Wraps Xcode Instruments (`xctrace` CLI) as an MCP server, parsing trace data into structured JSON with severity classifications and actionable summaries.

## Architecture
- **src/index.ts** - MCP server entry point, registers all tools
- **src/tools/** - Tool definitions (profile, list, analyze)
- **src/parsers/** - Template-specific XML→JSON parsers (time-profiler, swiftui, allocations, hangs, app-launch)
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

## xctrace Compatibility
- xctrace 26+ uses Deferred recording mode by default — `time-profile` table may be empty
- `profile_cpu` and `performance_audit` fall back to `time-sample` table automatically
- `xctraceExport` retries up to 5 times for intermittent "Document Missing Template Error"
- XML parser `isArray` config wraps `node`, `row`, `frame`, `backtrace` etc. in arrays — always unwrap [0]
- xctrace 26 backtrace frames use `@_name` for function names and nested `binary.@_name` for module

## Tech Stack
- TypeScript, Node.js >= 20, ESM modules
- @modelcontextprotocol/sdk for MCP protocol
- fast-xml-parser for XML→JS conversion
- zod for tool parameter schemas
