import { parseXml } from "../utils/xml.js";
import { extractRows, extractStr, extractDurationMs, isRow, type Row } from "../utils/extractors.js";

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
  microHangs: number;
  minorHangs: number;
  warningHangs: number;
  criticalHangs: number;
  hangs: HangEvent[];
  severity: "ok" | "warning" | "critical";
  summary: string;
}

/**
 * Parse Animation Hitches / Hangs trace data.
 */
export function parseHangs(tocXml: string, tableXml: string): HangsResult {
  const tableData = parseXml(tableXml);
  const rows = extractRows(tableData);

  const durationKeys = ["duration", "hang-duration", "hitch-duration", "time"];
  const hangs: HangEvent[] = rows.map((row) => {
    const durationMs = extractDurationMs(row, durationKeys);
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

  const severity: "ok" | "warning" | "critical" =
    criticalHangs > 0 ? "critical" : warningHangs > 0 ? "warning" : "ok";

  return {
    template: "Animation Hitches",
    totalHangs,
    microHangs,
    minorHangs,
    warningHangs,
    criticalHangs,
    hangs: hangs.slice(0, 20),
    severity,
    summary,
  };
}

// ── Hangs specific helpers ──────────────────────────────────────────

function extractBacktrace(row: Row): string[] | undefined {
  const bt = row["backtrace"] ?? row["stack"];
  if (Array.isArray(bt)) {
    return bt.map((frame: unknown) => {
      if (typeof frame === "string") return frame;
      if (isRow(frame)) {
        return String(frame["@_name"] || frame["symbol"] || frame["#text"] || "unknown");
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

function buildHangsSummary(total: number, critical: number, warning: number, hangs: HangEvent[]): string {
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
