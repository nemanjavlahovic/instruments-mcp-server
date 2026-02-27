/**
 * Pre-computed investigation: generates actionable findings at profile time.
 * The agent gets structured findings without needing drill_down.
 */

import type { TimeProfileResult } from "../parsers/time-profiler.js";
import type { HangsResult } from "../parsers/hangs.js";
import type { NetworkResult } from "../parsers/network.js";
import type { LeaksResult } from "../parsers/leaks.js";
import type { SwiftUIProfileResult } from "../parsers/swiftui.js";
import type { AllocationsResult } from "../parsers/allocations.js";
import type { EnergyResult } from "../parsers/energy.js";
import type { AppLaunchResult } from "../parsers/app-launch.js";

// ── Pattern classification helpers ───────────────────────────────────

interface CallTreeData {
  functions: Map<string, {
    name: string;
    module: string;
    selfWeight: number;
    totalWeight: number;
    callers: Map<string, { module: string; weight: number }>;
    callees: Map<string, { module: string; weight: number }>;
  }>;
  totalWeight: number;
}

function classifyModule(module: string, fnName: string): { category: string; hint: string } {
  const m = module.toLowerCase();
  const f = fnName.toLowerCase();

  if (m.includes("sqlite") || m.includes("coredata") || f.includes("sql") || f.includes("fetch")) {
    return { category: "Database I/O", hint: "Move to background queue or batch operations." };
  }
  if (m.includes("urlsession") || m.includes("network") || m.includes("cfnetwork") || f.includes("urlsession")) {
    return { category: "Networking", hint: "Use async/await or move to background thread." };
  }
  if (m.includes("uikit") || m.includes("swiftui") || f.includes("layout") || f.includes("render")) {
    return { category: "UI/Layout", hint: "Simplify view hierarchy or cache layout calculations." };
  }
  if (m.includes("foundation") && (f.includes("json") || f.includes("decode") || f.includes("encode"))) {
    return { category: "Serialization", hint: "Use streaming parser or move to background thread." };
  }
  if (f.includes("dispatch_semaphore") || f.includes("pthread_mutex") || f.includes("os_unfair_lock")) {
    return { category: "Lock contention", hint: "Reduce lock scope or use actor isolation." };
  }
  if (m.includes("imageio") || m.includes("cgimage") || f.includes("image")) {
    return { category: "Image processing", hint: "Downscale before display, use async thumbnailing." };
  }
  return { category: "User code", hint: "Profile further to identify optimization opportunity." };
}

function buildChain(fnName: string, callTree: CallTreeData, direction: "up" | "down", maxDepth = 4): string[] {
  const chain: string[] = [fnName];
  let current = callTree.functions.get(fnName);
  const visited = new Set<string>([fnName]);

  for (let i = 0; i < maxDepth && current; i++) {
    const neighbors = direction === "up" ? current.callers : current.callees;
    let best: string | null = null;
    let bestWeight = 0;
    for (const [name, data] of neighbors) {
      if (data.weight > bestWeight && !visited.has(name)) {
        bestWeight = data.weight;
        best = name;
      }
    }
    if (!best) break;
    if (direction === "up") chain.unshift(best);
    else chain.push(best);
    visited.add(best);
    current = callTree.functions.get(best);
  }
  return chain;
}

// ── CPU Investigation ────────────────────────────────────────────────

function investigateCpu(result: TimeProfileResult, callTree?: CallTreeData | null, traceId?: string): string {
  const lines: string[] = [];
  const topHotspots = result.hotspots.slice(0, 3);

  if (topHotspots.length === 0) {
    lines.push("No significant hotspots detected.");
    return lines.join("\n");
  }

  for (let i = 0; i < topHotspots.length; i++) {
    const h = topHotspots[i];
    const { category, hint } = classifyModule(h.module, h.function);

    let chain: string[] | null = null;
    if (callTree) {
      chain = buildChain(h.function, callTree, "up", 4);
    }

    const sev = h.selfPercent >= 30 ? "CRITICAL" : h.selfPercent >= 10 ? "WARNING" : "INFO";
    lines.push(`#${i + 1} [${sev}] ${h.function} (${h.module}) — ${h.selfWeight.toFixed(1)}ms self (${h.selfPercent.toFixed(1)}%)`);
    if (chain && chain.length > 1) {
      lines.push(`   chain: ${chain.join(" > ")}`);
    }
    lines.push(`   ${category}. ${hint}`);
    lines.push("");
  }

  if (result.mainThreadBlockers.length > 0) {
    lines.push("Main thread blockers:");
    for (const b of result.mainThreadBlockers.slice(0, 3)) {
      lines.push(`  ${b.function} — ${b.durationMs.toFixed(1)}ms [${b.severity}]`);
    }
    lines.push("");
  }

  if (traceId) {
    lines.push("Suggested drill-down:");
    if (topHotspots[0]) {
      lines.push(`  drill_down("${traceId}", "${topHotspots[0].function}")`);
    }
    lines.push(`  drill_down("${traceId}", "hottest")`);
  }

  return lines.join("\n");
}

