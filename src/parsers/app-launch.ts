import { parseXml, getPath } from "../utils/xml.js";

export interface LaunchPhase {
  name: string;
  durationMs: number;
  severity: "ok" | "warning" | "critical";
  details?: string;
}

export interface AppLaunchResult {
  template: "App Launch";
  totalLaunchMs: number;
  launchType: "cold" | "warm" | "resume" | "unknown";
  severity: "ok" | "warning" | "critical";
  phases: LaunchPhase[];
  summary: string;
}

/**
 * Parse App Launch trace export XML into a structured result.
 *
 * The App Launch template records lifecycle events as os_signpost intervals.
 * Key phases include process creation, runtime init, UIKit init, initial frame rendering.
 *
 * Apple's targets for cold launch:
 *   < 400ms  = ok
 *   400ms–1s = warning
 *   > 1s     = critical
 */
export function parseAppLaunch(tocXml: string, tableXml: string): AppLaunchResult {
  const tableData = parseXml(tableXml);
  const rows = extractRows(tableData);

  if (rows.length === 0) {
    return {
      template: "App Launch",
      totalLaunchMs: 0,
      launchType: "unknown",
      severity: "ok",
      phases: [],
      summary: "No launch events captured. Ensure the app was launched during recording (use launch_path instead of process).",
    };
  }

  const phases = extractPhases(rows);
  const launchType = detectLaunchType(rows);
  const totalLaunchMs = computeTotalLaunchMs(phases, rows);
  const severity = classifyLaunchTime(totalLaunchMs, launchType);

  return {
    template: "App Launch",
    totalLaunchMs,
    launchType,
    severity,
    phases,
    summary: buildSummary(totalLaunchMs, launchType, severity, phases),
  };
}

function extractRows(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const nodes = getPath(data, "trace-query-result.node");
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (node && typeof node === "object" && "row" in (node as Record<string, unknown>)) {
        const rows = (node as Record<string, unknown>)["row"];
        if (Array.isArray(rows) && rows.length > 0) return rows as Array<Record<string, unknown>>;
      }
    }
  }

  const fallbackPaths = ["trace-query-result.row", "table.row", "run.data.table.row"];
  for (const path of fallbackPaths) {
    const rows = getPath(data, path);
    if (Array.isArray(rows) && rows.length > 0) return rows as Array<Record<string, unknown>>;
  }

  return [];
}

function extractPhases(rows: Array<Record<string, unknown>>): LaunchPhase[] {
  const phases: LaunchPhase[] = [];
  const seenPhases = new Set<string>();

  for (const row of rows) {
    const name = extractPhaseName(row);
    if (!name || seenPhases.has(name)) continue;
    seenPhases.add(name);

    const durationMs = extractDurationMs(row);
    if (durationMs <= 0) continue;

    phases.push({
      name: normalizePhaseName(name),
      durationMs: Math.round(durationMs * 100) / 100,
      severity: classifyPhaseDuration(name, durationMs),
      details: extractPhaseDetails(row),
    });
  }

  return phases.sort((a, b) => b.durationMs - a.durationMs);
}

function extractPhaseName(row: Record<string, unknown>): string | null {
  // os_signpost intervals: look for subsystem, category, name fields
  for (const key of ["subsystem", "category", "name", "signpost-name", "os-signpost-name", "event-name", "lifecycle"]) {
    const val = extractStr(row, key);
    if (val && isLaunchRelated(val)) return val;
  }

  // Also check the @_fmt attribute pattern
  for (const key of ["subsystem", "category", "name"]) {
    const val = extractFmt(row, key);
    if (val && isLaunchRelated(val)) return val;
  }

  // Fallback: any name-like field
  return extractStr(row, "name") || extractFmt(row, "name") || null;
}

