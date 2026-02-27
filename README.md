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

InstrumentsMCP gives AI agents the ability to record Instruments traces, automate simulator interaction, parse the results, and tell you exactly what's slow — without you opening Instruments once.

> "Profile CPU while scrolling the feed" → agent starts recording, taps through the app, scrolls the feed → stops → structured findings with severity ratings → AI suggests the fix

## How It Works

### Hands-Free Profiling (UI Automation + Instruments)

The agent records an Instruments trace while programmatically interacting with your app — no human interaction needed:

```
You:   "Profile CPU while scrolling through the feed and searching for users"
Agent: calls profile_scenario({
         bundle_id: "com.example.MyApp",
         template: "Time Profiler",
         duration: "20s",
         scenario: [
           { action: "launch" },
           { action: "wait", seconds: 2 },
           { action: "gesture", preset: "scroll-down" },
           { action: "wait", seconds: 1 },
           { action: "gesture", preset: "scroll-down" },
           { action: "tap", label: "Search" },
           { action: "type_text", text: "nema" },
           { action: "wait", seconds: 2 },
           { action: "snapshot_ui", label: "search-results" }
         ]
       })
Agent: "=== Time Profiler ===  severity: [WARNING]  samples: 1587

       Hotspots:
         UpdateStack::update() (AttributeGraph)  42.3ms self ━━━━━━╌╌╌╌╌╌╌╌╌ 12.1%
         FeedViewModel.loadItems() (MyApp)        28.1ms self ━━━━╌╌╌╌╌╌╌╌╌╌╌ 8.0%

       Main thread blockers:
         [WARNING] FeedViewModel.loadItems()  28.1ms

       trace: abc123 | path: ~/.instruments-mcp/traces/..."
```

