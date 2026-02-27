import { parseXml } from "../utils/xml.js";
import {
  extractRows, extractStr, extractFmt, extractNum,
  extractDurationMs as sharedExtractDurationMs,
  parseSizeFmt, type Row,
} from "../utils/extractors.js";

export interface HttpTransaction {
  url: string;
  domain: string;
  method: string;
  statusCode: number | null;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  severity: "ok" | "warning" | "critical";
}

export interface DomainSummary {
  domain: string;
  requestCount: number;
  totalBytes: number;
  avgDurationMs: number;
  maxDurationMs: number;
  errorCount: number;
  severity: "ok" | "warning" | "critical";
}

export interface NetworkResult {
  template: "Network";
  totalRequests: number;
  totalBytesSent: number;
  totalBytesReceived: number;
  avgDurationMs: number;
  errorRate: number;
  domains: DomainSummary[];
  slowestRequests: HttpTransaction[];
  failedRequests: HttpTransaction[];
  severity: "ok" | "warning" | "critical";
  summary: string;
}

/**
 * Parse Network template trace export XML into a structured result.
 *
 * Severity thresholds:
 *   Any request > 5s or error rate > 10%  = critical
 *   Any request > 2s or error rate > 5%   = warning
 *   Otherwise                              = ok
 */
export function parseNetwork(tocXml: string, tableXml: string): NetworkResult {
  const tableData = parseXml(tableXml);
  const rows = extractRows(tableData);

  if (rows.length === 0) {
    return {
      template: "Network",
      totalRequests: 0,
      totalBytesSent: 0,
      totalBytesReceived: 0,
      avgDurationMs: 0,
      errorRate: 0,
      domains: [],
      slowestRequests: [],
      failedRequests: [],
      severity: "ok",
      summary: "No network requests captured. Ensure the app was making HTTP requests during recording.",
    };
  }

  const transactions = extractTransactions(rows);
  const totalRequests = transactions.length;

  const totalBytesSent = transactions.reduce((s, t) => s + t.requestBytes, 0);
  const totalBytesReceived = transactions.reduce((s, t) => s + t.responseBytes, 0);

  const durations = transactions.map((t) => t.durationMs).filter((d) => d > 0);
  const avgDurationMs =
    durations.length > 0
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : 0;

  const failedRequests = transactions.filter((t) => t.statusCode != null && t.statusCode >= 400);
  const errorRate =
    totalRequests > 0 ? Math.round((failedRequests.length / totalRequests) * 100 * 10) / 10 : 0;

  const domains = computeDomainSummaries(transactions);
  const slowestRequests = [...transactions].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  const severity = classifyOverallSeverity(transactions, errorRate);

  return {
    template: "Network",
    totalRequests,
    totalBytesSent,
    totalBytesReceived,
    avgDurationMs,
    errorRate,
    domains: domains.slice(0, 20),
    slowestRequests,
    failedRequests: failedRequests.slice(0, 10),
    severity,
    summary: buildSummary(totalRequests, avgDurationMs, errorRate, domains, slowestRequests, severity),
  };
}

// ── Transaction extraction ──────────────────────────────────────────

function extractTransactions(rows: Row[]): HttpTransaction[] {
  const transactions: HttpTransaction[] = [];

  for (const row of rows) {
    const url = extractUrl(row);
    if (!url) continue;

    const domain = extractDomain(url, row);
    const method = extractMethod(row);
    const statusCode = extractStatusCode(row);
    const requestBytes = extractBytes(row, ["request-size", "requestSize", "bytes-sent", "bytesSent", "request-bytes"]);
    const responseBytes = extractBytes(row, ["response-size", "responseSize", "bytes-received", "bytesReceived", "response-bytes"]);
    const durationMs = extractDurationMs(row);

    transactions.push({
      url: truncateUrl(url),
      domain,
      method,
      statusCode,
      requestBytes,
      responseBytes,
      durationMs,
      severity: classifyRequestSeverity(durationMs, statusCode),
    });
  }

  return transactions;
}

function extractUrl(row: Row): string | null {
  for (const key of ["url", "uri", "request-url", "requestURL", "path", "endpoint"]) {
    const val = extractStr(row, key);
    if (val && (val.startsWith("http") || val.startsWith("/"))) return val;
    const fmt = extractFmt(row, key);
    if (fmt && (fmt.startsWith("http") || fmt.startsWith("/"))) return fmt;
  }
  return null;
}

function extractDomain(url: string, row: Row): string {
  for (const key of ["domain", "host", "hostname", "server"]) {
    const val = extractStr(row, key) || extractFmt(row, key);
    if (val) return val;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return "unknown";
  }
}

function extractMethod(row: Row): string {
  for (const key of ["method", "http-method", "httpMethod", "request-method"]) {
    const val = extractStr(row, key) || extractFmt(row, key);
    if (val) return val.toUpperCase();
  }
  return "GET";
}

function extractStatusCode(row: Row): number | null {
  for (const key of ["status-code", "statusCode", "status", "http-status", "response-status"]) {
    const val = extractNum(row, key);
    if (val != null && val >= 100 && val < 600) return val;
  }
  return null;
}

