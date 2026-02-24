# InstrumentsMCP

<p align="center">
  <img src="instruments-cover.png" alt="InstrumentsMCP" width="720" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/instrumentsmcp"><img src="https://img.shields.io/npm/v/instrumentsmcp" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-purple" alt="MCP"></a>
</p>

**AI-native performance profiling for iOS and macOS apps.**

InstrumentsMCP gives AI agents the ability to record Instruments traces while you use your app, parse the results, and tell you exactly what's slow — without you opening Instruments once.

> "Start profiling while I scroll the feed" → you scroll → "Stop" → structured findings with severity ratings → AI suggests the fix

## How It Works

### CLI Recording (Ctrl+C to stop)

The fastest way to profile. Open a terminal, run one command, use your app, hit Ctrl+C:

```bash
instrumentsmcp record --process MyApp --template "Time Profiler"
```

```
  Recording: Time Profiler
  Target:    MyApp

  Interact with your app. Press Ctrl+C to stop.

  ^C
  Stopping recording...
  Recording stopped (23.4s)

  {
    "hotspots": [
      { "function": "FeedViewModel.loadItems()", "selfPercent": 18.3, "severity": "critical" }
    ],
    "summary": "Hottest function: FeedViewModel.loadItems() (18.3% CPU)."
  }

  Trace saved: ~/.instruments-mcp/traces/profile-1234567890.trace
  Re-analyze: Tell your AI agent "Analyze the trace at ~/.instruments-mcp/traces/..."
```

No AI needed for timing — you control when to start and stop. Then feed the trace to your agent for deeper analysis and code fixes.

### Agent-Driven Profiling (start/stop via MCP)

The agent controls the recording while you interact with the app:

```
You:   "Start profiling my app for CPU while I test the feed"
Agent: calls start_profiling({ process: "MyApp", template: "Time Profiler" })
Agent: "Recording started. Go ahead — scroll, tap, navigate. Tell me when you're done."

... you scroll the feed, open a detail view, go back ...

You:   "Done"
Agent: calls stop_profiling()
Agent: "Found 3 issues:
        1. FeedViewModel.loadItems() — 18.3% CPU (critical)
        2. DateFormatter created on every cell (warning)
        3. CGPath recreation in card corners — 10K allocations in 15s (warning)"
```

The agent gets structured JSON with severity ratings and suggests code fixes — all from real usage, not an idle app sitting there doing nothing.

### Scenario Profiling (automated)

For repeatable tests, define a scenario with deep links and the agent drives the simulator while Instruments records:

```
You:   "Profile CPU while navigating through the onboarding flow"
Agent: calls profile_scenario({
         bundle_id: "com.example.MyApp",
         template: "Time Profiler",
         duration: "20s",
         scenario: [
           { action: "launch" },
           { action: "wait", seconds: 2 },
           { action: "open_url", url: "myapp://onboarding/step1" },
           { action: "wait", seconds: 3 },
           { action: "open_url", url: "myapp://onboarding/step2" },
           { action: "wait", seconds: 3 },
           { action: "screenshot", label: "step2" }
         ]
       })
```

Scenarios are deterministic — run the same flow before and after an optimization to measure the difference.

### One-Shot Profiling

For quick checks, every profiling tool works standalone:

```
You:   "Check my app for memory leaks"
Agent: calls profile_leaks({ process: "MyApp", duration: "30s" })
```

## What You Can Profile

| Tool | What It Finds | Severity Thresholds |
|---|---|---|
| `profile_cpu` | CPU hotspots, per-thread utilization, severity classification | >15% self-time critical, >8% warning |
| `profile_swiftui` | Excessive view body re-evaluations, slow view rendering | >100 evals or >50ms critical |
| `profile_memory` | Memory by category, persistent vs transient, largest allocators | >50MB or >100k allocs critical |
| `profile_hitches` | Animation hangs with backtraces and duration classification | >1s critical, >250ms warning |
| `profile_launch` | App launch time, phase breakdown, cold/warm/resume detection | >1s cold critical, >500ms warm critical |
| `profile_energy` | Energy impact scores (0–20), per-component breakdown, thermal state | Avg ≥13 or peak ≥20 critical |
| `profile_leaks` | Leaked objects by type, sizes, responsible libraries | >100 leaks or >10MB total critical |
| `profile_network` | HTTP traffic: request counts, durations, error rates, per-domain breakdown | >10% errors or >5s response critical |
| `performance_audit` | Combined CPU + Hitches + Leaks + Energy + Network health check | Worst severity across all five |
| `profile_raw` | Any template — raw table of contents for custom analysis | — |

