import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";

const BASELINE_DIR = join(process.env.HOME ?? "/tmp", ".instruments-mcp", "baselines");

interface SavedBaseline {
  name: string;
  savedAt: string;
  template: string;
  metrics: Record<string, number>;
  rawResults: Record<string, unknown>;
}

interface MetricComparison {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  deltaPct: number;
  status: "improved" | "regressed" | "unchanged";
}

export function registerBaselineTools(server: McpServer): void {
  // ── Performance Baseline ────────────────────────────────────────
  server.tool(
    "performance_baseline",
    `Save, compare, list, or delete performance baselines to track regressions over time.
- save: Store profile results as a named baseline (pass the JSON output from any profile tool)
- compare: Diff current results against a saved baseline — shows deltas and regression/improvement status
- list: Show all saved baselines
- delete: Remove a saved baseline`,
    {
      action: z
        .enum(["save", "compare", "list", "delete"])
        .describe("Action: save | compare | list | delete"),
      name: z
        .string()
        .optional()
        .describe("Baseline name, e.g. 'v1.0' or 'pre-optimization' (required for save/compare/delete)"),
      metrics: z
        .string()
        .optional()
        .describe("JSON string of profile results from any profile_* tool (required for save/compare)"),
    },
    async ({ action, name, metrics }) => {
      try {
        switch (action) {
          case "save":
            return handleSave(name, metrics);
          case "compare":
            return handleCompare(name, metrics);
          case "list":
            return handleList();
          case "delete":
            return handleDelete(name);
        }
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Baseline operation failed: ${e}` }],
          isError: true,
        };
      }
    }
  );

  // ── Performance Report ──────────────────────────────────────────
  server.tool(
    "performance_report",
    `Generate a shareable Markdown performance report from profile results.
Pass the JSON output from one or more profile tools. Returns formatted Markdown
suitable for PRs, Slack, documentation, or stakeholder updates.`,
    {
      results: z
        .string()
        .describe("JSON string of profile results — single object or array of results from profile_* tools"),
      app_name: z
        .string()
        .optional()
        .describe("App name for the report header (e.g. 'MyApp')"),
      baseline_name: z
        .string()
        .optional()
        .describe("Optional baseline name to include regression comparison in the report"),
    },
    async ({ results, app_name, baseline_name }) => {
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(results);
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `Invalid JSON in results parameter: ${(e as Error).message}` }],
            isError: true,
          };
        }
        const resultArray: Array<Record<string, unknown>> = Array.isArray(parsed) ? parsed : [parsed];

        let baselineData: SavedBaseline | null = null;
        if (baseline_name) {
          const path = join(BASELINE_DIR, `${sanitizeName(baseline_name)}.json`);
          if (existsSync(path)) {
            try {
              baselineData = JSON.parse(readFileSync(path, "utf-8"));
            } catch (e) {
              return {
                content: [{ type: "text" as const, text: `Baseline file is corrupted: ${(e as Error).message}. Delete and re-save it.` }],
                isError: true,
              };
            }
          }
        }

        const report = generateReport(resultArray, app_name || "App", baselineData);

        return {
          content: [{ type: "text" as const, text: report }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Report generation failed: ${e}` }],
          isError: true,
        };
      }
    }
  );
}

// ── Baseline handlers ───────────────────────────────────────────────

