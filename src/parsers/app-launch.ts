import { parseXml } from "../utils/xml.js";
import {
  extractRows, extractStr, extractFmt,
  extractDurationMs as sharedExtractDurationMs,
  extractTimestampMs as sharedExtractTimestampMs,
  type Row,
} from "../utils/extractors.js";

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

// ── Phase extraction ────────────────────────────────────────────────

function extractPhases(rows: Row[]): LaunchPhase[] {
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
      details: extractStr(row, "message") || extractFmt(row, "message") ||
               extractStr(row, "signpost-info") || extractFmt(row, "signpost-info") || undefined,
    });
  }

  return phases.sort((a, b) => b.durationMs - a.durationMs);
}

function extractPhaseName(row: Row): string | null {
  for (const key of ["subsystem", "category", "name", "signpost-name", "os-signpost-name", "event-name", "lifecycle"]) {
    const val = extractStr(row, key);
    if (val && isLaunchRelated(val)) return val;
  }

  for (const key of ["subsystem", "category", "name"]) {
    const val = extractFmt(row, key);
    if (val && isLaunchRelated(val)) return val;
  }

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

// ── Duration extraction ─────────────────────────────────────────────

const DURATION_KEYS = ["duration", "elapsed-time", "time", "interval-duration"];

function extractDurationMs(row: Row): number {
  const ms = sharedExtractDurationMs(row, DURATION_KEYS);
  if (ms > 0) return ms;

  // Fallback: compute from start/end timestamps
  const start = sharedExtractTimestampMs(row, "start-time") ?? sharedExtractTimestampMs(row, "start");
  const end = sharedExtractTimestampMs(row, "end-time") ?? sharedExtractTimestampMs(row, "end");
  if (start != null && end != null && end > start) {
    return end - start;
  }

  return 0;
}

// ── Launch type detection ───────────────────────────────────────────

function detectLaunchType(rows: Row[]): "cold" | "warm" | "resume" | "unknown" {
  for (const row of rows) {
    const allText = JSON.stringify(row).toLowerCase();
    if (allText.includes("cold")) return "cold";
    if (allText.includes("warm")) return "warm";
    if (allText.includes("resume")) return "resume";
  }
  return "unknown";
}

function computeTotalLaunchMs(phases: LaunchPhase[], rows: Row[]): number {
  for (const phase of phases) {
    const lower = phase.name.toLowerCase();
    if (lower.includes("total") || lower === "app launch" || lower.includes("time to initial")) {
      return phase.durationMs;
    }
  }

  let maxDuration = 0;
  for (const row of rows) {
    const d = extractDurationMs(row);
    if (d > maxDuration) maxDuration = d;
  }

  if (maxDuration > 0) return Math.round(maxDuration * 100) / 100;

  if (phases.length > 0) {
    return Math.round(phases.reduce((sum, p) => sum + p.durationMs, 0) * 100) / 100;
  }

  return 0;
}

// ── Severity classification ─────────────────────────────────────────

function classifyLaunchTime(ms: number, type: "cold" | "warm" | "resume" | "unknown"): "ok" | "warning" | "critical" {
  if (type === "warm" || type === "resume") {
    if (ms > 500) return "critical";
    if (ms > 200) return "warning";
    return "ok";
  }
  if (ms > 1000) return "critical";
  if (ms > 400) return "warning";
  return "ok";
}

function classifyPhaseDuration(name: string, ms: number): "ok" | "warning" | "critical" {
  const lower = name.toLowerCase();

  if (lower.includes("static") || lower.includes("dylib")) {
    if (ms > 200) return "critical";
    if (ms > 50) return "warning";
    return "ok";
  }

  if (lower.includes("init")) {
    if (ms > 300) return "critical";
    if (ms > 100) return "warning";
    return "ok";
  }

  if (lower.includes("frame") || lower.includes("render")) {
    if (ms > 500) return "critical";
    if (ms > 200) return "warning";
    return "ok";
  }

  if (ms > 500) return "critical";
  if (ms > 200) return "warning";
  return "ok";
}

// ── Summary ─────────────────────────────────────────────────────────

function buildSummary(totalMs: number, launchType: string, severity: "ok" | "warning" | "critical", phases: LaunchPhase[]): string {
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
