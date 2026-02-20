# instruments-mcp-server

MCP server that wraps Apple Instruments (`xctrace`) to give AI agents readable performance profiling for iOS/macOS apps.

Instead of raw XML trace dumps, agents get structured JSON with actionable summaries.

## Tools

| Tool | What it does |
|---|---|
| `profile_cpu` | Time Profiler → top CPU hotspots, main thread blockers |
| `profile_swiftui` | SwiftUI template → view body evaluation counts and durations |
| `profile_memory` | Allocations → memory usage by category, largest allocators |
| `profile_hitches` | Animation Hitches → hang events by severity with backtraces |
| `profile_raw` | Any template → raw TOC for further analysis |
| `performance_audit` | Combined CPU + hitches audit in one call |
| `analyze_trace` | Drill into existing .trace files by xpath |
| `symbolicate_trace` | Add debug symbols to trace files |
| `instruments_status` | Check xctrace availability |
| `instruments_list_templates` | List available profiling templates |
| `instruments_list_devices` | List devices and simulators |
| `instruments_list_instruments` | List individual instruments |

## Requirements

- macOS with Xcode installed (`xctrace` CLI)
- Node.js >= 20

## Setup

```bash
npm install
npm run build
```

## Usage with Claude Code

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

Or run in dev mode:

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

## Example Agent Output

```json
{
  "template": "Time Profiler",
  "totalSamples": 4521,
  "hotspots": [
    {
      "function": "FeedViewModel.loadItems()",
      "module": "rmoir-ios",
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
