/**
 * Interactive CLI mode for InstrumentsMCP.
 * Usage: instrumentsmcp record --process <name> [--template <template>] [--device <device>]
 *
 * Starts an xctrace recording and waits for Ctrl+C to stop.
 * Prints parsed results to stdout and saves the trace for re-analysis.
 */

import { spawnXctraceRecord, xctraceExport } from "./utils/xctrace.js";
import { findTableXpath, findTrackXpath } from "./utils/trace-helpers.js";

interface CliOptions {
  process?: string;
  launchPath?: string;
  template: string;
  device?: string;
}

function parseArgs(args: string[]): CliOptions | null {
  const opts: CliOptions = { template: "Time Profiler" };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--process":
      case "-p":
        opts.process = next;
        i++;
        break;
      case "--template":
      case "-t":
        opts.template = next;
        i++;
        break;
      case "--device":
      case "-d":
        opts.device = next;
        i++;
        break;
      case "--launch":
      case "-l":
        opts.launchPath = next;
        i++;
        break;
      case "--help":
      case "-h":
        return null;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          return null;
        }
    }
  }

  if (!opts.process && !opts.launchPath) {
    console.error("Error: --process <name|PID> or --launch <path> is required.\n");
    return null;
  }

  return opts;
}

function printUsage(): void {
  console.log(`
Usage: instrumentsmcp record [options]

Start an interactive Instruments recording. Press Ctrl+C to stop.

Options:
  -p, --process <name|PID>    Process name or PID to attach to (required unless --launch)
  -l, --launch <path>         Path to .app bundle to launch and profile
  -t, --template <name>       Instruments template (default: "Time Profiler")
  -d, --device <name|UDID>    Device name or UDID (omit for host Mac, "booted" for simulator)
  -h, --help                  Show this help

Examples:
  instrumentsmcp record --process MyApp
  instrumentsmcp record --process MyApp --template Allocations
  instrumentsmcp record --process MyApp --device "iPhone 16 Pro" --template "Animation Hitches"
  instrumentsmcp record --launch /path/to/MyApp.app --template "App Launch"
`.trim());
}

export async function runInteractiveRecord(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (!opts) {
    printUsage();
    process.exit(1);
  }

  const target = opts.process || opts.launchPath || "unknown";
  console.log(`\n  Recording: ${opts.template}`);
  console.log(`  Target:    ${target}`);
  if (opts.device) console.log(`  Device:    ${opts.device}`);
  console.log(`\n  Interact with your app. Press Ctrl+C to stop.\n`);

  const recording = spawnXctraceRecord({
    template: opts.template,
    attachProcess: opts.process,
    launchPath: opts.launchPath,
    device: opts.device,
    timeLimit: "10m",
  });

  // Forward xctrace stderr to show recording status
  recording.childProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.log(`  [xctrace] ${msg}`);
  });

  // Handle Ctrl+C gracefully
  let stopped = false;
  const stopRecording = async () => {
    if (stopped) return;
    stopped = true;

    console.log("\n  Stopping recording...");
    recording.childProcess.kill("SIGINT");

    const { tracePath } = await recording.completion;
    const elapsed = ((Date.now() - recording.startTime) / 1000).toFixed(1);

    console.log(`  Recording stopped (${elapsed}s)\n`);
    console.log(`  Trace: ${tracePath}`);

    // Parse results
    console.log("  Parsing...\n");
    try {
      const results = await parseTraceByTemplate(tracePath, opts.template);
      console.log(JSON.stringify(results, null, 2));
    } catch (e) {
      console.error(`  Parse error: ${e}`);
    }

    console.log(`\n  Trace saved: ${tracePath}`);
    console.log(`  Re-analyze: Tell your AI agent "Analyze the trace at ${tracePath}"\n`);

    process.exit(0);
  };

  process.on("SIGINT", stopRecording);
  process.on("SIGTERM", stopRecording);

  // Wait for recording to finish (time limit or signal)
  try {
    const { tracePath } = await recording.completion;
    if (!stopped) {
      const elapsed = ((Date.now() - recording.startTime) / 1000).toFixed(1);
      console.log(`\n  Time limit reached (${elapsed}s)\n`);
      console.log(`  Trace: ${tracePath}`);

      console.log("  Parsing...\n");
      try {
        const results = await parseTraceByTemplate(tracePath, opts.template);
        console.log(JSON.stringify(results, null, 2));
      } catch (e) {
        console.error(`  Parse error: ${e}`);
      }

      console.log(`\n  Trace saved: ${tracePath}`);
      console.log(`  Re-analyze: Tell your AI agent "Analyze the trace at ${tracePath}"\n`);
    }
  } catch (e) {
    console.error(`Recording failed: ${e}`);
    process.exit(1);
  }
}

