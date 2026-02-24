import { parseXml } from "../utils/xml.js";
import { extractRows, extractStr, extractFmt, extractNum, isRow, type Row } from "../utils/extractors.js";

export interface CpuHotspot {
  function: string;
  module: string;
  file?: string;
  line?: number;
  selfWeight: number;
  totalWeight: number;
  selfPercent: number;
  totalPercent: number;
}

export interface ThreadSummary {
  name: string;
  sampleCount: number;
  runningCount: number;
  blockedCount: number;
  utilizationPercent: number;
}

export interface TimeProfileResult {
  template: "Time Profiler";
  totalSamples: number;
  duration: string;
  hotspots: CpuHotspot[];
  threads?: ThreadSummary[];
  mainThreadBlockers: Array<{
    function: string;
    durationMs: number;
    severity: "info" | "warning" | "critical";
  }>;
  summary: string;
  needsSymbolication?: boolean;
}

/**
 * Parse Time Profiler trace export XML into a structured result.
 * Handles both `time-profile` (aggregated) and `time-sample` (raw) schemas.
 */
export function parseTimeProfiler(tocXml: string, tableXml: string): TimeProfileResult {
  const tableData = parseXml(tableXml);
  const rows = extractRows(tableData);

  if (rows.length === 0) {
    return {
      template: "Time Profiler",
      totalSamples: 0,
      duration: "unknown",
      hotspots: [],
      mainThreadBlockers: [],
      summary: "No profiling samples captured. The app may have been idle during recording.",
    };
  }

  // Detect format: time-profile has `weight` and `backtrace` (with function names)
  // time-sample has `kperf-bt` (raw addresses) and no `weight`
  const firstRow = rows[0];
  const hasAggregatedData = firstRow && ("weight" in firstRow || "backtrace" in firstRow);
  const isTimeSampleFormat = !hasAggregatedData && firstRow && ("kperf-bt" in firstRow || "time-sample-kind" in firstRow);

  if (isTimeSampleFormat) {
    return parseTimeSamples(rows);
  }

  return parseAggregatedProfile(rows);
}

/**
 * Parse aggregated time-profile table (has function names, weights).
 */
function parseAggregatedProfile(rows: Row[]): TimeProfileResult {
  const totalSamples = rows.length;

  const functionWeights = new Map<string, { self: number; total: number; module: string; file?: string; line?: number }>();

  for (const row of rows) {
    const weight = extractWeightMs(row) || 1;
    const frames = extractBacktraceFrames(row);

    if (frames.length > 0) {
      const topFrame = frames[0];
      const existing = functionWeights.get(topFrame.name);
      if (existing) {
        existing.self += weight;
        existing.total += weight;
      } else {
        functionWeights.set(topFrame.name, { self: weight, total: weight, module: topFrame.binary, file: topFrame.file, line: topFrame.line });
      }

      for (let i = 1; i < frames.length; i++) {
        const callerFn = frames[i].name;
        const callerExisting = functionWeights.get(callerFn);
        if (callerExisting) {
          callerExisting.total += weight;
        } else {
          functionWeights.set(callerFn, { self: 0, total: weight, module: frames[i].binary });
        }
      }
    } else {
      // Fallback: try flat row keys (older xctrace format)
      const fn = extractFmt(row, "symbol") || extractFmt(row, "name") || extractStr(row, "symbol") || extractStr(row, "name") || "unknown";
      const mod = extractFmt(row, "binary") || extractFmt(row, "library") || extractStr(row, "binary") || extractStr(row, "library") || "unknown";
      const file = extractStr(row, "source-path") || undefined;
      const line = extractNum(row, "source-line") || undefined;

      const existing = functionWeights.get(fn);
      if (existing) {
        existing.self += weight;
        existing.total += weight;
      } else {
        functionWeights.set(fn, { self: weight, total: weight, module: mod, file, line });
      }
    }
  }

  const sorted = [...functionWeights.entries()]
    .sort((a, b) => b[1].self - a[1].self)
    .slice(0, 20);

  const totalWeight = [...functionWeights.values()].reduce((sum, v) => sum + v.self, 0);

  const hotspots: CpuHotspot[] = sorted.map(([fn, data]) => ({
    function: fn,
    module: data.module,
    file: data.file,
    line: data.line,
    selfWeight: data.self,
    totalWeight: data.total,
    selfPercent: totalWeight > 0 ? Math.round((data.self / totalWeight) * 1000) / 10 : 0,
    totalPercent: totalWeight > 0 ? Math.round((data.total / totalWeight) * 1000) / 10 : 0,
  }));

  const mainThreadBlockers = hotspots
    .filter((h) => h.selfPercent > 5 && !isSystemFrame(h.function))
    .map((h) => ({
      function: h.function,
      durationMs: Math.round(h.selfWeight),
      severity: (h.selfPercent > 15 ? "critical" : h.selfPercent > 8 ? "warning" : "info") as "info" | "warning" | "critical",
    }));

  return {
    template: "Time Profiler",
    totalSamples,
    duration: "unknown",
    hotspots,
    mainThreadBlockers,
    summary: buildSummary(hotspots, mainThreadBlockers),
  };
}

/**
 * Parse raw time-sample table (xctrace 26+ Deferred mode).
 */
