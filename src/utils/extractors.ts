import { getPath } from "./xml.js";

export type Row = Record<string, unknown>;

/**
 * Extract rows from parsed xctrace XML export.
 * Handles multiple XML structures across xctrace versions:
 *   - trace-query-result > node > row  (xctrace 26+)
 *   - trace-query-result > row         (older xctrace)
 *   - table > row / run > data > table > row (fallbacks)
 *   - tracks > track > details > detail > row (Leaks, Network)
 */
export function extractRows(data: Record<string, unknown>): Row[] {
  const nodes = getPath(data, "trace-query-result.node");
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (node && typeof node === "object" && "row" in (node as Row)) {
        const rows = (node as Row)["row"];
        if (Array.isArray(rows) && rows.length > 0) return rows as Row[];
      }
    }
  }

  const fallbackPaths = [
    "trace-query-result.row",
    "table.row",
    "run.data.table.row",
    "run.tracks.track.details.detail.row",
  ];
  for (const path of fallbackPaths) {
    const rows = getPath(data, path);
    if (Array.isArray(rows) && rows.length > 0) return rows as Row[];
  }

  return [];
}

/**
 * Extract a string value from a row field.
 * Handles plain strings, @_ prefixed attributes, and nested { #text } objects.
 */
export function extractStr(row: Row, key: string): string | null {
  const val = row[key] ?? row[`@_${key}`];
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && "#text" in (val as Row)) {
    return String((val as Row)["#text"]);
  }
  return null;
}

/**
 * Extract the @_fmt display string from a nested element.
 * xctrace 26 stores display values like: <thread fmt="Main Thread 0x1e97f4">
 */
export function extractFmt(row: Row, key: string): string | null {
  const val = row[key];
  if (val && typeof val === "object") {
    const obj = val as Row;
    if (typeof obj["@_fmt"] === "string") return obj["@_fmt"] as string;
  }
  return null;
}

/**
 * Extract a numeric value from a row field.
 * Handles plain numbers, @_ prefixed attributes, and nested { #text } objects.
 */
export function extractNum(row: Row, key: string): number | null {
  const val = row[key] ?? row[`@_${key}`];
  if (val == null) return null;
  if (typeof val === "object") {
    const obj = val as Row;
    const text = obj["#text"];
    if (text != null) {
      const num = Number(text);
      if (!isNaN(num)) return num;
    }
  }
  const num = Number(val);
  return isNaN(num) ? null : num;
}

/**
 * Extract a number from a @_fmt formatted string.
 * Parses the leading digits from values like "12/20", "128 KB", "3.5".
 */
export function extractFmtNum(row: Row, key: string): number | null {
  const val = row[key];
  if (val && typeof val === "object") {
    const obj = val as Row;
    const fmt = obj["@_fmt"] as string;
    if (fmt) {
      const match = fmt.match(/^(\d+(?:\.\d+)?)/);
      if (match) return parseFloat(match[1]);
    }
  }
  return null;
}

/**
 * Parse a formatted duration string into milliseconds.
 * Handles: "123ms", "1.5 s", "500 μs", "2.3s"
 */
export function parseFmtDuration(fmt: string): number {
  const msMatch = fmt.match(/([\d.]+)\s*ms/);
  if (msMatch) return parseFloat(msMatch[1]);

  const sMatch = fmt.match(/([\d.]+)\s*s/);
  if (sMatch) return parseFloat(sMatch[1]) * 1000;

  const usMatch = fmt.match(/([\d.]+)\s*[uμ]s/);
  if (usMatch) return parseFloat(usMatch[1]) / 1000;

  return 0;
}

/**
 * Parse a formatted size string into bytes.
 * Handles: "128 KB", "1.5 MB", "2 GB", "4096 bytes", "4096"
 */
export function parseSizeFmt(fmt: string): number {
  const gbMatch = fmt.match(/([\d.]+)\s*GB/i);
  if (gbMatch) return parseFloat(gbMatch[1]) * 1024 * 1024 * 1024;

  const mbMatch = fmt.match(/([\d.]+)\s*MB/i);
  if (mbMatch) return parseFloat(mbMatch[1]) * 1024 * 1024;

  const kbMatch = fmt.match(/([\d.]+)\s*KB/i);
  if (kbMatch) return parseFloat(kbMatch[1]) * 1024;

  const bytesMatch = fmt.match(/([\d.]+)\s*(?:bytes?|B)/i);
  if (bytesMatch) return parseFloat(bytesMatch[1]);

  const numMatch = fmt.match(/^(\d+)$/);
  if (numMatch) return parseInt(numMatch[1], 10);

  return 0;
}

/**
 * Format bytes into a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
