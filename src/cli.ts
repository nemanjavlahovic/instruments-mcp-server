/**
 * Interactive CLI mode for InstrumentsMCP.
 * Usage: instrumentsmcp record --process <name> [--template <template>] [--device <device>]
 *
 * Starts an xctrace recording and waits for Ctrl+C to stop.
 * Prints parsed results to stdout and saves the trace for re-analysis.
 */

import { spawnXctraceRecord } from "./utils/xctrace.js";
import { resolveDevice } from "./utils/simctl.js";
import { parseTraceByTemplate } from "./utils/parse-trace.js";

interface CliOptions {
  process?: string;
  launchPath?: string;
  template: string;
  device?: string;
}

export type ParseResult = { kind: "ok"; opts: CliOptions } | { kind: "help" } | { kind: "error"; message: string };

export function parseArgs(args: string[]): ParseResult {
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
        return { kind: "help" };
      default:
        if (arg.startsWith("-")) {
          return { kind: "error", message: `Unknown option: ${arg}` };
        }
    }
  }

  if (!opts.process && !opts.launchPath) {
    return { kind: "error", message: "Error: --process <name|PID> or --launch <path> is required." };
  }

  return { kind: "ok", opts };
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
  const result = parseArgs(args);
  if (result.kind === "help") {
    printUsage();
    process.exit(0);
  }
  if (result.kind === "error") {
    console.error(result.message + "\n");
    printUsage();
    process.exit(1);
  }

  const opts = result.opts;

  // Resolve device identifier to UDID for xctrace
  if (opts.device) {
    try {
      const sim = await resolveDevice(opts.device);
      opts.device = sim.udid;
    } catch {
      // If resolution fails (e.g., physical device), pass through as-is
    }
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

