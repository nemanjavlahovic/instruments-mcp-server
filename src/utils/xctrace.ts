import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const XCTRACE_PATH = "/usr/bin/xctrace";
const TRACE_OUTPUT_DIR = join(process.env.HOME ?? "/tmp", ".instruments-mcp", "traces");

export interface RecordOptions {
  template: string;
  device?: string;
  timeLimit: string;
  attachProcess?: string;
  launchPath?: string;
  outputPath?: string;
  allProcesses?: boolean;
}

export interface ExportOptions {
  inputPath: string;
  xpath?: string;
  toc?: boolean;
}

/**
 * Ensure xctrace is available on this system.
 */
export async function verifyXctrace(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const { stdout } = await execFileAsync(XCTRACE_PATH, ["version"]);
    return { available: true, version: stdout.trim() };
  } catch (e) {
    return {
      available: false,
      error: `xctrace not found at ${XCTRACE_PATH}. Requires macOS with Xcode installed.`,
    };
  }
}

/**
 * List available templates, devices, or instruments.
 */
export async function xctraceList(
  kind: "templates" | "devices" | "instruments"
): Promise<string> {
  const { stdout } = await execFileAsync(XCTRACE_PATH, ["list", kind], {
    timeout: 30_000,
  });
  return stdout;
}

/**
 * Record a trace using xctrace.
 */
export async function xctraceRecord(options: RecordOptions): Promise<{ tracePath: string; stdout: string; stderr: string }> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(TRACE_OUTPUT_DIR, { recursive: true });

  const outputPath = options.outputPath ?? join(TRACE_OUTPUT_DIR, `profile-${Date.now()}.trace`);

  const args: string[] = [
    "record",
    "--template", options.template,
    "--time-limit", options.timeLimit,
    "--output", outputPath,
    "--no-prompt",
  ];

  if (options.device) {
    args.push("--device", options.device);
  }

  if (options.allProcesses) {
    args.push("--all-processes");
  } else if (options.attachProcess) {
    args.push("--attach", options.attachProcess);
  } else if (options.launchPath) {
    args.push("--launch", "--", options.launchPath);
  } else {
    args.push("--all-processes");
  }

  const timeLimitMs = parseTimeLimitToMs(options.timeLimit);
  const timeout = timeLimitMs + 30_000; // extra 30s buffer for startup/teardown

  const { stdout, stderr } = await execFileAsync(XCTRACE_PATH, args, { timeout });

  return { tracePath: outputPath, stdout, stderr };
}

/**
 * Spawn xctrace record as a long-running process.
 * Returns immediately with a handle to stop the recording later via SIGINT.
 * Used by start_profiling/stop_profiling for user-controlled recording sessions.
 */
export interface ActiveRecording {
  childProcess: ChildProcess;
  tracePath: string;
  template: string;
  startTime: number;
  completion: Promise<{ tracePath: string; stdout: string; stderr: string }>;
}

export function spawnXctraceRecord(options: RecordOptions): ActiveRecording {
  mkdirSync(TRACE_OUTPUT_DIR, { recursive: true });

  const outputPath = options.outputPath ?? join(TRACE_OUTPUT_DIR, `profile-${Date.now()}.trace`);

  const args: string[] = [
    "record",
    "--template", options.template,
    "--time-limit", options.timeLimit,
    "--output", outputPath,
    "--no-prompt",
  ];

  if (options.device) {
    args.push("--device", options.device);
  }

  if (options.allProcesses) {
    args.push("--all-processes");
  } else if (options.attachProcess) {
    args.push("--attach", options.attachProcess);
  } else if (options.launchPath) {
    args.push("--launch", "--", options.launchPath);
  } else {
    args.push("--all-processes");
  }

  const child = spawn(XCTRACE_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

  const completion = new Promise<{ tracePath: string; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("close", () => {
      resolve({ tracePath: outputPath, stdout, stderr });
    });
    child.on("error", (err) => {
      reject(err);
    });
  });

  return {
    childProcess: child,
    tracePath: outputPath,
    template: options.template,
    startTime: Date.now(),
    completion,
  };
}

/**
 * Export trace data as XML.
 * Retries on intermittent "Document Missing Template Error" (xctrace 26+).
 */
export async function xctraceExport(options: ExportOptions): Promise<string> {
  const args: string[] = ["export", "--input", options.inputPath];

  if (options.toc) {
    args.push("--toc");
  } else if (options.xpath) {
    args.push("--xpath", options.xpath);
  }

  const maxRetries = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(XCTRACE_PATH, args, {
        timeout: 120_000,
        maxBuffer: 50 * 1024 * 1024,
      });

      // Verify we got valid XML output (not just an error message)
      if (stdout.includes("<?xml") || stdout.includes("<trace-")) {
        return stdout;
      }

      // xctrace sometimes writes errors to stdout instead of failing
      lastError = new Error(stderr || stdout || "Empty export output");
    } catch (e) {
      lastError = e;
    }

    // Brief pause before retry
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }

  throw lastError;
}

/**
 * Symbolicate a trace file.
 */
export async function xctraceSymbolicate(
  inputPath: string,
  dsymPath?: string
): Promise<string> {
  const args: string[] = ["symbolicate", "--input", inputPath];
  if (dsymPath) {
    args.push("--dsym", dsymPath);
  }

  const { stdout } = await execFileAsync(XCTRACE_PATH, args, { timeout: 120_000 });
  return stdout;
}

function parseTimeLimitToMs(timeLimit: string): number {
  const match = timeLimit.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) return 60_000; // default 1 minute

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    default: return 60_000;
  }
}

export function getTraceOutputDir(): string {
  return TRACE_OUTPUT_DIR;
}
