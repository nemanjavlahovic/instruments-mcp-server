import { parseXml, getPath } from "../utils/xml.js";

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

export interface TimeProfileResult {
  template: "Time Profiler";
  totalSamples: number;
  duration: string;
  hotspots: CpuHotspot[];
  mainThreadBlockers: Array<{
    function: string;
    durationMs: number;
    severity: "info" | "warning" | "critical";
  }>;
  summary: string;
}

/**
 * Parse Time Profiler trace export XML into a structured result.
 * The XML schema varies between xctrace versions, so we use defensive parsing.
 */
export function parseTimeProfiler(tocXml: string, tableXml: string): TimeProfileResult {
  const tocData = parseXml(tocXml);
  const tableData = parseXml(tableXml);

  const rows = extractRows(tableData);
  const totalSamples = rows.length;

  // Aggregate weights per function
  const functionWeights = new Map<string, { self: number; total: number; module: string; file?: string; line?: number }>();

  for (const row of rows) {
    const fn = extractString(row, "symbol") || extractString(row, "name") || "unknown";
    const mod = extractString(row, "binary") || extractString(row, "library") || "unknown";
    const weight = extractNumber(row, "weight") || extractNumber(row, "self-weight") || 1;
    const file = extractString(row, "source-path") || undefined;
    const line = extractNumber(row, "source-line") || undefined;

    const existing = functionWeights.get(fn);
    if (existing) {
      existing.self += weight;
      existing.total += weight;
    } else {
      functionWeights.set(fn, { self: weight, total: weight, module: mod, file, line });
    }
  }

  // Sort by self weight descending and take top 20
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

  // Identify main thread blockers (functions with high self weight, heuristic)
  const mainThreadBlockers = hotspots
    .filter((h) => h.selfPercent > 5 && !isSystemFrame(h.function))
    .map((h) => ({
      function: h.function,
      durationMs: Math.round(h.selfWeight),
      severity: (h.selfPercent > 15 ? "critical" : h.selfPercent > 8 ? "warning" : "info") as "info" | "warning" | "critical",
    }));

  const summary = buildSummary(hotspots, mainThreadBlockers);

  return {
    template: "Time Profiler",
    totalSamples,
    duration: "unknown",
    hotspots,
    mainThreadBlockers,
    summary,
  };
}

function extractRows(data: Record<string, unknown>): Array<Record<string, unknown>> {
  // xctrace export structures vary; try common paths
  const paths = [
    "trace-query-result.node",
    "trace-query-result.row",
    "table.row",
    "run.data.table.row",
  ];

  for (const path of paths) {
    const rows = getPath(data, path);
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }

  // Fallback: recursively find arrays of objects with "weight" or "symbol" keys
  return findRowsRecursive(data);
}

function findRowsRecursive(obj: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 10 || obj == null) return [];
  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === "object") {
    return obj as Array<Record<string, unknown>>;
  }
  if (typeof obj === "object") {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      const result = findRowsRecursive(value, depth + 1);
      if (result.length > 0) return result;
    }
  }
  return [];
}

function extractString(row: Record<string, unknown>, key: string): string | null {
  // Check direct key, then @_key (attribute), then nested
  if (typeof row[key] === "string") return row[key] as string;
  if (typeof row[`@_${key}`] === "string") return row[`@_${key}`] as string;

  // Check nested objects for #text
  const nested = row[key];
  if (nested && typeof nested === "object" && "#text" in (nested as Record<string, unknown>)) {
    return String((nested as Record<string, unknown>)["#text"]);
  }
  return null;
}

function extractNumber(row: Record<string, unknown>, key: string): number | null {
  const val = row[key] ?? row[`@_${key}`];
  if (val == null) return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
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
