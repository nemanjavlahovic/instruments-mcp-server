import { parseXml } from "../utils/xml.js";
import { extractRows, extractStr, extractFmt, extractNum, parseSizeFmt, formatBytes, type Row } from "../utils/extractors.js";

export interface LeakGroup {
  objectType: string;
  count: number;
  totalBytes: number;
  totalKB: number;
  responsibleLibrary: string | null;
  responsibleFrame: string | null;
  severity: "ok" | "warning" | "critical";
}

export interface LeaksResult {
  template: "Leaks";
  totalLeaks: number;
  totalLeakedBytes: number;
  totalLeakedKB: number;
  leakGroups: LeakGroup[];
  responsibleLibraries: Array<{ library: string; leakCount: number; totalBytes: number }>;
  severity: "ok" | "warning" | "critical";
  summary: string;
}

/**
 * Parse Leaks template trace export XML into a structured result.
 *
 * Severity thresholds:
 *   > 10 MB total or > 100 distinct leaks = critical
 *   > 1 MB total or > 10 distinct leaks   = warning
 *   Otherwise                              = ok
 */
export function parseLeaks(tocXml: string, tableXml: string): LeaksResult {
  const tableData = parseXml(tableXml);
  const rows = extractRows(tableData);

  if (rows.length === 0) {
    return {
      template: "Leaks",
      totalLeaks: 0,
      totalLeakedBytes: 0,
      totalLeakedKB: 0,
      leakGroups: [],
      responsibleLibraries: [],
      severity: "ok",
      summary:
        "No leaks detected. Either the app has no leaks or the recording was too short to capture a leak check cycle.",
    };
  }

  const groupMap = new Map<
    string,
    { count: number; bytes: number; library: string | null; frame: string | null }
  >();

  for (const row of rows) {
    const objectType = extractObjectType(row) || "Unknown";
    const size = extractSize(row);
    const library = extractLibrary(row);
    const frame = extractFrame(row);
    const count = extractCount(row);

    const existing = groupMap.get(objectType);
    if (existing) {
      existing.count += count;
      existing.bytes += size * count;
      if (!existing.library && library) existing.library = library;
      if (!existing.frame && frame) existing.frame = frame;
    } else {
      groupMap.set(objectType, { count, bytes: size * count, library, frame });
    }
  }

  const totalLeaks = [...groupMap.values()].reduce((sum, g) => sum + g.count, 0);
  const totalLeakedBytes = [...groupMap.values()].reduce((sum, g) => sum + g.bytes, 0);

  const leakGroups: LeakGroup[] = [...groupMap.entries()]
    .map(([objectType, data]) => ({
      objectType,
      count: data.count,
      totalBytes: data.bytes,
      totalKB: Math.round(data.bytes / 1024),
      responsibleLibrary: data.library,
      responsibleFrame: data.frame,
      severity: classifyLeakGroupSeverity(data.bytes, data.count),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);

  const responsibleLibraries = computeResponsibleLibraries(leakGroups);
  const severity = classifyOverallSeverity(totalLeakedBytes, totalLeaks);

  return {
    template: "Leaks",
    totalLeaks,
    totalLeakedBytes,
    totalLeakedKB: Math.round(totalLeakedBytes / 1024),
    leakGroups: leakGroups.slice(0, 30),
    responsibleLibraries: responsibleLibraries.slice(0, 15),
    severity,
    summary: buildSummary(totalLeaks, totalLeakedBytes, leakGroups, responsibleLibraries, severity),
  };
}

// ── Leaks specific field extraction ─────────────────────────────────

function extractObjectType(row: Row): string | null {
  for (const key of ["leaked-object", "leakedObject", "object", "type", "category", "class", "name", "allocation-type"]) {
    const val = extractStr(row, key) || extractFmt(row, key);
    if (val) return val;
  }
  return null;
}

function extractSize(row: Row): number {
  for (const key of ["size", "bytes", "allocation-size", "total-size"]) {
    const val = extractNum(row, key);
    if (val != null && val > 0) return val;
  }

  for (const key of ["size", "bytes"]) {
    const fmt = extractFmt(row, key);
    if (fmt) {
      const parsed = parseSizeFmt(fmt);
      if (parsed > 0) return parsed;
    }
  }

  return 0;
}

function extractLibrary(row: Row): string | null {
  for (const key of ["responsible-library", "responsibleLibrary", "library", "binary", "responsible-binary", "module"]) {
    const val = extractStr(row, key) || extractFmt(row, key);
    if (val) return val;
    const nested = row[key];
    if (nested && typeof nested === "object") {
      const obj = nested as Row;
      const name = obj["@_name"] || obj["name"];
      if (typeof name === "string") return name;
    }
  }
  return null;
}

function extractFrame(row: Row): string | null {
  for (const key of ["responsible-frame", "responsibleFrame", "frame", "backtrace"]) {
    const val = extractStr(row, key) || extractFmt(row, key);
    if (val) return val;
    const nested = row[key];
    if (Array.isArray(nested) && nested.length > 0) {
      const first = nested[0];
      if (first && typeof first === "object") {
        const obj = first as Row;
        const frameName = obj["@_name"];
        if (typeof frameName === "string") return frameName;
        const innerFrames = obj["frame"];
        if (Array.isArray(innerFrames) && innerFrames.length > 0) {
          const innerName = (innerFrames[0] as Row)["@_name"];
          if (typeof innerName === "string") return innerName;
        }
      }
    }
  }
  return null;
}

function extractCount(row: Row): number {
  for (const key of ["count", "instances", "leak-count"]) {
    const val = extractNum(row, key);
    if (val != null && val > 0) return val;
  }
  return 1;
}

// ── Library aggregation ─────────────────────────────────────────────

function computeResponsibleLibraries(
  groups: LeakGroup[]
): Array<{ library: string; leakCount: number; totalBytes: number }> {
  const libMap = new Map<string, { count: number; bytes: number }>();

  for (const group of groups) {
    const lib = group.responsibleLibrary || "Unknown";
    const existing = libMap.get(lib);
    if (existing) {
      existing.count += group.count;
      existing.bytes += group.totalBytes;
    } else {
      libMap.set(lib, { count: group.count, bytes: group.totalBytes });
    }
  }

  return [...libMap.entries()]
    .map(([library, data]) => ({ library, leakCount: data.count, totalBytes: data.bytes }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

// ── Severity classification ─────────────────────────────────────────

function classifyLeakGroupSeverity(bytes: number, count: number): "ok" | "warning" | "critical" {
  if (bytes > 1024 * 1024 || count > 50) return "critical";
  if (bytes > 100 * 1024 || count > 10) return "warning";
  return "ok";
}

function classifyOverallSeverity(totalBytes: number, totalLeaks: number): "ok" | "warning" | "critical" {
  if (totalBytes > 10 * 1024 * 1024 || totalLeaks > 100) return "critical";
  if (totalBytes > 1024 * 1024 || totalLeaks > 10) return "warning";
  return "ok";
}

// ── Summary ─────────────────────────────────────────────────────────

function buildSummary(
  totalLeaks: number,
  totalBytes: number,
  groups: LeakGroup[],
  libraries: Array<{ library: string; leakCount: number; totalBytes: number }>,
  severity: "ok" | "warning" | "critical"
): string {
  if (totalLeaks === 0) return "No memory leaks detected.";

  const parts: string[] = [];
  const sizeStr = formatBytes(totalBytes);
  parts.push(`${totalLeaks} leaked object${totalLeaks === 1 ? "" : "s"} totaling ${sizeStr} — ${severity.toUpperCase()}`);

  if (severity === "critical") {
    parts.push("Significant memory leaks detected — these will cause memory growth over time and may lead to OOM termination");
  } else if (severity === "warning") {
    parts.push("Memory leaks detected — investigate to prevent memory growth");
  }

  const criticalGroups = groups.filter((g) => g.severity === "critical");
  if (criticalGroups.length > 0) {
    parts.push(
      `Largest leaks: ${criticalGroups.slice(0, 3).map((g) => `${g.objectType} (${formatBytes(g.totalBytes)}, ${g.count}x)`).join(", ")}`
    );
  } else if (groups.length > 0) {
    parts.push(
      `Top leaked types: ${groups.slice(0, 3).map((g) => `${g.objectType} (${formatBytes(g.totalBytes)})`).join(", ")}`
    );
  }

  if (libraries.length > 0 && libraries[0].library !== "Unknown") {
    parts.push(
      `Responsible libraries: ${libraries.slice(0, 3).map((l) => `${l.library} (${l.leakCount} leaks)`).join(", ")}`
    );
  }

  return parts.join(". ") + ".";
}