function isLaunchRelated(val: string): boolean {
  const lower = val.toLowerCase();
  return lower.includes("launch") ||
    lower.includes("initial frame") ||
    lower.includes("runtime init") ||
    lower.includes("uikit init") ||
    lower.includes("scene connect") ||
    lower.includes("didfinishlaunching") ||
    lower.includes("pre-main") ||
    lower.includes("main()") ||
    lower.includes("dylib") ||
    lower.includes("static init") ||
    lower.includes("app lifecycle") ||
    lower.includes("first frame") ||
    lower.includes("time to initial") ||
    lower.includes("process creation") ||
    lower.includes("system interface init");
}

function normalizePhaseName(name: string): string {
  // Clean up common signpost names into readable phase names
  const mapping: Record<string, string> = {
    "process creation": "Process Creation",
    "runtime init": "Runtime Initialization",
    "uikit init": "UIKit Initialization",
    "system interface init": "System Interface Initialization",
    "initial frame rendering": "Initial Frame Rendering",
    "first frame": "First Frame",
    "scene connect": "Scene Connection",
    "static init": "Static Initializers",
    "dylib loading": "Dynamic Library Loading",
  };

  const lower = name.toLowerCase();
  for (const [key, readable] of Object.entries(mapping)) {
    if (lower.includes(key)) return readable;
  }

  return name;
}

function extractDurationMs(row: Record<string, unknown>): number {
  // Try duration-related fields
  for (const key of ["duration", "elapsed-time", "time", "interval-duration"]) {
    const val = row[key] ?? row[`@_${key}`];
    if (val != null) {
      if (typeof val === "object") {
        const obj = val as Record<string, unknown>;
        // Nanoseconds value with @_fmt
        const rawValue = obj["#text"];
        if (rawValue != null) {
          const ns = Number(rawValue);
          if (!isNaN(ns)) return ns / 1_000_000;
        }
        // Try @_fmt like "123.45 ms" or "1.23 s"
        const fmt = obj["@_fmt"] as string;
        if (fmt) return parseFmtDuration(fmt);
      }
      const num = Number(val);
      if (!isNaN(num)) {
        // Heuristic: > 1_000_000 is probably nanoseconds
        return num > 1_000_000 ? num / 1_000_000 : num;
      }
    }
  }

  // Try computing from start/end timestamps
  const start = extractTimestampMs(row, "start-time") ?? extractTimestampMs(row, "start");
  const end = extractTimestampMs(row, "end-time") ?? extractTimestampMs(row, "end");
  if (start != null && end != null && end > start) {
    return end - start;
  }

  return 0;
}

function parseFmtDuration(fmt: string): number {
  const msMatch = fmt.match(/([\d.]+)\s*ms/);
  if (msMatch) return parseFloat(msMatch[1]);

  const sMatch = fmt.match(/([\d.]+)\s*s/);
  if (sMatch) return parseFloat(sMatch[1]) * 1000;

  const usMatch = fmt.match(/([\d.]+)\s*[uμ]s/);
  if (usMatch) return parseFloat(usMatch[1]) / 1000;

  return 0;
}

function extractTimestampMs(row: Record<string, unknown>, key: string): number | null {
  const val = row[key];
  if (val == null) return null;

  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const rawValue = obj["#text"];
    if (rawValue != null) {
      const ns = Number(rawValue);
      if (!isNaN(ns)) return ns / 1_000_000;
    }
  }

  const num = Number(val);
  return isNaN(num) ? null : (num > 1_000_000 ? num / 1_000_000 : num);
}

function extractPhaseDetails(row: Record<string, unknown>): string | undefined {
  const message = extractStr(row, "message") || extractFmt(row, "message");
  if (message) return message;

  const info = extractStr(row, "signpost-info") || extractFmt(row, "signpost-info");
  if (info) return info;

  return undefined;
}

function extractStr(row: Record<string, unknown>, key: string): string | null {
  const val = row[key] ?? row[`@_${key}`];
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && "#text" in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)["#text"]);
  }
  return null;
}

function extractFmt(row: Record<string, unknown>, key: string): string | null {
  const val = row[key];
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj["@_fmt"] === "string") return obj["@_fmt"] as string;
  }
  return null;
}