function extractBytes(row: Row, keys: string[]): number {
  for (const key of keys) {
    const val = extractNum(row, key);
    if (val != null && val >= 0) return val;
    const fmt = extractFmt(row, key);
    if (fmt) {
      const parsed = parseSizeFmt(fmt);
      if (parsed > 0) return parsed;
    }
  }
  return 0;
}

const DURATION_KEYS = ["duration", "elapsed-time", "time", "total-time", "response-time", "latency"];

function extractDurationMs(row: Row): number {
  return sharedExtractDurationMs(row, DURATION_KEYS);
}

function truncateUrl(url: string): string {
  if (url.length <= 120) return url;
  return url.substring(0, 117) + "...";
}

// ── Domain aggregation ──────────────────────────────────────────────

function computeDomainSummaries(transactions: HttpTransaction[]): DomainSummary[] {
  const domainMap = new Map<
    string,
    { count: number; totalBytes: number; durations: number[]; errors: number }
  >();

  for (const t of transactions) {
    const existing = domainMap.get(t.domain);
    if (existing) {
      existing.count += 1;
      existing.totalBytes += t.requestBytes + t.responseBytes;
      if (t.durationMs > 0) existing.durations.push(t.durationMs);
      if (t.statusCode != null && t.statusCode >= 400) existing.errors += 1;
    } else {
      domainMap.set(t.domain, {
        count: 1,
        totalBytes: t.requestBytes + t.responseBytes,
        durations: t.durationMs > 0 ? [t.durationMs] : [],
        errors: t.statusCode != null && t.statusCode >= 400 ? 1 : 0,
      });
    }
  }

  return [...domainMap.entries()]
    .map(([domain, data]) => {
      const avgDurationMs =
        data.durations.length > 0
          ? Math.round((data.durations.reduce((a, b) => a + b, 0) / data.durations.length) * 10) / 10
          : 0;
      const maxDurationMs =
        data.durations.length > 0 ? Math.round(Math.max(...data.durations) * 10) / 10 : 0;

      return {
        domain,
        requestCount: data.count,
        totalBytes: data.totalBytes,
        avgDurationMs,
        maxDurationMs,
        errorCount: data.errors,
        severity: classifyDomainSeverity(avgDurationMs, maxDurationMs, data.errors, data.count),
      };
    })
    .sort((a, b) => b.requestCount - a.requestCount);
}

// ── Severity classification ─────────────────────────────────────────

function classifyRequestSeverity(durationMs: number, statusCode: number | null): "ok" | "warning" | "critical" {
  if (statusCode != null && statusCode >= 500) return "critical";
  if (durationMs > 5000) return "critical";
  if (statusCode != null && statusCode >= 400) return "warning";
  if (durationMs > 2000) return "warning";
  return "ok";
}

function classifyDomainSeverity(avgMs: number, maxMs: number, errors: number, total: number): "ok" | "warning" | "critical" {
  const errorPct = total > 0 ? (errors / total) * 100 : 0;
  if (maxMs > 5000 || errorPct > 10) return "critical";
  if (maxMs > 2000 || errorPct > 5 || avgMs > 1000) return "warning";
  return "ok";
}

function classifyOverallSeverity(transactions: HttpTransaction[], errorRate: number): "ok" | "warning" | "critical" {
  const maxDuration = transactions.reduce((max, t) => Math.max(max, t.durationMs), 0);
  const slowPct =
    transactions.length > 0
      ? (transactions.filter((t) => t.durationMs > 2000).length / transactions.length) * 100
      : 0;

  if (maxDuration > 5000 || slowPct > 50 || errorRate > 10) return "critical";
  if (maxDuration > 2000 || slowPct > 20 || errorRate > 5) return "warning";
  return "ok";
}

// ── Summary ─────────────────────────────────────────────────────────

function buildSummary(
  totalRequests: number,
  avgDurationMs: number,
  errorRate: number,
  domains: DomainSummary[],
  slowest: HttpTransaction[],
  severity: "ok" | "warning" | "critical"
): string {
  const parts: string[] = [];

  parts.push(
    `${totalRequests} HTTP request${totalRequests === 1 ? "" : "s"}, avg ${Math.round(avgDurationMs)}ms — ${severity.toUpperCase()}`
  );

  if (errorRate > 0) {
    parts.push(`${errorRate}% error rate`);
  }

  if (severity === "critical") {
    parts.push("Significant network performance issues detected");
  } else if (severity === "warning") {
    parts.push("Some requests are slow or failing");
  }

  if (slowest.length > 0 && slowest[0].durationMs > 1000) {
    const top = slowest
      .slice(0, 3)
      .filter((t) => t.durationMs > 1000)
      .map((t) => `${t.method} ${t.domain} (${Math.round(t.durationMs)}ms)`)
      .join(", ");
    if (top) parts.push(`Slowest: ${top}`);
  }

  if (domains.length > 0) {
    const criticalDomains = domains.filter((d) => d.severity === "critical");
    if (criticalDomains.length > 0) {
      parts.push(
        `Problem domains: ${criticalDomains.map((d) => `${d.domain} (${d.errorCount} errors, max ${Math.round(d.maxDurationMs)}ms)`).join(", ")}`
      );
    }
  }

  return parts.join(". ") + ".";
}