function handleSave(name: string | undefined, metrics: string | undefined) {
  if (!name || !metrics) {
    return {
      content: [{ type: "text" as const, text: "save requires both 'name' and 'metrics' parameters." }],
      isError: true,
    };
  }

  let results: Record<string, unknown>;
  try {
    results = JSON.parse(metrics) as Record<string, unknown>;
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Invalid JSON in metrics parameter: ${(e as Error).message}` }],
      isError: true,
    };
  }
  const extracted = extractNumericMetrics(results);
  const safeName = sanitizeName(name);

  const baseline: SavedBaseline = {
    name: safeName,
    savedAt: new Date().toISOString(),
    template: (results.template as string) || "unknown",
    metrics: extracted,
    rawResults: results,
  };

  mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(join(BASELINE_DIR, `${safeName}.json`), JSON.stringify(baseline, null, 2));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            saved: safeName,
            template: baseline.template,
            metricCount: Object.keys(extracted).length,
            metrics: extracted,
            path: join(BASELINE_DIR, `${safeName}.json`),
          },
          null,
          2
        ),
      },
    ],
  };
}

function handleCompare(name: string | undefined, metrics: string | undefined) {
  if (!name || !metrics) {
    return {
      content: [{ type: "text" as const, text: "compare requires both 'name' and 'metrics' parameters." }],
      isError: true,
    };
  }

  const safeName = sanitizeName(name);
  const baselinePath = join(BASELINE_DIR, `${safeName}.json`);
  if (!existsSync(baselinePath)) {
    return {
      content: [{ type: "text" as const, text: `Baseline "${safeName}" not found. Use action "list" to see available baselines.` }],
      isError: true,
    };
  }

  let baseline: SavedBaseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Baseline file is corrupted: ${(e as Error).message}. Delete and re-save it.` }],
      isError: true,
    };
  }
  let currentResults: Record<string, unknown>;
  try {
    currentResults = JSON.parse(metrics) as Record<string, unknown>;
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Invalid JSON in metrics parameter: ${(e as Error).message}` }],
      isError: true,
    };
  }
  const currentMetrics = extractNumericMetrics(currentResults);
  const comparison = compareMetrics(baseline.metrics, currentMetrics);
  const summary = buildComparisonSummary(comparison);

  const regressions = comparison.filter((c) => c.status === "regressed");
  const improvements = comparison.filter((c) => c.status === "improved");

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            baseline: safeName,
            savedAt: baseline.savedAt,
            template: baseline.template,
            regressions: regressions.length,
            improvements: improvements.length,
            unchanged: comparison.length - regressions.length - improvements.length,
            comparison,
            summary,
          },
          null,
          2
        ),
      },
    ],
  };
}

function handleList() {
  if (!existsSync(BASELINE_DIR)) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ baselines: [] }, null, 2) }],
    };
  }

  const files = readdirSync(BASELINE_DIR).filter((f) => f.endsWith(".json"));
  const baselines = files.map((f) => {
    try {
      const data: SavedBaseline = JSON.parse(readFileSync(join(BASELINE_DIR, f), "utf-8"));
      return {
        name: data.name,
        template: data.template,
        savedAt: data.savedAt,
        metricCount: Object.keys(data.metrics).length,
      };
    } catch {
      return { name: f.replace(".json", ""), template: "unknown", savedAt: "unknown", metricCount: 0 };
    }
  });

  return {
    content: [{ type: "text" as const, text: JSON.stringify({ baselines }, null, 2) }],
  };
}

function handleDelete(name: string | undefined) {
  if (!name) {
    return {
      content: [{ type: "text" as const, text: "delete requires a 'name' parameter." }],
      isError: true,
    };
  }

  const safeName = sanitizeName(name);
  const path = join(BASELINE_DIR, `${safeName}.json`);
  if (!existsSync(path)) {
    return {
      content: [{ type: "text" as const, text: `Baseline "${safeName}" not found.` }],
      isError: true,
    };
  }

  unlinkSync(path);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ deleted: safeName }, null, 2) }],
  };
}

// ── Metric extraction ───────────────────────────────────────────────

function extractNumericMetrics(results: Record<string, unknown>): Record<string, number> {
  const metrics: Record<string, number> = {};

  for (const [key, value] of Object.entries(results)) {
    if (typeof value === "number" && isFinite(value)) {
      metrics[key] = value;
    }
  }

  return metrics;
}

// ── Comparison ──────────────────────────────────────────────────────

function compareMetrics(
  baseline: Record<string, number>,
  current: Record<string, number>
): MetricComparison[] {
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const comparisons: MetricComparison[] = [];

  for (const key of allKeys) {
    const bVal = baseline[key];
    const cVal = current[key];

    // Only compare if both exist
    if (bVal == null || cVal == null) continue;

    const delta = Math.round((cVal - bVal) * 100) / 100;
    const deltaPct = bVal !== 0 ? Math.round((delta / Math.abs(bVal)) * 100 * 10) / 10 : 0;

    // For performance metrics, lower is generally better
    // Within 5% is considered unchanged (noise threshold)
    let status: "improved" | "regressed" | "unchanged";
    if (Math.abs(deltaPct) < 5) {
      status = "unchanged";
    } else if (delta < 0) {
      status = "improved"; // value went down = better
    } else {
      status = "regressed"; // value went up = worse
    }

    comparisons.push({
      metric: key,
      baseline: bVal,
      current: cVal,
      delta,
      deltaPct,
      status,
    });
  }

  // Sort: regressions first, then improvements, then unchanged
  const order = { regressed: 0, improved: 1, unchanged: 2 };
  return comparisons.sort(
    (a, b) => order[a.status] - order[b.status] || Math.abs(b.deltaPct) - Math.abs(a.deltaPct)
  );
}

function buildComparisonSummary(comparisons: MetricComparison[]): string {
  const regressions = comparisons.filter((c) => c.status === "regressed");
  const improvements = comparisons.filter((c) => c.status === "improved");
  const unchanged = comparisons.filter((c) => c.status === "unchanged");

  const parts: string[] = [];

  if (regressions.length === 0 && improvements.length === 0) {
    parts.push("No significant changes detected (all metrics within 5% of baseline)");
  } else {
    if (regressions.length > 0) {
      parts.push(
        `${regressions.length} regression${regressions.length > 1 ? "s" : ""}: ${regressions
          .slice(0, 3)
          .map((r) => `${r.metric} +${r.deltaPct}%`)
          .join(", ")}`
      );
    }
    if (improvements.length > 0) {
      parts.push(
        `${improvements.length} improvement${improvements.length > 1 ? "s" : ""}: ${improvements
          .slice(0, 3)
          .map((r) => `${r.metric} ${r.deltaPct}%`)
          .join(", ")}`
      );
    }
    if (unchanged.length > 0) {
      parts.push(`${unchanged.length} metric${unchanged.length > 1 ? "s" : ""} unchanged`);
    }
  }

  return parts.join(". ") + ".";
}

// ── Report generation ───────────────────────────────────────────────

function generateReport(
  results: Array<Record<string, unknown>>,
  appName: string,
  baseline: SavedBaseline | null
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Performance Report: ${appName}`);
  lines.push(`**Generated**: ${new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`);
  lines.push("");

  // Overall severity
  const severities = results
    .map((r) => r.severity as string)
    .filter(Boolean);
  const overallSeverity = severities.includes("critical")
    ? "CRITICAL"
    : severities.includes("warning")
      ? "WARNING"
      : "OK";

  const badge =
    overallSeverity === "CRITICAL" ? "🔴" : overallSeverity === "WARNING" ? "🟡" : "🟢";
  lines.push(`## Overall Health: ${badge} ${overallSeverity}`);
  lines.push("");

  // Per-category findings
  for (const result of results) {
    const template = (result.template as string) || "Unknown";
    const severity = (result.severity as string) || "ok";
    const sectionBadge =
      severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "🟢";

    lines.push(`### ${sectionBadge} ${template}`);
    lines.push("");

    // Extract key metrics for this template
    const metrics = extractReportMetrics(result);
    for (const [label, value] of metrics) {
      lines.push(`- **${label}**: ${value}`);
    }

    // Include summary
    const summary = result.summary as string;
    if (summary) {
      lines.push("");
      lines.push(`> ${summary}`);
    }

    lines.push("");
  }

  // Baseline comparison
  if (baseline) {
    lines.push(`## Baseline Comparison: ${baseline.name}`);
    lines.push(`*Baseline from ${baseline.savedAt}*`);
    lines.push("");

    const currentMetrics: Record<string, number> = {};
    for (const result of results) {
      Object.assign(currentMetrics, extractNumericMetrics(result));
    }

    const comparison = compareMetrics(baseline.metrics, currentMetrics);
    if (comparison.length > 0) {
      lines.push("| Metric | Baseline | Current | Delta | Status |");
      lines.push("|--------|----------|---------|-------|--------|");

      for (const c of comparison) {
        const statusIcon =
          c.status === "regressed" ? "🔺" : c.status === "improved" ? "🔽" : "➖";
        const deltaStr = c.delta >= 0 ? `+${c.delta}` : `${c.delta}`;
        lines.push(
          `| ${c.metric} | ${formatMetricValue(c.baseline)} | ${formatMetricValue(c.current)} | ${deltaStr} (${c.deltaPct >= 0 ? "+" : ""}${c.deltaPct}%) | ${statusIcon} ${c.status} |`
        );
      }
    } else {
      lines.push("*No overlapping metrics to compare.*");
    }

    lines.push("");
  }

  // Recommendations
  const recommendations = generateRecommendations(results);
  if (recommendations.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (let i = 0; i < recommendations.length; i++) {
      lines.push(`${i + 1}. ${recommendations[i]}`);
    }
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push("*Generated by [InstrumentsMCP](https://github.com/nicholasgriffintn/instruments-mcp-server)*");

  return lines.join("\n");
}