function detectLaunchType(rows: Array<Record<string, unknown>>): "cold" | "warm" | "resume" | "unknown" {
  for (const row of rows) {
    const allText = JSON.stringify(row).toLowerCase();
    if (allText.includes("cold")) return "cold";
    if (allText.includes("warm")) return "warm";
    if (allText.includes("resume")) return "resume";
  }
  return "unknown";
}

function computeTotalLaunchMs(phases: LaunchPhase[], rows: Array<Record<string, unknown>>): number {
  // If we have a phase that represents the total launch, use it
  for (const phase of phases) {
    const lower = phase.name.toLowerCase();
    if (lower.includes("total") || lower === "app launch" || lower.includes("time to initial")) {
      return phase.durationMs;
    }
  }

  // Otherwise try to find the longest duration in raw rows (likely the overall interval)
  let maxDuration = 0;
  for (const row of rows) {
    const d = extractDurationMs(row);
    if (d > maxDuration) maxDuration = d;
  }

  if (maxDuration > 0) return Math.round(maxDuration * 100) / 100;

  // Fallback: sum all phase durations (rough approximation, phases may overlap)
  if (phases.length > 0) {
    return Math.round(phases.reduce((sum, p) => sum + p.durationMs, 0) * 100) / 100;
  }

  return 0;
}

/**
 * Apple's cold launch guidelines:
 *   < 400ms  = ok
 *   400ms–1s = warning
 *   > 1s     = critical
 *
 * Warm launch/resume have tighter budgets:
 *   < 200ms  = ok
 *   200–500ms = warning
 *   > 500ms  = critical
 */
function classifyLaunchTime(ms: number, type: "cold" | "warm" | "resume" | "unknown"): "ok" | "warning" | "critical" {
  if (type === "warm" || type === "resume") {
    if (ms > 500) return "critical";
    if (ms > 200) return "warning";
    return "ok";
  }
  // Cold / unknown
  if (ms > 1000) return "critical";
  if (ms > 400) return "warning";
  return "ok";
}

function classifyPhaseDuration(name: string, ms: number): "ok" | "warning" | "critical" {
  const lower = name.toLowerCase();

  // Static initializers / dylib loading should be < 50ms each
  if (lower.includes("static") || lower.includes("dylib")) {
    if (ms > 200) return "critical";
    if (ms > 50) return "warning";
    return "ok";
  }

  // UIKit / runtime init should be < 100ms
  if (lower.includes("init")) {
    if (ms > 300) return "critical";
    if (ms > 100) return "warning";
    return "ok";
  }

  // Initial frame rendering should be < 200ms
  if (lower.includes("frame") || lower.includes("render")) {
    if (ms > 500) return "critical";
    if (ms > 200) return "warning";
    return "ok";
  }

  // Generic phase
  if (ms > 500) return "critical";
  if (ms > 200) return "warning";
  return "ok";
}

function buildSummary(
  totalMs: number,
  launchType: string,
  severity: "ok" | "warning" | "critical",
  phases: LaunchPhase[]
): string {
  if (totalMs === 0) return "No measurable launch time. Ensure the app was launched during recording.";

  const parts: string[] = [];

  const typeLabel = launchType !== "unknown" ? ` (${launchType})` : "";
  parts.push(`App launch${typeLabel}: ${Math.round(totalMs)}ms — ${severity.toUpperCase()}`);

  if (severity === "critical") {
    parts.push(`Exceeds Apple's recommended launch time. Target: <400ms cold, <200ms warm`);
  } else if (severity === "warning") {
    parts.push(`Approaching Apple's launch time limits`);
  }

  const criticalPhases = phases.filter((p) => p.severity === "critical");
  if (criticalPhases.length > 0) {
    parts.push(`Slowest phases: ${criticalPhases.map((p) => `${p.name} (${Math.round(p.durationMs)}ms)`).join(", ")}`);
  }

  const warningPhases = phases.filter((p) => p.severity === "warning");
  if (warningPhases.length > 0 && criticalPhases.length === 0) {
    parts.push(`Phases to investigate: ${warningPhases.map((p) => `${p.name} (${Math.round(p.durationMs)}ms)`).join(", ")}`);
  }

  return parts.join(". ") + ".";
}