UI automation is powered by [AXe CLI](https://github.com/cameroncooke/AXe) — tap, type, swipe, and read the accessibility hierarchy on any booted simulator.

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

  === Time Profiler ===  severity: [CRITICAL]  samples: 2341

  Hotspots:
    FeedViewModel.loadItems() (MyApp)  42.3ms self ━━━━━━━━━╌╌╌╌╌╌ 18.3%

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
| `profile_energy` | Energy impact scores (0-20), per-component breakdown, thermal state | Avg >=13 or peak >=20 critical |
| `profile_leaks` | Leaked objects by type, sizes, responsible libraries | >100 leaks or >10MB total critical |
| `profile_network` | HTTP traffic: request counts, durations, error rates, per-domain breakdown | >10% errors or >5s response critical |
| `performance_audit` | Combined CPU + Hitches + Leaks + Energy + Network health check | Worst severity across all five |
| `profile_raw` | Any template - raw table of contents for custom analysis | - |

## UI Automation

InstrumentsMCP can interact with simulator UI elements directly — tap buttons, type text, swipe, scroll, and read the accessibility hierarchy. These tools work standalone for UI testing or as steps in `profile_scenario` for hands-free performance profiling.

Requires [AXe CLI](https://github.com/cameroncooke/AXe): `brew tap cameroncooke/axe && brew install axe`

| Tool | What It Does |
|---|---|
| `ui_snapshot` | Get the accessibility hierarchy — element roles, labels, identifiers, and frame coordinates |
| `ui_tap` | Tap by accessibility id (most reliable), label, or x/y coordinates |
| `ui_type` | Type text into the currently focused field |
| `ui_swipe` | Swipe between two points |
| `ui_gesture` | Preset gestures: scroll-up/down/left/right, swipe-from-*-edge |
| `ui_long_press` | Touch-and-hold at coordinates |

The agent reads the screen with `ui_snapshot`, finds elements, and interacts with them — just like a human would, but programmatically.

## Simulator Control

InstrumentsMCP can manage iOS Simulators directly — launch apps, navigate via deep links, take screenshots, send push notifications, and more. These tools work standalone or as building blocks for `profile_scenario`.

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

## Example Output

<details>
<summary><b>CPU Profiling (compact text format)</b></summary>

```
=== Time Profiler ===  severity: [WARNING]  samples: 1587

Hotspots:
  UpdateStack::update() (AttributeGraph)  42.3ms self ━━━━━━╌╌╌╌╌╌╌╌╌ 12.1%
  FeedViewModel.loadItems() (MyApp)        28.1ms self ━━━━╌╌╌╌╌╌╌╌╌╌╌ 8.0%
  LayoutComputer::doAlignment() (SwiftUI)  15.2ms self ━━╌╌╌╌╌╌╌╌╌╌╌╌╌ 4.3%

Main thread blockers:
  [WARNING] FeedViewModel.loadItems()  28.1ms

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

</details>

<details>
<summary><b>SwiftUI View Performance</b></summary>

```
=== SwiftUI ===  severity: [WARNING]  total evals: 847  views: 23

Views:
  [CRITICAL] FeedCardView  x156  65.5ms
  [WARNING] AvatarView     x89   12.3ms
  [OK] HeaderView          x12   1.2ms

Excessive re-renders: 2 views flagged

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

</details>

<details>
<summary><b>App Launch</b></summary>

```
=== App Launch ===  severity: [CRITICAL]  total: 1340ms  type: cold

Phases:
  [CRITICAL] Dynamic Library Loading  580ms  ━━━━━━━━━━━━━━━
  [CRITICAL] UIKit Initialization     310ms  ━━━━━━━━╌╌╌╌╌╌╌
  [WARNING] Initial Frame Rendering   290ms  ━━━━━━━╌╌╌╌╌╌╌╌

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

</details>

<details>
<summary><b>Animation Hitches</b></summary>

```
=== Animation Hitches ===  severity: [CRITICAL]  total: 3 (1 critical, 2 warning, 0 minor, 0 micro)

Hang events:
  [CRITICAL] 1240ms  start: 5.2s
    stack: FeedViewModel.loadItems() > NetworkManager.fetch() > URLSession.data()
  [WARNING] 380ms  start: 12.1s

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

</details>

<details>
<summary><b>Memory Leaks</b></summary>

```
=== Leaks ===  severity: [WARNING]  total: 12 objects  4.8 KB

Leak groups:
  [WARNING] NSMutableArray (Foundation)  x5  2.1 KB
  [minor] ClosureContext (MyApp)         x4  1.6 KB
  [minor] NSObject (CoreFoundation)      x3  1.1 KB

By library:
  Foundation  5 leaks  2.1 KB
  MyApp       4 leaks  1.6 KB

trace: abc123 | path: ~/.instruments-mcp/traces/profile-1234567890.trace
```

</details>

## All 35 Tools

### Interactive Profiling

| Tool | What It Does |
|---|---|
| `start_profiling` | Start recording a trace in the background - user interacts with the app manually |
| `stop_profiling` | Stop recording, parse the trace, return structured results |
| `profile_scenario` | Record a trace while executing a scripted scenario (deep links + UI automation) |

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

### UI Automation

| Tool | What It Does |
|---|---|
| `ui_snapshot` | Get accessibility hierarchy - element roles, labels, identifiers, frame coordinates |
| `ui_tap` | Tap by accessibility id, label, or x/y coordinates |
| `ui_type` | Type text into focused field |
| `ui_swipe` | Swipe between two points |
| `ui_gesture` | Preset gestures (scroll, edge swipes) |
| `ui_long_press` | Touch-and-hold at coordinates |

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

### Analysis & Investigation

| Tool | What It Does |
|---|---|
| `analyze_trace` | Export specific tables from existing `.trace` files by xpath |
| `drill_down` | Drill into a specific function, domain, or view from a previous profile result |
| `list_traces` | List recently profiled traces available for re-analysis |
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
- **Optional**: [AXe CLI](https://github.com/cameroncooke/AXe) for UI automation (`brew tap cameroncooke/axe && brew install axe`)

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

Record a trace from any terminal - no AI agent required:

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
│   ├── investigate.ts    # Drill-down into specific functions/views + trace listing
│   ├── ui.ts             # UI automation tools (snapshot, tap, type, swipe, gesture)
│   └── list.ts           # Discovery tools (status, templates, devices)
├── parsers/              # Template-specific XML→JSON parsers with severity classification
│   ├── time-profiler.ts, swiftui.ts, allocations.ts, hangs.ts,
│   ├── app-launch.ts, energy.ts, leaks.ts, network.ts
└── utils/
    ├── xctrace.ts        # xctrace CLI wrapper (record, export, spawn, symbolicate)
    ├── simctl.ts         # simctl CLI wrapper (simulator interaction + device resolution)
    ├── axe.ts            # AXe CLI wrapper (UI automation — tap, type, swipe, describe)
    ├── trace-helpers.ts  # Shared xpath resolution and timing helpers
    ├── trace-store.ts    # In-memory trace store for multi-turn investigation
    ├── parse-trace.ts    # Template→parser routing (shared by CLI, tools, scenario)
    ├── format-output.ts  # Compact text formatters for LLM-friendly output
    ├── auto-investigate.ts # Pre-computed investigation findings from profile results
    ├── extractors.ts     # Shared XML row/field extractors
    └── xml.ts            # XML parsing (fast-xml-parser)
```

Each Instruments template has a dedicated parser with domain-specific heuristics. Severity thresholds are tuned per metric type. Profile results use compact text formatting (~80% smaller than JSON) optimized for LLM context windows. Traces are stored in `~/.instruments-mcp/traces/` for reuse and comparison.

## Compatibility

- Xcode Instruments (xctrace) 15.x through 26.x
- Handles xctrace 26 Deferred recording mode (automatic `time-sample` fallback)
- Retry logic for intermittent xctrace export failures
- Device identifiers (`booted`, device name, UDID) are automatically resolved to simulator UDIDs
- Simulator interaction requires a booted iOS Simulator
- UI automation requires [AXe CLI](https://github.com/cameroncooke/AXe) (graceful degradation with install instructions if missing)

## License

MIT
