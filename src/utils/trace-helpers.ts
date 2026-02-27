/**
 * Shared helpers for trace parsing and scenario execution.
 * Extracted from profile.ts and analyze.ts to avoid duplication.
 */

/**
 * Search the TOC XML for a table matching a schema keyword and return its xpath.
 */
export function findTableXpath(tocXml: string, schemaKeyword: string): string | null {
  const schemaPattern = new RegExp(`schema="([^"]*${schemaKeyword}[^"]*)"`, "i");
  const match = tocXml.match(schemaPattern);
  if (!match) return null;

  const schema = match[1];
  const runMatch = tocXml.match(/<run\s+number="(\d+)"/);
  const runNumber = runMatch ? runMatch[1] : "1";

  return `/trace-toc/run[@number="${runNumber}"]/data/table[@schema="${schema}"]`;
}

/**
 * Search the TOC XML for a track detail matching a schema keyword.
 * Leaks and Network data may live under tracks/track/details/detail instead of data/table.
 */
export function findTrackXpath(tocXml: string, schemaKeyword: string): string | null {
  const detailPattern = new RegExp(`<detail[^>]*schema="([^"]*${schemaKeyword}[^"]*)"`, "i");
  const match = tocXml.match(detailPattern);
  if (!match) return null;

  const schema = match[1];
  const runMatch = tocXml.match(/<run\s+number="(\d+)"/);
  const runNumber = runMatch ? runMatch[1] : "1";

  return `/trace-toc/run[@number="${runNumber}"]/tracks/track/details/detail[@schema="${schema}"]`;
}

/**
 * Parse a time limit string like "15s" or "1m" into milliseconds.
 */
export function parseTimeLimitToMs(timeLimit: string): number {
  const match = timeLimit.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) return 60_000;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    default: return 60_000;
  }
}

/**
 * Extract all schema names from a TOC XML string.
 * Returns a deduplicated list of schema identifiers found in the trace.
 */
export function extractTableSchemas(tocXml: string): string[] {
  const schemas = new Set<string>();
  const regex = /schema="([^"]+)"/g;
  let match;
  while ((match = regex.exec(tocXml)) !== null) {
    schemas.add(match[1]);
  }
  return [...schemas];
}

/**
 * Sleep for the specified milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