// ── Hangs Investigation ──────────────────────────────────────────────

function classifyHangBacktrace(backtrace: string[]): { pattern: string; hint: string } {
  const text = backtrace.join(" ").toLowerCase();
  if (text.includes("sqlite") || text.includes("coredata")) {
    return { pattern: "DB on main thread", hint: "Move database operations to a background queue." };
  }
  if (text.includes("urlsession") || text.includes("cfnetwork") || text.includes("nsurlconnection")) {
    return { pattern: "Sync networking", hint: "Use async/await or URLSession with completion handlers off main thread." };
  }
  if (text.includes("dispatch_semaphore") || text.includes("pthread_mutex")) {
    return { pattern: "Lock/deadlock", hint: "Avoid blocking main thread on locks. Use actors or async dispatch." };
  }
  if (text.includes("layout") || text.includes("autolayout") || text.includes("nslayoutconstraint")) {
    return { pattern: "Complex layout", hint: "Simplify Auto Layout constraints or use manual layout for complex views." };
  }
  return { pattern: "Main thread block", hint: "Investigate blocking call and move off main thread." };
}

function investigateHangs(result: HangsResult, traceId?: string): string {
  const lines: string[] = [];

  if (result.totalHangs === 0) {
    lines.push("No hangs detected.");
    return lines.join("\n");
  }

  const worst = result.hangs.slice(0, 3);
  for (let i = 0; i < worst.length; i++) {
    const h = worst[i];
    const sev = h.severity.toUpperCase();
    lines.push(`#${i + 1} [${sev}] ${h.durationMs}ms hang at ${h.startTime}`);
    if (h.backtrace && h.backtrace.length > 0) {
      const { pattern, hint } = classifyHangBacktrace(h.backtrace);
      lines.push(`   pattern: ${pattern}`);
      lines.push(`   stack: ${h.backtrace.slice(0, 4).join(" > ")}`);
      lines.push(`   ${hint}`);
    } else {
      lines.push("   No backtrace available. Run symbolicate_trace for details.");
    }
    lines.push("");
  }

  if (traceId) {
    lines.push("Suggested drill-down:");
    lines.push(`  drill_down("${traceId}", "worst")`);
    lines.push(`  drill_down("${traceId}", "critical")`);
  }

  return lines.join("\n");
}

// ── Network Investigation ────────────────────────────────────────────

function investigateNetwork(result: NetworkResult, traceId?: string): string {
  const lines: string[] = [];

  if (result.totalRequests === 0) {
    lines.push("No network requests captured.");
    return lines.join("\n");
  }

  // Critical domains
  const criticalDomains = result.domains.filter(d => d.severity === "critical");
  if (criticalDomains.length > 0) {
    lines.push("Critical domains:");
    for (const d of criticalDomains) {
      lines.push(`  ${d.domain} — max: ${d.maxDurationMs.toFixed(0)}ms, errors: ${d.errorCount}/${d.requestCount}`);
    }
    lines.push("");
  }

  // Slowest requests
  if (result.slowestRequests.length > 0) {
    lines.push("Slowest requests:");
    for (const r of result.slowestRequests.slice(0, 3)) {
      lines.push(`  ${r.method} ${r.url} — ${r.durationMs.toFixed(0)}ms (status ${r.statusCode ?? "?"})`);
    }
    lines.push("");
  }

  // Error summary
  if (result.failedRequests.length > 0) {
    lines.push(`Errors: ${result.failedRequests.length} failed requests (${result.errorRate.toFixed(1)}% error rate)`);
    for (const r of result.failedRequests.slice(0, 3)) {
      lines.push(`  ${r.statusCode} ${r.method} ${r.url}`);
    }
    lines.push("");
  }

  if (traceId) {
    lines.push("Suggested drill-down:");
    if (criticalDomains[0]) {
      lines.push(`  drill_down("${traceId}", "${criticalDomains[0].domain}")`);
    }
    lines.push(`  drill_down("${traceId}", "errors")`);
    lines.push(`  drill_down("${traceId}", "slow")`);
  }

  return lines.join("\n");
}

