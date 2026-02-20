import { parseXml, getPath } from "../utils/xml.js";

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
  const rows = findRows(tableData);

  // Aggregate by view name
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

function findRows(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const paths = [
    "trace-query-result.node",
    "trace-query-result.row",
    "table.row",
  ];

  for (const path of paths) {
    const rows = getPath(data, path);
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }

  return findRowsDeep(data);
}

function findRowsDeep(obj: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 10 || obj == null) return [];
  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === "object") {
    return obj as Array<Record<string, unknown>>;
  }
  if (typeof obj === "object") {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      const result = findRowsDeep(value, depth + 1);
      if (result.length > 0) return result;
    }
  }
  return [];
}

function extractViewName(row: Record<string, unknown>): string | null {
  // Try various attribute names used by SwiftUI instruments
  for (const key of ["view-name", "symbol", "name", "type"]) {
    const val = row[key] ?? row[`@_${key}`];
    if (typeof val === "string") return cleanViewName(val);
    if (val && typeof val === "object" && "#text" in (val as Record<string, unknown>)) {
      return cleanViewName(String((val as Record<string, unknown>)["#text"]));
    }
  }
  return null;
}

function cleanViewName(name: string): string {
  // Remove generic parameters for readability: MyView<Int, String> -> MyView
  return name.replace(/<[^>]+>/g, "").trim();
}

function extractDuration(row: Record<string, unknown>): number {
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
  // Heuristics: views evaluated >50 times or spending >10ms total are concerning
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
