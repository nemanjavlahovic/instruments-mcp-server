/**
 * Compact text formatters for profile results.
 * Each formatter produces human-readable text ~50% smaller than JSON.stringify.
 */

import type { TimeProfileResult } from "../parsers/time-profiler.js";
import type { SwiftUIProfileResult } from "../parsers/swiftui.js";
import type { AllocationsResult } from "../parsers/allocations.js";
import type { HangsResult } from "../parsers/hangs.js";
import type { AppLaunchResult } from "../parsers/app-launch.js";
import type { EnergyResult } from "../parsers/energy.js";
import type { LeaksResult } from "../parsers/leaks.js";
import type { NetworkResult } from "../parsers/network.js";
import type { DrillDownResult } from "./trace-store.js";

// ── Helpers ──────────────────────────────────────────────────────────

function bar(pct: number, maxWidth = 20): string {
  const filled = Math.round((pct / 100) * maxWidth);
  return "━".repeat(Math.max(filled, 0)) + "╌".repeat(Math.max(maxWidth - filled, 0));
}

function severityTag(s: string): string {
  const upper = s.toUpperCase();
  if (upper === "CRITICAL") return "[CRITICAL]";
  if (upper === "WARNING") return "[WARNING]";
  if (upper === "MICRO") return "[micro]";
  if (upper === "MINOR") return "[minor]";
  return "[OK]";
}

function traceFooter(traceId: string, tracePath: string): string {
  return `trace: ${traceId} | path: ${tracePath}`;
}

/**
 * Shorten C++ mangled / Swift template names for LLM readability.
 * "swift::RefCounts<swift::RefCountBitsT<(swift::RefCountInlinedness)1>>::doDecrementSlow<(swift::PerformDeinit)1>"
 *  → "RefCounts::doDecrementSlow"
 * "specialized implicit closure #1 in closure #1 in Attribute.init<A>(_:)"
 *  → "Attribute.init(_:)"
 */