// ── Leaks Investigation ──────────────────────────────────────────────

function investigateLeaks(result: LeaksResult, traceId?: string): string {
  const lines: string[] = [];

  if (result.totalLeaks === 0) {
    lines.push("No memory leaks detected.");
    return lines.join("\n");
  }

  const topGroups = result.leakGroups.slice(0, 3);
  const userLeaks = result.leakGroups.filter(g => {
    const lib = (g.responsibleLibrary || "").toLowerCase();
    return !lib.includes("uikit") && !lib.includes("foundation") && !lib.includes("coredata") &&
           !lib.includes("cfnetwork") && !lib.includes("libdispatch") && !lib.includes("libobjc");
  });

  for (let i = 0; i < topGroups.length; i++) {
    const g = topGroups[i];
    const sev = g.severity.toUpperCase();
    const lib = g.responsibleLibrary ? ` via ${g.responsibleLibrary}` : "";
    lines.push(`#${i + 1} [${sev}] ${g.objectType}${lib} — ×${g.count}  ${(g.totalBytes / 1024).toFixed(1)} KB`);
  }
  lines.push("");

  if (userLeaks.length > 0 && userLeaks.length !== topGroups.length) {
    lines.push(`User-code leaks: ${userLeaks.length} types (${userLeaks.reduce((s, g) => s + g.count, 0)} objects)`);
    lines.push("");
  }

  if (traceId) {
    lines.push("Suggested drill-down:");
    if (topGroups[0]) {
      lines.push(`  drill_down("${traceId}", "${topGroups[0].objectType}")`);
    }
    lines.push(`  drill_down("${traceId}", "largest")`);
  }

  return lines.join("\n");
}

// ── SwiftUI Investigation ────────────────────────────────────────────

function investigateSwiftUI(result: SwiftUIProfileResult, traceId?: string): string {
  const lines: string[] = [];

  if (result.views.length === 0) {
    lines.push("No SwiftUI view evaluations captured.");
    return lines.join("\n");
  }

  const excessive = result.excessiveEvaluations;
  if (excessive.length > 0) {
    lines.push("Excessive re-renders:");
    for (const v of excessive.slice(0, 5)) {
      const sev = v.severity.toUpperCase();
      const dur = v.totalDurationUs > 1000
        ? `${(v.totalDurationUs / 1000).toFixed(1)}ms`
        : `${v.totalDurationUs}μs`;
      lines.push(`  [${sev}] ${v.viewName} — ×${v.evaluationCount} evals, ${dur} total`);
      if (v.evaluationCount > 100) {
        lines.push("    Likely missing Equatable conformance or unstable @State.");
      } else if (v.totalDurationUs > 50000) {
        lines.push("    Expensive body. Extract subviews or use lazy containers.");
      }
    }
  } else {
    lines.push("All views within normal evaluation thresholds.");
  }

  if (traceId) {
    lines.push("");
    lines.push("Suggested drill-down:");
    lines.push(`  drill_down("${traceId}", "excessive")`);
    lines.push(`  drill_down("${traceId}", "worst")`);
  }

  return lines.join("\n");
}

// ── Allocations Investigation ────────────────────────────────────────

function investigateAllocations(result: AllocationsResult, traceId?: string): string {
  const lines: string[] = [];

  if (result.categories.length === 0) {
    lines.push("No allocation data captured.");
    return lines.join("\n");
  }

  const topCats = result.categories.slice(0, 3);
  for (let i = 0; i < topCats.length; i++) {
    const c = topCats[i];
    const sev = c.severity.toUpperCase();
    const pRatio = c.count > 0 ? (c.persistent / c.count) * 100 : 0;
    lines.push(`#${i + 1} [${sev}] ${c.category} — ×${c.count}  ${c.totalKB.toFixed(1)} KB  persistent: ${pRatio.toFixed(0)}%`);
    if (pRatio > 80) {
      lines.push("    High persistent ratio. Check for retain cycles or unbounded caches.");
    }
  }

  if (traceId) {
    lines.push("");
    lines.push("Suggested drill-down:");
    lines.push(`  drill_down("${traceId}", "persistent")`);
    lines.push(`  drill_down("${traceId}", "largest")`);
  }

  return lines.join("\n");
}

// ── Energy Investigation ─────────────────────────────────────────────