function parseTimeSamples(rows: Row[]): TimeProfileResult {
  const totalSamples = rows.length;
  const threadMap = new Map<string, { samples: number; running: number; blocked: number }>();
  let mainThreadSamples = 0;
  let mainThreadBlocked = 0;

  for (const row of rows) {
    const threadName = extractFmt(row, "thread") || "unknown thread";
    const state = extractFmt(row, "thread-state") || "";
    const isBlocked = state.toLowerCase().includes("blocked");
    const isMainThread = threadName.toLowerCase().includes("main thread");

    const existing = threadMap.get(threadName);
    if (existing) {
      existing.samples += 1;
      if (isBlocked) existing.blocked += 1;
      else existing.running += 1;
    } else {
      threadMap.set(threadName, { samples: 1, running: isBlocked ? 0 : 1, blocked: isBlocked ? 1 : 0 });
    }

    if (isMainThread) {
      mainThreadSamples++;
      if (isBlocked) mainThreadBlocked++;
    }
  }

  const threads: ThreadSummary[] = [...threadMap.entries()]
    .map(([name, data]) => ({
      name,
      sampleCount: data.samples,
      runningCount: data.running,
      blockedCount: data.blocked,
      utilizationPercent: data.samples > 0 ? Math.round((data.running / data.samples) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.sampleCount - a.sampleCount);

  const parts: string[] = [];
  parts.push(`${totalSamples} CPU samples across ${threads.length} threads`);

  const mainThread = threads.find((t) => t.name.toLowerCase().includes("main thread"));
  if (mainThread) {
    parts.push(`Main thread: ${mainThread.utilizationPercent}% active (${mainThread.runningCount} running, ${mainThread.blockedCount} blocked)`);
    if (mainThreadBlocked > mainThreadSamples * 0.8) {
      parts.push("Main thread mostly idle — app was not under load during recording");
    }
  }

  const busyThreads = threads.filter((t) => t.utilizationPercent > 50 && !t.name.toLowerCase().includes("main thread"));
  if (busyThreads.length > 0) {
    parts.push(`Active background threads: ${busyThreads.map((t) => `${t.name.split(" ")[0]}(${t.utilizationPercent}%)`).join(", ")}`);
  }

  parts.push("Note: Raw sample data — use symbolicate_trace with dSYMs for function-level detail");

  return {
    template: "Time Profiler",
    totalSamples,
    duration: "unknown",
    hotspots: [],
    threads,
    mainThreadBlockers: [],
    summary: parts.join(". ") + ".",
    needsSymbolication: true,
  };
}

// ── Time Profiler specific helpers ──────────────────────────────────

interface FrameInfo {
  name: string;
  binary: string;
  file?: string;
  line?: number;
}

function extractBacktraceFrames(row: Row): FrameInfo[] {
  let bt = row["backtrace"];
  if (!bt) return [];
  if (Array.isArray(bt)) bt = bt[0];
  if (!isRow(bt)) return [];

  let frames = bt["frame"];
  if (!frames) return [];
  if (!Array.isArray(frames)) frames = [frames];

  return (frames as Row[]).map((frame) => {
    const name = (frame["@_name"] as string) || "unknown";
    let binary = "unknown";
    const binObj = frame["binary"];
    if (isRow(binObj)) {
      binary = (binObj["@_name"] as string) || "unknown";
    }

    let file: string | undefined;
    let line: number | undefined;
    const sourceObj = frame["source"];
    if (isRow(sourceObj)) {
      line = typeof sourceObj["@_line"] === "string" ? parseInt(sourceObj["@_line"], 10) : undefined;
      const pathObj = sourceObj["path"];
      if (isRow(pathObj)) {
        file = (pathObj["#text"] as string) || undefined;
      } else if (typeof pathObj === "string") {
        file = pathObj;
      }
    }

    return { name, binary, file, line };
  });
}

function extractWeightMs(row: Row): number | null {
  const val = row["weight"];
  if (!val) return null;

  if (isRow(val)) {
    const rawValue = val["#text"];
    if (rawValue != null) {
      const ns = Number(rawValue);
      if (!isNaN(ns)) return ns / 1_000_000;
    }
    const fmt = val["@_fmt"];
    if (typeof fmt === "string") {
      const match = fmt.match(/([\d.]+)\s*ms/);
      if (match) return parseFloat(match[1]);
    }
  }

  const num = Number(val);
  if (!isNaN(num)) return num;
  return null;
}

function isSystemFrame(fn: string): boolean {
  const systemPrefixes = [
    "objc_msgSend", "swift_", "_dispatch_", "pthread_",
    "mach_", "CFRunLoop", "UIKit", "CoreFoundation",
    "libsystem_", "dyld", "__TEXT",
  ];
  return systemPrefixes.some((p) => fn.startsWith(p));
}

function buildSummary(hotspots: CpuHotspot[], blockers: TimeProfileResult["mainThreadBlockers"]): string {
  const parts: string[] = [];

  if (hotspots.length > 0) {
    const topFn = hotspots[0];
    parts.push(`Hottest function: ${topFn.function} (${topFn.selfPercent}% CPU)`);
  }

  const userHotspots = hotspots.filter((h) => !isSystemFrame(h.function));
  if (userHotspots.length > 0) {
    parts.push(`${userHotspots.length} user-code hotspots identified`);
  }

  const criticalBlockers = blockers.filter((b) => b.severity === "critical");
  if (criticalBlockers.length > 0) {
    parts.push(`${criticalBlockers.length} critical main-thread blockers found`);
  }

  return parts.join(". ") + ".";
}
