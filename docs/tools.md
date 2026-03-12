# All 35 Tools

## Interactive Profiling

| Tool | What It Does |
|---|---|
| `start_profiling` | Start recording a trace in the background — you interact with the app manually |
| `stop_profiling` | Stop recording, parse the trace, return structured results |
| `profile_scenario` | Record a trace while executing a scripted UI scenario |

## One-Shot Profiling

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

## UI Automation

Requires [AXe CLI](https://github.com/cameroncooke/AXe). Install: `brew tap cameroncooke/axe && brew install axe`

| Tool | What It Does |
|---|---|
| `ui_snapshot` | Get accessibility hierarchy — element roles, labels, identifiers, frame coordinates |
| `ui_tap` | Tap by accessibility id, label, or x/y coordinates |
| `ui_type` | Type text into focused field |
| `ui_swipe` | Swipe between two points |
| `ui_gesture` | Preset gestures (scroll, edge swipes) |
| `ui_long_press` | Touch-and-hold at coordinates |

## Simulator Control

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

## Analysis & Investigation

| Tool | What It Does |
|---|---|
| `analyze_trace` | Export specific tables from existing `.trace` files by xpath |
| `drill_down` | Drill into a specific function, domain, or view from a previous profile result |
| `list_traces` | List recently profiled traces available for re-analysis |
| `symbolicate_trace` | Add debug symbols so function names appear instead of addresses |
| `performance_baseline` | Save, compare, list, or delete performance baselines for regression tracking |
| `performance_report` | Generate shareable Markdown performance reports from profile results |

## Discovery

| Tool | What It Does |
|---|---|
| `instruments_status` | Check if `xctrace` is available and its version |
| `instruments_list_templates` | List all available profiling templates |
| `instruments_list_devices` | List connected devices and running simulators |
| `instruments_list_instruments` | List individual instruments |