function extractReportMetrics(result: Record<string, unknown>): Array<[string, string]> {
  const metrics: Array<[string, string]> = [];
  const template = (result.template as string) || "";

  switch (template) {
    case "Time Profiler":
      addMetric(metrics, result, "totalSamples", "Total Samples");
      addMetric(metrics, result, "totalMs", "Total CPU Time", "ms");
      break;

    case "Allocations":
      addMetric(metrics, result, "totalAllocations", "Total Allocations");
      addMetric(metrics, result, "totalMB", "Total Memory", "MB");
      break;

    case "App Launch":
      addMetric(metrics, result, "totalLaunchMs", "Launch Time", "ms");
      if (result.launchType) metrics.push(["Launch Type", result.launchType as string]);
      break;

    case "Energy Log":
      addMetric(metrics, result, "averageEnergyImpact", "Avg Energy Impact", "/20");
      addMetric(metrics, result, "peakEnergyImpact", "Peak Energy Impact", "/20");
      addMetric(metrics, result, "timeInHighEnergyPct", "Time in High Energy", "%");
      if (result.thermalState) metrics.push(["Thermal State", result.thermalState as string]);
      break;

    case "Leaks":
      addMetric(metrics, result, "totalLeaks", "Leaked Objects");
      addMetric(metrics, result, "totalLeakedKB", "Leaked Memory", "KB");
      break;

    case "Network":
      addMetric(metrics, result, "totalRequests", "Total Requests");
      addMetric(metrics, result, "avgDurationMs", "Avg Duration", "ms");
      addMetric(metrics, result, "errorRate", "Error Rate", "%");
      break;

    default:
      // Generic: show all numeric top-level values
      for (const [key, value] of Object.entries(result)) {
        if (typeof value === "number" && key !== "severity") {
          metrics.push([key, String(value)]);
        }
      }
      break;
  }

  if (result.severity) {
    metrics.push(["Severity", (result.severity as string).toUpperCase()]);
  }

  return metrics;
}

