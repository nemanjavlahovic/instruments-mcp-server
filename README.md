# instruments-mcp-server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)

MCP server that wraps Xcode Instruments (`xctrace`) to give AI agents readable performance profiling for iOS/macOS apps.

Instead of raw XML trace dumps, agents get structured JSON with severity classifications and actionable summaries.

## Why

Instruments produces massive XML exports that are impractical for AI agents to consume. This server:

- **Records** traces using any Instruments template (Time Profiler, SwiftUI, Allocations, Animation Hitches, etc.)
- **Parses** template-specific data with tuned heuristics per metric type
- **Classifies** findings by severity (ok / warning / critical) with domain-specific thresholds
- **Summarizes** results into concise, actionable text an agent can reason about

## Tools

### Profiling

| Tool | Template | Output |
|---|---|---|
| `profile_cpu` | Time Profiler | Top CPU hotspots, main thread blockers, per-thread utilization |
| `profile_swiftui` | SwiftUI | View body evaluation counts, excessive re-renders, duration per view |
| `profile_memory` | Allocations | Memory usage by category, persistent vs transient, largest allocators |
| `profile_hitches` | Animation Hitches | Hang events by severity (micro/minor/warning/critical) with backtraces |
| `profile_raw` | Any | Raw TOC for templates without a dedicated parser |
| `performance_audit` | Time Profiler + Hitches | Combined health check in one call |

### Analysis

| Tool | What it does |
|---|---|
| `analyze_trace` | Export specific tables from existing `.trace` files by xpath |
| `symbolicate_trace` | Add debug symbols so function names appear instead of addresses |

### Discovery

| Tool | What it does |
|---|---|
| `instruments_status` | Check if `xctrace` is available and its version |
| `instruments_list_templates` | List all available profiling templates |
| `instruments_list_devices` | List connected devices and running simulators |
| `instruments_list_instruments` | List individual instruments |

## Requirements

- macOS with Xcode installed (`xctrace` CLI)
- Node.js >= 20

## Quick Start

```bash
git clone https://github.com/nemanjavlahovic/instruments-mcp-server.git
cd instruments-mcp-server
npm install
npm run build
```

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "instruments": {
      "command": "node",
      "args": ["/path/to/instruments-mcp-server/dist/index.js"]
    }
  }
}
```

### Development

```json
{
  "mcpServers": {
    "instruments": {
      "command": "npx",
      "args": ["tsx", "/path/to/instruments-mcp-server/src/index.ts"]
    }
  }
}
```

## Example Output

### CPU Profiling

```json
{
  "template": "Time Profiler",
  "totalSamples": 4521,
  "hotspots": [
    {
      "function": "FeedViewModel.loadItems()",
      "module": "MyApp",
      "file": "FeedViewModel.swift",
      "selfPercent": 18.3,
      "totalPercent": 24.1
    }
  ],
  "mainThreadBlockers": [
    {
      "function": "JSONDecoder.decode()",
      "durationMs": 34,
      "severity": "warning"
    }
  ],
  "summary": "Hottest function: FeedViewModel.loadItems() (18.3% CPU). 5 user-code hotspots identified. 1 critical main-thread blockers found."
}
```

### SwiftUI View Performance

```json
{
  "template": "SwiftUI",
  "totalBodyEvaluations": 847,
  "excessiveEvaluations": [
    {
      "viewName": "FeedCardView",
      "evaluationCount": 156,
      "averageDurationUs": 420,
      "severity": "critical"
    }
  ],
  "summary": "847 total body evaluations across 23 views. 1 views with excessive re-evaluations: FeedCardView."
}
```

### Animation Hitches

```json
{
  "template": "Animation Hitches",
  "totalHangs": 3,
  "criticalHangs": 1,
  "warningHangs": 2,
  "summary": "3 hang events detected. 1 CRITICAL hangs (>1s). 2 warning hangs (250ms-1s). Worst hang: 1240ms."
}
```

## Architecture

```
src/
├── index.ts              # MCP server entry point
├── tools/
│   ├── profile.ts        # Recording tools (cpu, swiftui, memory, hitches, raw)
│   ├── analyze.ts        # Trace analysis + symbolication + performance audit
│   └── list.ts           # Discovery tools (status, templates, devices)
├── parsers/
│   ├── time-profiler.ts  # CPU hotspot extraction with caller aggregation
│   ├── swiftui.ts        # View body evaluation frequency analysis
│   ├── allocations.ts    # Memory allocation categorization
│   └── hangs.ts          # Hang/hitch severity classification
└── utils/
    ├── xctrace.ts        # xctrace CLI wrapper with retry logic
    └── xml.ts            # XML parsing (fast-xml-parser)
```

Each Instruments template has a dedicated parser with domain-specific heuristics. Severity thresholds are tuned per metric type (CPU %, memory MB, hang duration ms). Traces are stored in `~/.instruments-mcp/traces/` for reuse.

## Compatibility

- Tested with Xcode Instruments (xctrace) 15.x through 26.x
- Handles xctrace 26 Deferred recording mode (automatic `time-sample` fallback)
- Retry logic for intermittent xctrace export failures

## License

MIT