## Simulator Control

InstrumentsMCP can interact with iOS Simulators directly — launch apps, navigate via deep links, take screenshots, send push notifications, and more. These tools work standalone or as building blocks for `profile_scenario`.

| Tool | What It Does |
|---|---|
| `sim_list_booted` | List running simulators and their installed apps |
| `sim_launch_app` | Launch an app by bundle ID, returns PID |
| `sim_terminate_app` | Terminate a running app |
| `sim_open_url` | Open a URL or deep link on the simulator |
| `sim_push_notification` | Send a simulated push notification |
| `sim_screenshot` | Capture the simulator screen as PNG |
| `sim_set_appearance` | Toggle light/dark mode |
| `sim_set_location` | Set simulated GPS coordinates |

> **Note:** `simctl` does not support tap/swipe gestures. Use deep links (`sim_open_url`) for navigation — your app must register URL schemes in Info.plist. For automated UI interaction, pair InstrumentsMCP with [XcodeBuildMCP](https://github.com/nicklanger/XcodeBuildMCP) which handles the build and run side.

## Example Output

<details>
<summary><b>CPU Profiling</b></summary>

```json
{
  "hotspots": [
    {
      "function": "FeedViewModel.loadItems()",
      "module": "MyApp",
      "selfPercent": 18.3,
      "totalPercent": 24.1,
      "severity": "critical"
    }
  ],
  "severity": "critical",
  "summary": "Hottest function: FeedViewModel.loadItems() (18.3% CPU). 3 user-code hotspots identified."
}
```

</details>

<details>
<summary><b>SwiftUI View Performance</b></summary>

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
  "summary": "847 total body evaluations across 23 views. 1 view with excessive re-evaluations: FeedCardView."
}
```

</details>

<details>
<summary><b>App Launch</b></summary>

```json
{
  "template": "App Launch",
  "totalLaunchMs": 1340,
  "launchType": "cold",
  "severity": "critical",
  "phases": [
    { "name": "Dynamic Library Loading", "durationMs": 580, "severity": "critical" },
    { "name": "UIKit Initialization", "durationMs": 310, "severity": "critical" },
    { "name": "Initial Frame Rendering", "durationMs": 290, "severity": "warning" }
  ],
  "summary": "App launch (cold): 1340ms — CRITICAL. Target: <400ms cold, <200ms warm."
}
```

</details>

<details>
<summary><b>Animation Hitches</b></summary>

```json
{
  "template": "Animation Hitches",
  "totalHangs": 3,
  "criticalHangs": 1,
  "warningHangs": 2,
  "summary": "3 hang events detected. 1 CRITICAL hang (>1s). 2 warning hangs (250ms-1s). Worst hang: 1240ms."
}
```

</details>

## All 29 Tools

### Interactive Profiling

| Tool | What It Does |
|---|---|
| `start_profiling` | Start recording a trace in the background — user interacts with the app manually |
| `stop_profiling` | Stop recording, parse the trace, return structured results |
| `profile_scenario` | Record a trace while executing a scripted scenario on a simulator |

### One-Shot Profiling

| Tool | Template | What It Returns |
|---|---|---|
| `profile_cpu` | Time Profiler | Top CPU hotspots, per-thread utilization, severity classification |
| `profile_swiftui` | SwiftUI | View body evaluation counts, excessive re-renders, duration per view |
| `profile_memory` | Allocations | Memory usage by category, persistent vs transient, largest allocators |
| `profile_hitches` | Animation Hitches | Hang events by severity with backtraces |
| `profile_launch` | App Launch | Launch time, phases, cold/warm/resume classification |
| `profile_energy` | Energy Log | Energy impact scores, component breakdown, thermal state |
| `profile_leaks` | Leaks | Leaked objects by type, sizes, responsible libraries |
| `profile_network` | Network | HTTP request counts, durations, error rates, per-domain breakdown |
| `profile_raw` | Any | Raw table of contents for templates without a dedicated parser |
| `performance_audit` | 5 templates | Combined CPU + Hitches + Leaks + Energy + Network health check |

### Simulator Control

| Tool | What It Does |
|---|---|
| `sim_list_booted` | List running simulators and installed apps |
| `sim_launch_app` | Launch app by bundle ID |
| `sim_terminate_app` | Terminate a running app |
| `sim_open_url` | Open a URL or deep link |
| `sim_push_notification` | Send a simulated push notification |
| `sim_screenshot` | Capture simulator screen |
| `sim_set_appearance` | Toggle light/dark mode |
| `sim_set_location` | Set simulated GPS coordinates |

### Analysis & Baselines

| Tool | What It Does |
|---|---|
| `analyze_trace` | Export specific tables from existing `.trace` files by xpath |
| `symbolicate_trace` | Add debug symbols so function names appear instead of addresses |
| `performance_baseline` | Save, compare, list, or delete performance baselines for regression tracking |
| `performance_report` | Generate shareable Markdown performance reports from profile results |

### Discovery

| Tool | What It Does |
|---|---|
| `instruments_status` | Check if `xctrace` is available and its version |
| `instruments_list_templates` | List all available profiling templates |
| `instruments_list_devices` | List connected devices and running simulators |
| `instruments_list_instruments` | List individual instruments |

## Setup

### Requirements

- macOS with Xcode installed (`xctrace` CLI)
- Node.js >= 20

### Claude Code

```bash
npx instrumentsmcp@latest
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "instruments": {
      "command": "npx",
      "args": ["-y", "instrumentsmcp@latest"]
    }
  }
}
```

### Cursor / Windsurf / Other MCP Clients

Use the same `npx` command in your client's MCP server settings.

### Install from Source

```bash
git clone https://github.com/nemanjavlahovic/instruments-mcp-server.git
cd instruments-mcp-server
npm install && npm run build
```

Then point your MCP client to `dist/index.js`.

### CLI Recording (no MCP client needed)

Record a trace from any terminal — no AI agent required:

```bash
npx instrumentsmcp record --process MyApp
npx instrumentsmcp record --process MyApp --template Allocations
npx instrumentsmcp record --process MyApp --device booted --template "Time Profiler"
```

Press Ctrl+C to stop. Results print to stdout, trace is saved for later re-analysis.

## Architecture

```
src/
├── index.ts              # MCP server entry point + CLI router
├── cli.ts                # Interactive CLI mode (instrumentsmcp record)
├── tools/
│   ├── profile.ts        # One-shot profiling tools (cpu, swiftui, memory, etc.)
│   ├── simulator.ts      # Simulator control + start/stop + scenario profiling
│   ├── analyze.ts        # Trace analysis + symbolication + performance audit
│   ├── baseline.ts       # Baseline comparison + Markdown report generation
│   └── list.ts           # Discovery tools (status, templates, devices)
├── parsers/              # Template-specific XML→JSON parsers with severity classification
│   ├── time-profiler.ts, swiftui.ts, allocations.ts, hangs.ts,
│   ├── app-launch.ts, energy.ts, leaks.ts, network.ts
└── utils/
    ├── xctrace.ts        # xctrace CLI wrapper (record, export, spawn, symbolicate)
    ├── simctl.ts         # simctl CLI wrapper (simulator interaction + device resolution)
    ├── trace-helpers.ts  # Shared xpath resolution and timing helpers
    ├── extractors.ts     # Shared XML row/field extractors
    └── xml.ts            # XML parsing (fast-xml-parser)
```

Each Instruments template has a dedicated parser with domain-specific heuristics. Severity thresholds are tuned per metric type. Traces are stored in `~/.instruments-mcp/traces/` for reuse and comparison.

## Compatibility

- Xcode Instruments (xctrace) 15.x through 26.x
- Handles xctrace 26 Deferred recording mode (automatic `time-sample` fallback)
- Retry logic for intermittent xctrace export failures
- Device identifiers (`booted`, device name, UDID) are automatically resolved to simulator UDIDs
- Simulator interaction requires a booted iOS Simulator

## License

MIT