export function shortenName(name: string): string {
  // Strip template parameters: Foo<Bar, Baz>::method<T> → Foo::method
  let s = name.replace(/<[^<>]*>/g, "");
  // Repeat for nested templates
  while (s.includes("<")) s = s.replace(/<[^<>]*>/g, "");

  // Strip namespaces but keep the last two segments: a::b::c::d → c::d
  const parts = s.split("::");
  if (parts.length > 2) {
    s = parts.slice(-2).join("::");
  }

  // Strip "specialized " and closure noise from Swift
  s = s.replace(/^specialized\s+/, "");
  s = s.replace(/implicit closure #\d+ in /g, "");
  s = s.replace(/closure #\d+ in /g, "");

  // Strip leading whitespace artifacts
  s = s.trim();

  // Cap at 80 chars
  if (s.length > 80) s = s.slice(0, 77) + "...";

  return s || name.slice(0, 80);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ── CPU Profile ──────────────────────────────────────────────────────

export function formatCpuProfile(result: TimeProfileResult, traceId: string, tracePath: string): string {
  const lines: string[] = [];
  lines.push(`=== Time Profiler ===  severity: ${severityTag(result.severity)}  samples: ${result.totalSamples}`);
  lines.push("");

  if (result.hotspots.length > 0) {
    lines.push("Hotspots:");
    for (const h of result.hotspots.slice(0, 15)) {
      const pct = h.selfPercent;
      lines.push(`  ${shortenName(h.function)} (${h.module})  ${h.selfWeight.toFixed(1)}ms self ${bar(pct, 15)} ${pct.toFixed(1)}%`);
    }
  }

  if (result.mainThreadBlockers.length > 0) {
    lines.push("");
    lines.push("Main thread blockers:");
    for (const b of result.mainThreadBlockers) {
      lines.push(`  ${severityTag(b.severity)} ${shortenName(b.function)}  ${b.durationMs.toFixed(1)}ms`);
    }
  }

  if (result.needsSymbolication) {
    lines.push("");
    lines.push("⚠ Many unsymbolicated frames. Run symbolicate_trace for better results.");
  }

  lines.push("");
  lines.push(traceFooter(traceId, tracePath));
  return lines.join("\n");
}

// ── Hangs Profile ────────────────────────────────────────────────────

export function formatHangsProfile(result: HangsResult, traceId: string, tracePath: string): string {
  const lines: string[] = [];
  lines.push(`=== Animation Hitches ===  severity: ${severityTag(result.severity)}  total: ${result.totalHangs} (${result.criticalHangs} critical, ${result.warningHangs} warning, ${result.minorHangs} minor, ${result.microHangs} micro)`);
  lines.push("");

  if (result.hangs.length > 0) {
    lines.push("Hang events:");
    for (const h of result.hangs.slice(0, 10)) {
      lines.push(`  ${severityTag(h.severity)} ${h.durationMs}ms  start: ${h.startTime}`);
      if (h.backtrace && h.backtrace.length > 0) {
        const frames = h.backtrace.slice(0, 5);
        lines.push(`    stack: ${frames.join(" > ")}`);
      }
    }
  }

  lines.push("");
  lines.push(traceFooter(traceId, tracePath));
  return lines.join("\n");
}

// ── Network Profile ──────────────────────────────────────────────────

export function formatNetworkProfile(result: NetworkResult, traceId: string, tracePath: string): string {
  const lines: string[] = [];
  lines.push(`=== Network ===  severity: ${severityTag(result.severity)}  requests: ${result.totalRequests}  avg: ${result.avgDurationMs.toFixed(0)}ms  errors: ${result.errorRate.toFixed(1)}%`);
  lines.push("");

  if (result.domains.length > 0) {
    lines.push("Domains:");
    for (const d of result.domains.slice(0, 10)) {
      lines.push(`  ${severityTag(d.severity)} ${d.domain}  ${d.requestCount} reqs  avg: ${d.avgDurationMs.toFixed(0)}ms  max: ${d.maxDurationMs.toFixed(0)}ms  errors: ${d.errorCount}`);
    }
  }

  if (result.slowestRequests.length > 0) {
    lines.push("");
    lines.push("Slowest requests:");
    for (const r of result.slowestRequests.slice(0, 5)) {
      lines.push(`  ${severityTag(r.severity)} ${r.method} ${r.url}  ${r.durationMs.toFixed(0)}ms  status: ${r.statusCode ?? "?"}`);
    }
  }

  if (result.failedRequests.length > 0) {
    lines.push("");
    lines.push("Failed requests:");
    for (const r of result.failedRequests.slice(0, 5)) {
      lines.push(`  ${r.method} ${r.url}  status: ${r.statusCode}  ${r.durationMs.toFixed(0)}ms`);
    }
  }

  lines.push("");
  lines.push(traceFooter(traceId, tracePath));
  return lines.join("\n");
}

// ── Leaks Profile ────────────────────────────────────────────────────

export function formatLeaksProfile(result: LeaksResult, traceId: string, tracePath: string): string {
  const lines: string[] = [];
  lines.push(`=== Leaks ===  severity: ${severityTag(result.severity)}  total: ${result.totalLeaks} objects  ${formatBytes(result.totalLeakedBytes)}`);
  lines.push("");

  if (result.leakGroups.length > 0) {
    lines.push("Leak groups:");
    for (const g of result.leakGroups.slice(0, 15)) {
      const lib = g.responsibleLibrary ? ` (${g.responsibleLibrary})` : "";
      lines.push(`  ${severityTag(g.severity)} ${g.objectType}${lib}  ×${g.count}  ${formatBytes(g.totalBytes)}`);
    }
  }

  if (result.responsibleLibraries.length > 0) {
    lines.push("");
    lines.push("By library:");
    for (const lib of result.responsibleLibraries.slice(0, 10)) {
      lines.push(`  ${lib.library}  ${lib.leakCount} leaks  ${formatBytes(lib.totalBytes)}`);
    }
  }

  lines.push("");
  lines.push(traceFooter(traceId, tracePath));
  return lines.join("\n");
}

// ── SwiftUI Profile ──────────────────────────────────────────────────

export function formatSwiftUIProfile(result: SwiftUIProfileResult, traceId: string, tracePath: string): string {
  const lines: string[] = [];
  const worstSeverity = result.excessiveEvaluations.length > 0
    ? (result.excessiveEvaluations.some(v => v.severity === "critical") ? "critical" : "warning")
    : "ok";
  lines.push(`=== SwiftUI ===  severity: ${severityTag(worstSeverity)}  total evals: ${result.totalBodyEvaluations}  views: ${result.views.length}`);
  lines.push("");

  if (result.views.length > 0) {
    lines.push("Views:");
    for (const v of result.views.slice(0, 15)) {
      const durLabel = v.totalDurationUs > 1000
        ? `${(v.totalDurationUs / 1000).toFixed(1)}ms`
        : `${v.totalDurationUs}μs`;
      lines.push(`  ${severityTag(v.severity)} ${v.viewName}  ×${v.evaluationCount}  ${durLabel}`);
    }
  }

  if (result.excessiveEvaluations.length > 0) {
    lines.push("");
    lines.push(`Excessive re-renders: ${result.excessiveEvaluations.length} views flagged`);
  }

  lines.push("");
  lines.push(traceFooter(traceId, tracePath));
  return lines.join("\n");
}

// ── Allocations Profile ──────────────────────────────────────────────

export function formatAllocationsProfile(result: AllocationsResult, traceId: string, tracePath: string): string {
  const lines: string[] = [];
  const worstSeverity = result.categories.length > 0
    ? (result.categories.some(c => c.severity === "critical") ? "critical"
      : result.categories.some(c => c.severity === "warning") ? "warning" : "ok")
    : "ok";
  lines.push(`=== Allocations ===  severity: ${severityTag(worstSeverity)}  total: ${result.totalAllocations} allocs  ${result.totalMB.toFixed(1)} MB`);
  lines.push("");

  if (result.categories.length > 0) {
    lines.push("Categories:");
    for (const c of result.categories.slice(0, 15)) {
      const pRatio = c.count > 0 ? ((c.persistent / c.count) * 100).toFixed(0) : "0";
      lines.push(`  ${severityTag(c.severity)} ${c.category}  ×${c.count}  ${c.totalKB.toFixed(1)} KB  persistent: ${pRatio}%`);
    }
  }

  lines.push("");
  lines.push(traceFooter(traceId, tracePath));
  return lines.join("\n");
}

// ── Energy Profile ───────────────────────────────────────────────────

export function formatEnergyProfile(result: EnergyResult, traceId: string, tracePath: string): string {
  const lines: string[] = [];
  lines.push(`=== Energy Log ===  severity: ${severityTag(result.severity)}  avg: ${result.averageEnergyImpact.toFixed(1)}/20  peak: ${result.peakEnergyImpact.toFixed(1)}/20  high-energy: ${result.timeInHighEnergyPct.toFixed(0)}%`);
  lines.push("");

  if (result.topComponents.length > 0) {
    lines.push("Components:");
    for (const c of result.topComponents) {
      lines.push(`  ${c.component}  avg: ${c.averageImpact.toFixed(1)}  peak: ${c.peakImpact.toFixed(1)}  ${bar(c.averageImpact * 5, 15)}`);
    }
  }

  if (result.thermalState) {
    lines.push("");
    lines.push(`Thermal state: ${result.thermalState}`);
  }

  lines.push("");
  lines.push(traceFooter(traceId, tracePath));
  return lines.join("\n");
}

// ── Launch Profile ───────────────────────────────────────────────────

export function formatLaunchProfile(result: AppLaunchResult, traceId: string, tracePath: string): string {
  const lines: string[] = [];
  lines.push(`=== App Launch ===  severity: ${severityTag(result.severity)}  total: ${result.totalLaunchMs.toFixed(0)}ms  type: ${result.launchType}`);
  lines.push("");

  if (result.phases.length > 0) {
    const maxDur = Math.max(...result.phases.map(p => p.durationMs), 1);
    lines.push("Phases:");
    for (const p of result.phases) {
      const pct = (p.durationMs / maxDur) * 100;
      lines.push(`  ${severityTag(p.severity)} ${p.name}  ${p.durationMs.toFixed(0)}ms  ${bar(pct, 15)}`);
    }
  }

  lines.push("");
  lines.push(traceFooter(traceId, tracePath));
  return lines.join("\n");
}

// ── Drill-Down Formatter ─────────────────────────────────────────────

export function formatDrillDown(result: DrillDownResult): string {
  const lines: string[] = [];
  lines.push(`=== Drill Down: ${result.target} ===  template: ${result.template}`);
  lines.push("");

  // CPU call tree result
  if (result.function) {
    lines.push(`Function: ${shortenName(result.function)}  module: ${result.module}`);
    lines.push(`  self: ${result.selfWeight}ms (${result.selfPct}%)  total: ${result.totalWeight}ms (${result.totalPct}%)`);

    if (result.callers && result.callers.length > 0) {
      lines.push("");
      lines.push("Callers (who calls this):");
      for (const c of result.callers) {
        lines.push(`  ${shortenName(c.function)} (${c.module})  ${c.weight}ms  ${c.pct}%`);
      }
    }

    if (result.callees && result.callees.length > 0) {
      lines.push("");
      lines.push("Callees (what this calls):");
      for (const c of result.callees) {
        lines.push(`  ${shortenName(c.function)} (${c.module})  ${c.weight}ms  ${c.pct}%`);
      }
    }

    if (result.heaviestPath && result.heaviestPath.length > 1) {
      lines.push("");
      lines.push(`Heaviest path: ${result.heaviestPath.join(" > ")}`);
    }
  }

  // Generic rows result
  if (result.rows) {
    lines.push(`Rows: ${result.matchingRows} matching / ${result.totalRows} total`);
    lines.push("");
    for (const row of result.rows) {
      const parts: string[] = [];
      for (const [key, val] of Object.entries(row)) {
        parts.push(`${key}: ${val}`);
      }
      lines.push(`  ${parts.join("  ")}`);
    }
  }

  if (result.hint) {
    lines.push("");
    lines.push(result.hint);
  }

  return lines.join("\n");
}

// ── Dispatcher ───────────────────────────────────────────────────────

export function formatProfileResult(
  template: string,
  result: Record<string, unknown>,
  traceId: string,
  tracePath: string,
): string {
  const t = template.toLowerCase();

  if (t.includes("time") || t.includes("cpu") || t.includes("profiler")) {
    return formatCpuProfile(result as unknown as TimeProfileResult, traceId, tracePath);
  }
  if (t.includes("hitch") || t.includes("hang") || t.includes("animation")) {
    return formatHangsProfile(result as unknown as HangsResult, traceId, tracePath);
  }
  if (t.includes("network")) {
    return formatNetworkProfile(result as unknown as NetworkResult, traceId, tracePath);
  }
  if (t.includes("leak")) {
    return formatLeaksProfile(result as unknown as LeaksResult, traceId, tracePath);
  }
  if (t.includes("swiftui")) {
    return formatSwiftUIProfile(result as unknown as SwiftUIProfileResult, traceId, tracePath);
  }
  if (t.includes("alloc")) {
    return formatAllocationsProfile(result as unknown as AllocationsResult, traceId, tracePath);
  }
  if (t.includes("energy")) {
    return formatEnergyProfile(result as unknown as EnergyResult, traceId, tracePath);
  }
  if (t.includes("launch")) {
    return formatLaunchProfile(result as unknown as AppLaunchResult, traceId, tracePath);
  }

  // Fallback: summary + trace footer
  const summary = (result as { summary?: string }).summary;
  const severity = (result as { severity?: string }).severity;
  const lines: string[] = [];
  lines.push(`=== ${template} ===  severity: ${severityTag(severity || "ok")}`);
  if (summary) lines.push(summary);
  lines.push("");
  lines.push(traceFooter(traceId, tracePath));
  return lines.join("\n");
}
