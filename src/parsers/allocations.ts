import { parseXml, getPath } from "../utils/xml.js";

export interface AllocationCategory {
  category: string;
  count: number;
  totalBytes: number;
  totalKB: number;
  persistent: number;
  transient: number;
  severity: "ok" | "warning" | "critical";
}

export interface AllocationsResult {
  template: "Allocations";
  totalAllocations: number;
  totalBytesAllocated: number;
  totalMB: number;
  categories: AllocationCategory[];
  largestAllocations: AllocationCategory[];
  summary: string;
}

/**
 * Parse Allocations template trace data.
 */
export function parseAllocations(tocXml: string, tableXml: string): AllocationsResult {
  const tableData = parseXml(tableXml);
  const rows = findRows(tableData);

  const categoryMap = new Map<string, { count: number; bytes: number; persistent: number; transient: number }>();

  for (const row of rows) {
    const category = extractField(row, "category") || extractField(row, "type") || "Unknown";
    const size = extractNum(row, "size") || extractNum(row, "bytes") || 0;
    const isPersistent = extractField(row, "event-type")?.includes("alloc") && !extractField(row, "event-type")?.includes("free");

    const existing = categoryMap.get(category);
    if (existing) {
      existing.count += 1;
      existing.bytes += size;
      if (isPersistent) existing.persistent += 1;
      else existing.transient += 1;
    } else {
      categoryMap.set(category, {
        count: 1,
        bytes: size,
        persistent: isPersistent ? 1 : 0,
        transient: isPersistent ? 0 : 1,
      });
    }
  }

  const totalAllocations = rows.length;
  const totalBytesAllocated = [...categoryMap.values()].reduce((sum, v) => sum + v.bytes, 0);

  const categories: AllocationCategory[] = [...categoryMap.entries()]
    .map(([name, data]) => ({
      category: name,
      count: data.count,
      totalBytes: data.bytes,
      totalKB: Math.round(data.bytes / 1024),
      persistent: data.persistent,
      transient: data.transient,
      severity: classifyAllocationSeverity(data.bytes, data.count),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);

  const largestAllocations = categories.slice(0, 15);

  const summary = buildAllocationSummary(totalAllocations, totalBytesAllocated, categories);

  return {
    template: "Allocations",
    totalAllocations,
    totalBytesAllocated,
    totalMB: Math.round(totalBytesAllocated / (1024 * 1024) * 10) / 10,
    categories: categories.slice(0, 30),
    largestAllocations,
    summary,
  };
}

function findRows(data: Record<string, unknown>): Array<Record<string, unknown>> {
  // xctrace exports: <trace-query-result><node><schema/><row/>...</node></trace-query-result>
  const nodes = getPath(data, "trace-query-result.node");
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (node && typeof node === "object" && "row" in (node as Record<string, unknown>)) {
        const rows = (node as Record<string, unknown>)["row"];
        if (Array.isArray(rows) && rows.length > 0) return rows as Array<Record<string, unknown>>;
      }
    }
  }

  const fallbackPaths = ["trace-query-result.row", "table.row"];
  for (const path of fallbackPaths) {
    const rows = getPath(data, path);
    if (Array.isArray(rows) && rows.length > 0) return rows as Array<Record<string, unknown>>;
  }

  return [];
}

function extractField(row: Record<string, unknown>, key: string): string | null {
  const val = row[key] ?? row[`@_${key}`];
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && "#text" in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)["#text"]);
  }
  return null;
}

function extractNum(row: Record<string, unknown>, key: string): number | null {
  const val = row[key] ?? row[`@_${key}`];
  if (val == null) return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
}

function classifyAllocationSeverity(bytes: number, count: number): "ok" | "warning" | "critical" {
  if (bytes > 50 * 1024 * 1024 || count > 100_000) return "critical";
  if (bytes > 10 * 1024 * 1024 || count > 10_000) return "warning";
  return "ok";
}

function buildAllocationSummary(
  totalAllocations: number,
  totalBytes: number,
  categories: AllocationCategory[]
): string {
  const totalMB = Math.round(totalBytes / (1024 * 1024) * 10) / 10;
  const parts: string[] = [];
  parts.push(`${totalAllocations} allocations totaling ${totalMB} MB`);

  const critical = categories.filter((c) => c.severity === "critical");
  if (critical.length > 0) {
    parts.push(`${critical.length} categories with heavy allocation: ${critical.map((c) => c.category).join(", ")}`);
  }

  return parts.join(". ") + ".";
}
