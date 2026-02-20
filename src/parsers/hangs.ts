import { parseXml, getPath } from "../utils/xml.js";

export interface HangEvent {
  duration: string;
  durationMs: number;
  severity: "micro" | "minor" | "warning" | "critical";
  startTime: string;
  backtrace?: string[];
}

export interface HangsResult {
  template: "Animation Hitches";
  totalHangs: number;
  microHangs: number;   // < 100ms
  minorHangs: number;   // 100-250ms
  warningHangs: number; // 250ms-1s
  criticalHangs: number; // > 1s
  hangs: HangEvent[];
  summary: string;
}

/**
 * Parse Animation Hitches / Hangs trace data.
 */
export function parseHangs(tocXml: string, tableXml: string): HangsResult {
  const tableData = parseXml(tableXml);
  const rows = findRows(tableData);

  const hangs: HangEvent[] = rows.map((row) => {
    const durationMs = extractDurationMs(row);
    return {
      duration: `${durationMs}ms`,
      durationMs,
      severity: classifyHang(durationMs),
      startTime: extractStr(row, "start") || extractStr(row, "timestamp") || "unknown",
      backtrace: extractBacktrace(row),
    };
  }).sort((a, b) => b.durationMs - a.durationMs);

  const totalHangs = hangs.length;
  const microHangs = hangs.filter((h) => h.severity === "micro").length;
  const minorHangs = hangs.filter((h) => h.severity === "minor").length;
  const warningHangs = hangs.filter((h) => h.severity === "warning").length;
  const criticalHangs = hangs.filter((h) => h.severity === "critical").length;

  const summary = buildHangsSummary(totalHangs, criticalHangs, warningHangs, hangs);

  return {
    template: "Animation Hitches",
    totalHangs,
    microHangs,
    minorHangs,
    warningHangs,
    criticalHangs,
    hangs: hangs.slice(0, 20), // top 20 worst hangs
    summary,
  };
}

function findRows(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const paths = ["trace-query-result.node", "trace-query-result.row", "table.row"];
  for (const path of paths) {
    const rows = getPath(data, path);
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }
  return findDeep(data);
}

function findDeep(obj: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 10 || obj == null) return [];
  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === "object") {
    return obj as Array<Record<string, unknown>>;
  }
  if (typeof obj === "object") {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      const result = findDeep(value, depth + 1);
      if (result.length > 0) return result;
    }
  }
  return [];
}

function extractStr(row: Record<string, unknown>, key: string): string | null {
  const val = row[key] ?? row[`@_${key}`];
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && "#text" in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)["#text"]);
  }
  return null;
}

function extractDurationMs(row: Record<string, unknown>): number {
  for (const key of ["duration", "hang-duration", "hitch-duration", "time"]) {
    const val = row[key] ?? row[`@_${key}`];
    if (val != null) {
      const num = Number(val);
      if (!isNaN(num)) return num > 1000 ? num / 1_000_000 : num; // handle ns vs ms
    }
  }
  return 0;
}

function extractBacktrace(row: Record<string, unknown>): string[] | undefined {
  const bt = row["backtrace"] ?? row["stack"];
  if (Array.isArray(bt)) {
    return bt.map((frame: unknown) => {
      if (typeof frame === "string") return frame;
      if (typeof frame === "object" && frame !== null) {
        const f = frame as Record<string, unknown>;
        return String(f["@_name"] || f["symbol"] || f["#text"] || "unknown");
      }
      return "unknown";
    });
  }
  return undefined;
}

function classifyHang(durationMs: number): "micro" | "minor" | "warning" | "critical" {
  if (durationMs > 1000) return "critical";
  if (durationMs > 250) return "warning";
  if (durationMs > 100) return "minor";
  return "micro";
}

function buildHangsSummary(
  total: number,
  critical: number,
  warning: number,
  hangs: HangEvent[]
): string {
  if (total === 0) return "No hangs or hitches detected. Smooth performance.";

  const parts: string[] = [];
  parts.push(`${total} hang events detected`);

  if (critical > 0) parts.push(`${critical} CRITICAL hangs (>1s)`);
  if (warning > 0) parts.push(`${warning} warning hangs (250ms-1s)`);

  if (hangs.length > 0) {
    parts.push(`Worst hang: ${hangs[0].durationMs}ms`);
  }

  return parts.join(". ") + ".";
}