function investigateEnergy(result: EnergyResult, traceId?: string): string {
  const lines: string[] = [];

  if (result.totalSamples === 0) {
    lines.push("No energy data captured.");
    return lines.join("\n");
  }

  // Worst component
  if (result.topComponents.length > 0) {
    const worst = result.topComponents[0];
    lines.push(`Worst component: ${worst.component} — avg: ${worst.averageImpact.toFixed(1)}, peak: ${worst.peakImpact.toFixed(1)}`);
    if (worst.component.toLowerCase().includes("cpu")) {
      lines.push("  Reduce background processing, use Energy-aware scheduling.");
    } else if (worst.component.toLowerCase().includes("network")) {
      lines.push("  Batch network requests, use URLSession background configuration.");
    } else if (worst.component.toLowerCase().includes("gpu")) {
      lines.push("  Reduce overdraw, simplify animations, use drawingGroup().");
    }
    lines.push("");
  }

  if (result.thermalState && result.thermalState !== "nominal") {
    lines.push(`⚠ Thermal state: ${result.thermalState}. Device throttling may affect measurements.`);
    lines.push("");
  }

  if (result.timeInHighEnergyPct > 25) {
    lines.push(`${result.timeInHighEnergyPct.toFixed(0)}% time in high-energy state. Optimize hot paths.`);
    lines.push("");
  }

  if (traceId) {
    lines.push("Suggested drill-down:");
    lines.push(`  drill_down("${traceId}", "worst")`);
    if (result.topComponents[0]) {
      lines.push(`  drill_down("${traceId}", "${result.topComponents[0].component}")`);
    }
  }

  return lines.join("\n");
}

// ── Launch Investigation ─────────────────────────────────────────────

function investigateLaunch(result: AppLaunchResult, traceId?: string): string {
  const lines: string[] = [];

  if (result.phases.length === 0) {
    lines.push(`Launch: ${result.totalLaunchMs.toFixed(0)}ms (${result.launchType}). No phase breakdown available.`);
    return lines.join("\n");
  }

  // Apple targets
  const targets: Record<string, number> = {
    cold: 400, warm: 200, resume: 200, unknown: 400,
  };
  const target = targets[result.launchType] || 400;
  lines.push(`Launch: ${result.totalLaunchMs.toFixed(0)}ms (${result.launchType}) — Apple target: <${target}ms`);
  lines.push("");

  // Slowest phase
  const slowest = result.phases[0]; // already sorted by duration desc
  if (slowest) {
    const sev = slowest.severity.toUpperCase();
    lines.push(`Slowest phase: [${sev}] ${slowest.name} — ${slowest.durationMs.toFixed(0)}ms`);
    const phaseLower = slowest.name.toLowerCase();
    if (phaseLower.includes("dylib") || phaseLower.includes("dynamic")) {
      lines.push("  Reduce dynamic library count, use static linking.");
    } else if (phaseLower.includes("main") || phaseLower.includes("first frame")) {
      lines.push("  Defer non-essential initialization to after first frame.");
    } else if (phaseLower.includes("static")) {
      lines.push("  Reduce +load methods and static initializers.");
    }
    lines.push("");
  }

  if (traceId) {
    lines.push("Suggested drill-down:");
    lines.push(`  drill_down("${traceId}", "slowest")`);
    if (slowest) {
      lines.push(`  drill_down("${traceId}", "${slowest.name}")`);
    }
  }

  return lines.join("\n");
}

// ── Main Dispatcher ──────────────────────────────────────────────────

export function autoInvestigate(
  template: string,
  result: Record<string, unknown>,
  callTreeData?: CallTreeData | null,
  traceId?: string,
): string {
  const t = template.toLowerCase();
  let investigation = "";

  if (t.includes("time") || t.includes("cpu") || t.includes("profiler")) {
    investigation = investigateCpu(result as unknown as TimeProfileResult, callTreeData, traceId);
  } else if (t.includes("hitch") || t.includes("hang") || t.includes("animation")) {
    investigation = investigateHangs(result as unknown as HangsResult, traceId);
  } else if (t.includes("network")) {
    investigation = investigateNetwork(result as unknown as NetworkResult, traceId);
  } else if (t.includes("leak")) {
    investigation = investigateLeaks(result as unknown as LeaksResult, traceId);
  } else if (t.includes("swiftui")) {
    investigation = investigateSwiftUI(result as unknown as SwiftUIProfileResult, traceId);
  } else if (t.includes("alloc")) {
    investigation = investigateAllocations(result as unknown as AllocationsResult, traceId);
  } else if (t.includes("energy")) {
    investigation = investigateEnergy(result as unknown as EnergyResult, traceId);
  } else if (t.includes("launch")) {
    investigation = investigateLaunch(result as unknown as AppLaunchResult, traceId);
  } else {
    return "";
  }

  return investigation ? `-- Investigation --\n${investigation}` : "";
}
