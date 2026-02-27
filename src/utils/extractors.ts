import { getPath } from "./xml.js";

export type Row = Record<string, unknown>;

/** Type guard for Row — checks that a value is a non-null object. */
export function isRow(val: unknown): val is Row {
  return val != null && typeof val === "object" && !Array.isArray(val);
}

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
      if (isRow(node) && "row" in node) {
        const rows = node["row"];
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
  if (isRow(val) && "#text" in val) {
    return String(val["#text"]);
  }
  return null;
}

/**
 * Extract the @_fmt display string from a nested element.
 * xctrace 26 stores display values like: <thread fmt="Main Thread 0x1e97f4">
 */
export function extractFmt(row: Row, key: string): string | null {
  const val = row[key];
  if (isRow(val)) {
    if (typeof val["@_fmt"] === "string") return val["@_fmt"];
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
  if (isRow(val)) {
    const text = val["#text"];
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
  if (isRow(val)) {
    const fmt = val["@_fmt"];
    if (typeof fmt === "string") {
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

// ── Multi-key extraction helpers ──────────────────────────────────────

/**
 * Extract a duration in milliseconds from a row, trying multiple field names.
 * Handles xctrace formats:
 *   - Object with @_fmt (e.g., "500 ms") — preferred (unambiguous)
 *   - Object with #text (nanoseconds) — fallback
 *   - Plain numeric — uses heuristic: >= 1_000_000 assumed nanoseconds
 */
export function extractDurationMs(row: Row, keys: string[]): number {
  for (const key of keys) {
    const val = row[key] ?? row[`@_${key}`];
    if (val == null) continue;

    if (isRow(val)) {
      // Prefer formatted string — it's unambiguous
      const fmt = val["@_fmt"];
      if (typeof fmt === "string") {
        const ms = parseFmtDuration(fmt);
        if (ms > 0) return ms;
      }
      // Fall back to raw #text value (nanoseconds in xctrace)
      const rawText = val["#text"];
      if (rawText != null) {
        const ns = Number(rawText);
        if (!isNaN(ns)) return ns / 1_000_000;
      }
      continue;
    }

    const num = Number(val);
    if (!isNaN(num)) {
      // xctrace nanosecond values are >= 1_000_000 (1ms).
      // Realistic durations in ms are < 1_000_000 (1000s).
      // Use 1_000_000 as threshold: at or above = nanoseconds, below = milliseconds.
      return num >= 1_000_000 ? num / 1_000_000 : num;
    }
  }
  return 0;
}

/**
 * Extract a timestamp in milliseconds from a row field.
 * Handles xctrace format: { #text: nanoseconds } or plain numeric.
 */
export function extractTimestampMs(row: Row, key: string): number | null {
  const val = row[key];
  if (val == null) return null;

  if (isRow(val)) {
    const rawValue = val["#text"];
    if (rawValue != null) {
      const ns = Number(rawValue);
      if (!isNaN(ns)) return ns / 1_000_000;
    }
  }

  const num = Number(val);
  return isNaN(num) ? null : (num > 1_000_000 ? num / 1_000_000 : num);
}

/**
 * Try extracting a string value from the first matching key.
 */
export function extractFirstStr(row: Row, keys: string[]): string | null {
  for (const key of keys) {
    const val = extractStr(row, key);
    if (val) return val;
  }
  return null;
}

/**
 * Try extracting a string value (str then fmt) from the first matching key.
 */
export function extractFirstStrOrFmt(row: Row, keys: string[]): string | null {
  for (const key of keys) {
    const val = extractStr(row, key) || extractFmt(row, key);
    if (val) return val;
  }
  return null;
}

/**
 * Try extracting a numeric value from the first matching key.
 * For each key, tries extractNum then extractFmtNum.
 */
export function extractFirstNum(row: Row, keys: string[]): number | null {
  for (const key of keys) {
    const val = extractNum(row, key);
    if (val != null) return val;
    const fmtVal = extractFmtNum(row, key);
    if (fmtVal != null) return fmtVal;
  }
  return null;
}
