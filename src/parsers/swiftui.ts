import { parseXml } from "../utils/xml.js";
import { extractRows, extractFirstStr, type Row } from "../utils/extractors.js";

export interface ViewBodyEvaluation {
  viewName: string;
  evaluationCount: number;
  averageDurationUs: number;
  totalDurationUs: number;
  severity: "ok" | "warning" | "critical";
}

export interface SwiftUIProfileResult {
  template: "SwiftUI";
  views: ViewBodyEvaluation[];
  totalBodyEvaluations: number;
  excessiveEvaluations: ViewBodyEvaluation[];
  summary: string;
}

/**
 * Parse SwiftUI template trace data.
 * Focuses on View.body evaluation frequency and duration.
 */
export function parseSwiftUI(tocXml: string, tableXml: string): SwiftUIProfileResult {
  const tableData = parseXml(tableXml);
  const rows = extractRows(tableData);

  const viewMap = new Map<string, { count: number; totalDuration: number }>();

  for (const row of rows) {
    const viewName = extractViewName(row);
    if (!viewName) continue;

    const duration = extractDuration(row);
    const existing = viewMap.get(viewName);

    if (existing) {
      existing.count += 1;
      existing.totalDuration += duration;
    } else {
      viewMap.set(viewName, { count: 1, totalDuration: duration });
    }
  }

  const views: ViewBodyEvaluation[] = [...viewMap.entries()]
    .map(([name, data]) => ({
      viewName: name,
      evaluationCount: data.count,
      averageDurationUs: data.count > 0 ? Math.round(data.totalDuration / data.count) : 0,
      totalDurationUs: Math.round(data.totalDuration),
      severity: classifySeverity(data.count, data.totalDuration),
    }))
    .sort((a, b) => b.evaluationCount - a.evaluationCount);

  const totalBodyEvaluations = views.reduce((sum, v) => sum + v.evaluationCount, 0);
  const excessiveEvaluations = views.filter((v) => v.severity !== "ok");

  const summary = buildSwiftUISummary(views, excessiveEvaluations, totalBodyEvaluations);

  return {
    template: "SwiftUI",
    views,
    totalBodyEvaluations,
    excessiveEvaluations,
    summary,
  };
}

// ── SwiftUI specific helpers ────────────────────────────────────────

function extractViewName(row: Row): string | null {
  const raw = extractFirstStr(row, ["view-name", "symbol", "name", "type"]);
  return raw ? cleanViewName(raw) : null;
}

function cleanViewName(name: string): string {
  return name.replace(/<[^>]+>/g, "").trim();
}

function extractDuration(row: Row): number {
  for (const key of ["duration", "time", "elapsed"]) {
    const val = row[key] ?? row[`@_${key}`];
    if (val != null) {
      const num = Number(val);
      if (!isNaN(num)) return num;
    }
  }
  return 0;
}

function classifySeverity(count: number, totalDurationUs: number): "ok" | "warning" | "critical" {
  if (count > 100 || totalDurationUs > 50_000) return "critical";
  if (count > 30 || totalDurationUs > 10_000) return "warning";
  return "ok";
}

function buildSwiftUISummary(
  views: ViewBodyEvaluation[],
  excessive: ViewBodyEvaluation[],
  total: number
): string {
  const parts: string[] = [];
  parts.push(`${total} total body evaluations across ${views.length} views`);

  if (excessive.length > 0) {
    const critical = excessive.filter((v) => v.severity === "critical");
    if (critical.length > 0) {
      parts.push(`${critical.length} views with excessive re-evaluations: ${critical.map((v) => v.viewName).join(", ")}`);
    }
    const warnings = excessive.filter((v) => v.severity === "warning");
    if (warnings.length > 0) {
      parts.push(`${warnings.length} views with elevated re-evaluations`);
    }
  } else {
    parts.push("No excessive re-evaluations detected");
  }

  return parts.join(". ") + ".";
}