// ── Template → Parser routing (reused from simulator.ts) ──────────

async function parseTraceByTemplate(tracePath: string, template: string): Promise<Record<string, unknown>> {
  const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });
  const t = template.toLowerCase();

  if (t.includes("time profiler") || t.includes("time-profiler")) {
    const { parseTimeProfiler } = await import("./parsers/time-profiler.js");
    const profileXpath = findTableXpath(tocXml, "time-profile");
    const tableXml = profileXpath ? await xctraceExport({ inputPath: tracePath, xpath: profileXpath }) : tocXml;
    let result = parseTimeProfiler(tocXml, tableXml);
    if (result.totalSamples < 10) {
      const sampleXpath = findTableXpath(tocXml, "time-sample");
      if (sampleXpath) {
        const sampleXml = await xctraceExport({ inputPath: tracePath, xpath: sampleXpath });
        const sampleResult = parseTimeProfiler(tocXml, sampleXml);
        if (sampleResult.totalSamples > result.totalSamples) result = sampleResult;
      }
    }
    return result as unknown as Record<string, unknown>;
  }

  if (t.includes("swiftui")) {
    const { parseSwiftUI } = await import("./parsers/swiftui.js");
    const xpath = findTableXpath(tocXml, "view-body") || findTableXpath(tocXml, "swiftui");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseSwiftUI(tocXml, tableXml) as unknown as Record<string, unknown>;
  }

  if (t.includes("alloc")) {
    const { parseAllocations } = await import("./parsers/allocations.js");
    const xpath = findTableXpath(tocXml, "alloc");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseAllocations(tocXml, tableXml) as unknown as Record<string, unknown>;
  }

  if (t.includes("hitch") || t.includes("animation")) {
    const { parseHangs } = await import("./parsers/hangs.js");
    const xpath = findTableXpath(tocXml, "hang") || findTableXpath(tocXml, "hitch");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseHangs(tocXml, tableXml) as unknown as Record<string, unknown>;
  }

  if (t.includes("launch") || t.includes("app launch")) {
    const { parseAppLaunch } = await import("./parsers/app-launch.js");
    const xpath =
      findTableXpath(tocXml, "app-launch") ||
      findTableXpath(tocXml, "lifecycle") ||
      findTableXpath(tocXml, "os-signpost") ||
      findTableXpath(tocXml, "signpost");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseAppLaunch(tocXml, tableXml) as unknown as Record<string, unknown>;
  }

  if (t.includes("energy")) {
    const { parseEnergy } = await import("./parsers/energy.js");
    const xpath =
      findTableXpath(tocXml, "energy") ||
      findTableXpath(tocXml, "power") ||
      findTableXpath(tocXml, "battery") ||
      findTableXpath(tocXml, "diagnostics");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseEnergy(tocXml, tableXml) as unknown as Record<string, unknown>;
  }

  if (t.includes("leak")) {
    const { parseLeaks } = await import("./parsers/leaks.js");
    const xpath =
      findTableXpath(tocXml, "leak") ||
      findTrackXpath(tocXml, "leak") ||
      findTableXpath(tocXml, "alloc");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseLeaks(tocXml, tableXml) as unknown as Record<string, unknown>;
  }

  if (t.includes("network")) {
    const { parseNetwork } = await import("./parsers/network.js");
    const xpath =
      findTableXpath(tocXml, "http") ||
      findTableXpath(tocXml, "network") ||
      findTrackXpath(tocXml, "http") ||
      findTrackXpath(tocXml, "network");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseNetwork(tocXml, tableXml) as unknown as Record<string, unknown>;
  }

  return {
    template,
    toc: tocXml,
    hint: "No dedicated parser for this template. Use analyze_trace with the tracePath to drill into specific tables.",
  };
}