function addMetric(
  metrics: Array<[string, string]>,
  result: Record<string, unknown>,
  key: string,
  label: string,
  suffix?: string
): void {
  const value = result[key];
  if (typeof value === "number") {
    metrics.push([label, `${value}${suffix ? " " + suffix : ""}`]);
  }
}

function formatMetricValue(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value * 100) / 100);
}

function generateRecommendations(results: Array<Record<string, unknown>>): string[] {
  const recs: string[] = [];

  for (const result of results) {
    const template = result.template as string;
    const severity = result.severity as string;

    if (severity === "ok") continue;

    switch (template) {
      case "Time Profiler":
        if (severity === "critical") {
          recs.push("Investigate CPU hotspots — high CPU usage will drain battery and cause thermal throttling");
        } else {
          recs.push("Review CPU hotspots for optimization opportunities");
        }
        break;

      case "Allocations":
        if (severity === "critical") {
          recs.push("Memory allocation is excessive — profile with Leaks to check for memory leaks, review large allocation categories");
        } else {
          recs.push("Review memory allocation patterns — consider object pooling or lazy loading for large categories");
        }
        break;

      case "App Launch":
        if (severity === "critical") {
          recs.push("Launch time exceeds Apple's guidelines — review static initializers, reduce dylib count, defer non-essential work");
        } else {
          recs.push("Launch time approaching limits — consider deferring initialization work to after first frame");
        }
        break;

      case "Energy Log":
        if (severity === "critical") {
          recs.push("Excessive energy usage — reduce background activity, batch network requests, minimize GPS usage");
        } else {
          recs.push("Elevated energy usage — review top energy consumers for optimization opportunities");
        }
        break;

      case "Leaks":
        if (severity === "critical") {
          recs.push("Significant memory leaks — fix retain cycles, review delegate patterns, check closure captures");
        } else {
          recs.push("Memory leaks detected — investigate leaked object types and responsible libraries");
        }
        break;

      case "Network":
        if (severity === "critical") {
          recs.push("Network performance issues — investigate slow endpoints, reduce payload sizes, add caching");
        } else {
          recs.push("Some network requests are slow — review API response times and consider preloading");
        }
        break;

      default:
        if (severity === "critical") {
          recs.push(`${template}: Critical performance issues detected — investigate findings`);
        } else {
          recs.push(`${template}: Performance could be improved — review findings`);
        }
        break;
    }
  }

  return recs;
}

// ── Utilities ───────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").substring(0, 100);
}
