/**
 * In-memory store for parsed trace data, enabling multi-turn investigation.
 * Traces are stored after profiling and queried via drill_down/list_traces tools.
 */

import { parseXml } from "./xml.js";
import { extractRows, isRow, type Row } from "./extractors.js";

// ── Types ────────────────────────────────────────────────────────────

export interface StoredTrace {
  traceId: string;
  tracePath: string;
  template: string;
  storedAt: number;
  tableXml: string;
  /** Parsed result from the template parser, for template-specific drill-down. */
  parsedResult?: Record<string, unknown>;
  /** Pre-computed investigation string from autoInvestigate. */
  investigation?: string;
  /** Lazily built call tree. `false` means attempted but not buildable. */
  _callTree?: CallTreeData | false;
}

export interface CallTreeData {
  functions: Map<string, FunctionProfile>;
  totalWeight: number;
}

export interface FunctionProfile {
  name: string;
  module: string;
  selfWeight: number;
  totalWeight: number;
  callers: Map<string, { module: string; weight: number }>;
  callees: Map<string, { module: string; weight: number }>;
}

export interface DrillDownResult {
  template: string;
  target: string;
  // CPU call tree fields
  function?: string;
  module?: string;
  selfWeight?: number;
  totalWeight?: number;
  selfPct?: number;
  totalPct?: number;
  callers?: Array<{ function: string; module: string; weight: number; pct: number }>;
  callees?: Array<{ function: string; module: string; weight: number; pct: number }>;
  heaviestPath?: string[];
  // Generic fields (non-CPU)
  totalRows?: number;
  matchingRows?: number;
  rows?: Array<Record<string, unknown>>;
  hint?: string;
}

// ── Store ────────────────────────────────────────────────────────────

const MAX_TRACES = 20;
const store = new Map<string, StoredTrace>();

function generateId(): string {
  return `t_${Math.random().toString(36).substring(2, 8)}`;
}

export function storeTrace(opts: {
  tracePath: string;
  template: string;
  tableXml: string;
  parsedResult?: Record<string, unknown>;
  investigation?: string;
}): string {
  // Evict oldest if at capacity
  if (store.size >= MAX_TRACES) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, t] of store) {
      if (t.storedAt < oldestTime) {
        oldestTime = t.storedAt;
        oldestId = id;
      }
    }
    if (oldestId) store.delete(oldestId);
  }

  const traceId = generateId();
  store.set(traceId, {
    traceId,
    tracePath: opts.tracePath,
    template: opts.template,
    storedAt: Date.now(),
    tableXml: opts.tableXml,
    parsedResult: opts.parsedResult,
    investigation: opts.investigation,
  });
  return traceId;
}

export function getTrace(traceId: string): StoredTrace | null {
  return store.get(traceId) ?? null;
}

export function listTraces(): Array<{
  traceId: string;
  tracePath: string;
  template: string;
  storedAt: string;
  canDrillDown: boolean;
  investigationPreview?: string;
}> {
  return [...store.values()]
    .sort((a, b) => b.storedAt - a.storedAt)
    .map((t) => ({
      traceId: t.traceId,
      tracePath: t.tracePath,
      template: t.template,
      storedAt: new Date(t.storedAt).toISOString(),
      canDrillDown: true,
      investigationPreview: t.investigation
        ? t.investigation.split("\n").find(l => l.startsWith("#1")) || t.investigation.split("\n")[1]
        : undefined,
    }));
}

/** For testing only. */
export function clearStore(): void {
  store.clear();
}

// ── Call Tree Builder ────────────────────────────────────────────────

export function getOrBuildCallTree(trace: StoredTrace): CallTreeData | null {
  if (trace._callTree === false) return null;
  if (trace._callTree) return trace._callTree;

  const t = trace.template.toLowerCase();
  const isCpu = t.includes("time") || t.includes("cpu") || t.includes("profiler");
  if (!isCpu) {
    trace._callTree = false;
    return null;
  }

  const data = parseXml(trace.tableXml);
  const rows = extractRows(data);
  const functions = new Map<string, FunctionProfile>();
  let totalWeight = 0;

  for (const row of rows) {
    const weight = extractWeight(row) || 1;
    const frames = extractFrames(row);
    if (frames.length === 0) continue;

    totalWeight += weight;

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (isUnsymbolicated(frame.name)) continue;

      let profile = functions.get(frame.name);
      if (!profile) {
        profile = {
          name: frame.name,
          module: frame.module,
          selfWeight: 0,
          totalWeight: 0,
          callers: new Map(),
          callees: new Map(),
        };
        functions.set(frame.name, profile);
      }

      profile.totalWeight += weight;
      if (i === 0) profile.selfWeight += weight;

      // Caller = frames[i+1] (one level up the stack)
      if (i < frames.length - 1) {
        const caller = frames[i + 1];
        if (!isUnsymbolicated(caller.name)) {
          const existing = profile.callers.get(caller.name);
          if (existing) existing.weight += weight;
          else profile.callers.set(caller.name, { module: caller.module, weight });
        }
      }

      // Callee = frames[i-1] (one level down toward leaf)
      if (i > 0) {
        const callee = frames[i - 1];
        if (!isUnsymbolicated(callee.name)) {
          const existing = profile.callees.get(callee.name);
          if (existing) existing.weight += weight;
          else profile.callees.set(callee.name, { module: callee.module, weight });
        }
      }
    }
  }

  if (functions.size === 0) {
    trace._callTree = false;
    return null;
  }

  const callTree: CallTreeData = { functions, totalWeight };
  trace._callTree = callTree;
  return callTree;
}

// ── Drill Down ───────────────────────────────────────────────────────

export function drillDown(traceId: string, target: string): DrillDownResult | null {
  const trace = store.get(traceId);
  if (!trace) return null;

  const callTree = getOrBuildCallTree(trace);
  if (callTree) return drillDownCpu(trace, callTree, target);

  // Template-specific drill-down using stored parsed results
  const t = trace.template.toLowerCase();
  if (trace.parsedResult) {
    if (t.includes("hitch") || t.includes("hang") || t.includes("animation")) {
      return drillDownHangs(trace, target);
    }
    if (t.includes("network")) {
      return drillDownNetwork(trace, target);
    }
    if (t.includes("leak")) {
      return drillDownLeaks(trace, target);
    }
    if (t.includes("alloc")) {
      return drillDownAllocations(trace, target);
    }
    if (t.includes("swiftui")) {
      return drillDownSwiftUI(trace, target);
    }
    if (t.includes("energy")) {
      return drillDownEnergy(trace, target);
    }
    if (t.includes("launch")) {
      return drillDownLaunch(trace, target);
    }
  }

  return drillDownGeneric(trace, target);
}

function drillDownCpu(
  trace: StoredTrace,
  callTree: CallTreeData,
  target: string,
): DrillDownResult {
  const total = callTree.totalWeight;

  // Handle special targets
  if (target === "hottest" || target === "heaviest") {
    let hottest: FunctionProfile | null = null;
    let maxSelf = 0;
    for (const p of callTree.functions.values()) {
      if (p.selfWeight > maxSelf) {
        maxSelf = p.selfWeight;
        hottest = p;
      }
    }
    if (hottest) {
      target = hottest.name;
    } else {
      return { template: trace.template, target, hint: "No functions found in trace data." };
    }
  }

  // Find function: exact match first, then best substring match
  let profile = callTree.functions.get(target);
  if (!profile) {
    const lower = target.toLowerCase();
    let bestLen = Infinity;
    for (const [name, p] of callTree.functions) {
      if (name.toLowerCase().includes(lower) && name.length < bestLen) {
        profile = p;
        bestLen = name.length;
      }
    }
  }

  if (!profile) {
    const available = [...callTree.functions.values()]
      .sort((a, b) => b.selfWeight - a.selfWeight)
      .slice(0, 15)
      .map((p) => `${p.name} (${p.module}, ${pct(p.selfWeight, total)}% self)`);
    return {
      template: trace.template,
      target,
      hint: `Function "${target}" not found. Top functions by self time:\n${available.join("\n")}`,
    };
  }

  const callers = [...profile.callers.entries()]
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 10)
    .map(([fn, data]) => ({
      function: fn,
      module: data.module,
      weight: round2(data.weight),
      pct: pct(data.weight, profile!.totalWeight),
    }));

  const callees = [...profile.callees.entries()]
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 10)
    .map(([fn, data]) => ({
      function: fn,
      module: data.module,
      weight: round2(data.weight),
      pct: pct(data.weight, profile!.totalWeight),
    }));

  // Heaviest path: follow highest-weight callee from this function
  const heaviestPath = [profile.name];
  let current = profile;
  const visited = new Set<string>([current.name]);
  for (let depth = 0; depth < 10; depth++) {
    let heaviest: string | null = null;
    let heaviestWeight = 0;
    for (const [fn, data] of current.callees) {
      if (data.weight > heaviestWeight && !visited.has(fn)) {
        heaviestWeight = data.weight;
        heaviest = fn;
      }
    }
    if (!heaviest) break;
    heaviestPath.push(heaviest);
    visited.add(heaviest);
    const next = callTree.functions.get(heaviest);
    if (!next) break;
    current = next;
  }

  return {
    template: trace.template,
    target: profile.name,
    function: profile.name,
    module: profile.module,
    selfWeight: round2(profile.selfWeight),
    totalWeight: round2(profile.totalWeight),
    selfPct: pct(profile.selfWeight, total),
    totalPct: pct(profile.totalWeight, total),
    callers,
    callees,
    heaviestPath,
  };
}

function drillDownGeneric(trace: StoredTrace, target: string): DrillDownResult {
  const data = parseXml(trace.tableXml);
  const rows = extractRows(data);
  const lower = target.toLowerCase();

  const matches = rows.filter((row) => {
    const text = JSON.stringify(row).toLowerCase();
    return text.includes(lower);
  });

  const formatted = matches.slice(0, 20).map((row) => {
    const fields: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(row)) {
      if (key.startsWith("@_")) continue;
      if (isRow(val)) {
        fields[key] = val["@_fmt"] || val["#text"] || val;
      } else if (Array.isArray(val)) {
        fields[key] = val.map((item: unknown) => {
          if (isRow(item)) return item["@_name"] || item["@_fmt"] || item["#text"];
          return item;
        });
      } else {
        fields[key] = val;
      }
    }
    return fields;
  });

  return {
    template: trace.template,
    target,
    totalRows: rows.length,
    matchingRows: matches.length,
    rows: formatted,
    hint:
      matches.length > 20
        ? `Showing first 20 of ${matches.length} matches. Refine your target.`
        : matches.length === 0
          ? `No rows matching "${target}". Try a different search term.`
          : undefined,
  };
}

// ── Template-Specific Drill-Down Handlers ────────────────────────────

function drillDownHangs(trace: StoredTrace, target: string): DrillDownResult {
  const result = trace.parsedResult as { hangs?: Array<Record<string, unknown>>; totalHangs?: number };
  const hangs = result?.hangs || [];
  const lower = target.toLowerCase();

  let filtered: Array<Record<string, unknown>>;
  if (lower === "worst" || lower === "critical") {
    filtered = hangs.filter((h) => {
      const sev = String(h.severity || "").toLowerCase();
      return sev === "critical" || sev === "warning";
    });
    if (filtered.length === 0) filtered = hangs.slice(0, 5);
  } else if (lower.includes("ms")) {
    const thresholdMatch = lower.match(/(\d+)\s*ms/);
    if (thresholdMatch) {
      const threshold = parseInt(thresholdMatch[1]);
      filtered = hangs.filter((h) => (h.durationMs as number) >= threshold);
    } else {
      filtered = hangs;
    }
  } else if (/^\d+$/.test(target)) {
    const idx = parseInt(target);
    filtered = idx < hangs.length ? [hangs[idx]] : [];
  } else {
    filtered = hangs.filter((h) => JSON.stringify(h).toLowerCase().includes(lower));
  }

  return {
    template: trace.template,
    target,
    totalRows: hangs.length,
    matchingRows: filtered.length,
    rows: filtered.slice(0, 20),
    hint: filtered.length === 0 ? `No hangs matching "${target}". Try "worst", "critical", or a duration like "500ms+".` : undefined,
  };
}

function drillDownNetwork(trace: StoredTrace, target: string): DrillDownResult {
  const result = trace.parsedResult as {
    domains?: Array<Record<string, unknown>>;
    slowestRequests?: Array<Record<string, unknown>>;
    failedRequests?: Array<Record<string, unknown>>;
    totalRequests?: number;
  };
  const lower = target.toLowerCase();

  if (lower === "errors" || lower === "failed") {
    const failed = result?.failedRequests || [];
    return {
      template: trace.template, target,
      totalRows: result?.totalRequests || 0,
      matchingRows: failed.length,
      rows: failed.slice(0, 20),
      hint: failed.length === 0 ? "No failed requests." : undefined,
    };
  }

  if (lower === "slow" || lower === "slowest") {
    const slow = result?.slowestRequests || [];
    return {
      template: trace.template, target,
      totalRows: result?.totalRequests || 0,
      matchingRows: slow.length,
      rows: slow.slice(0, 20),
    };
  }

  // Match by domain name or status code
  const domains = result?.domains || [];
  const matchedDomain = domains.find((d) => String(d.domain || "").toLowerCase().includes(lower));
  if (matchedDomain) {
    return {
      template: trace.template, target,
      totalRows: domains.length,
      matchingRows: 1,
      rows: [matchedDomain],
    };
  }

  // Fall back to searching all requests
  const allRequests = [...(result?.slowestRequests || []), ...(result?.failedRequests || [])];
  const matched = allRequests.filter((r) => JSON.stringify(r).toLowerCase().includes(lower));
  return {
    template: trace.template, target,
    totalRows: result?.totalRequests || 0,
    matchingRows: matched.length,
    rows: matched.slice(0, 20),
    hint: matched.length === 0 ? `No requests matching "${target}". Try a domain name, "errors", or "slow".` : undefined,
  };
}

function drillDownLeaks(trace: StoredTrace, target: string): DrillDownResult {
  const result = trace.parsedResult as {
    leakGroups?: Array<Record<string, unknown>>;
    responsibleLibraries?: Array<Record<string, unknown>>;
    totalLeaks?: number;
  };
  const groups = result?.leakGroups || [];
  const lower = target.toLowerCase();

  if (lower === "largest") {
    const sorted = [...groups].sort((a, b) => (b.totalBytes as number) - (a.totalBytes as number));
    return {
      template: trace.template, target,
      totalRows: groups.length,
      matchingRows: sorted.slice(0, 10).length,
      rows: sorted.slice(0, 10),
    };
  }

  // Match by object type or library name
  const matched = groups.filter((g) => {
    const type = String(g.objectType || "").toLowerCase();
    const lib = String(g.responsibleLibrary || "").toLowerCase();
    return type.includes(lower) || lib.includes(lower);
  });

  return {
    template: trace.template, target,
    totalRows: groups.length,
    matchingRows: matched.length,
    rows: matched.slice(0, 20),
    hint: matched.length === 0 ? `No leaks matching "${target}". Try a type name, library name, or "largest".` : undefined,
  };
}

function drillDownAllocations(trace: StoredTrace, target: string): DrillDownResult {
  const result = trace.parsedResult as {
    categories?: Array<Record<string, unknown>>;
    totalAllocations?: number;
  };
  const cats = result?.categories || [];
  const lower = target.toLowerCase();

  if (lower === "largest") {
    const sorted = [...cats].sort((a, b) => (b.totalBytes as number) - (a.totalBytes as number));
    return {
      template: trace.template, target,
      totalRows: cats.length,
      matchingRows: sorted.slice(0, 10).length,
      rows: sorted.slice(0, 10),
    };
  }

  if (lower === "persistent") {
    const highPersistent = cats.filter((c) => {
      const count = (c.count as number) || 1;
      return ((c.persistent as number) || 0) / count > 0.5;
    });
    return {
      template: trace.template, target,
      totalRows: cats.length,
      matchingRows: highPersistent.length,
      rows: highPersistent.slice(0, 20),
      hint: highPersistent.length === 0 ? "No categories with high persistent ratio." : undefined,
    };
  }

  const matched = cats.filter((c) => String(c.category || "").toLowerCase().includes(lower));
  return {
    template: trace.template, target,
    totalRows: cats.length,
    matchingRows: matched.length,
    rows: matched.slice(0, 20),
    hint: matched.length === 0 ? `No categories matching "${target}". Try a category name, "persistent", or "largest".` : undefined,
  };
}

function drillDownSwiftUI(trace: StoredTrace, target: string): DrillDownResult {
  const result = trace.parsedResult as {
    views?: Array<Record<string, unknown>>;
    excessiveEvaluations?: Array<Record<string, unknown>>;
  };
  const views = result?.views || [];
  const lower = target.toLowerCase();

  if (lower === "excessive" || lower === "worst") {
    const excessive = result?.excessiveEvaluations || [];
    if (excessive.length > 0) {
      return {
        template: trace.template, target,
        totalRows: views.length,
        matchingRows: excessive.length,
        rows: excessive.slice(0, 20),
      };
    }
    // Fallback: return top views by eval count
    const sorted = [...views].sort((a, b) => (b.evaluationCount as number) - (a.evaluationCount as number));
    return {
      template: trace.template, target,
      totalRows: views.length,
      matchingRows: sorted.slice(0, 10).length,
      rows: sorted.slice(0, 10),
      hint: "No excessive evaluations flagged. Showing top views by eval count.",
    };
  }

  const matched = views.filter((v) => String(v.viewName || "").toLowerCase().includes(lower));
  return {
    template: trace.template, target,
    totalRows: views.length,
    matchingRows: matched.length,
    rows: matched.slice(0, 20),
    hint: matched.length === 0 ? `No views matching "${target}". Try a view name, "excessive", or "worst".` : undefined,
  };
}

function drillDownEnergy(trace: StoredTrace, target: string): DrillDownResult {
  const result = trace.parsedResult as {
    topComponents?: Array<Record<string, unknown>>;
    thermalState?: string | null;
    averageEnergyImpact?: number;
    peakEnergyImpact?: number;
    totalSamples?: number;
  };
  const components = result?.topComponents || [];
  const lower = target.toLowerCase();

  if (lower === "worst") {
    return {
      template: trace.template, target,
      totalRows: components.length,
      matchingRows: components.slice(0, 3).length,
      rows: components.slice(0, 3).map((c) => ({
        ...c,
        thermalState: result?.thermalState,
        averageEnergyImpact: result?.averageEnergyImpact,
        peakEnergyImpact: result?.peakEnergyImpact,
      })),
    };
  }

  if (lower === "thermal") {
    return {
      template: trace.template, target,
      totalRows: 1,
      matchingRows: 1,
      rows: [{
        thermalState: result?.thermalState || "unknown",
        averageEnergyImpact: result?.averageEnergyImpact,
        peakEnergyImpact: result?.peakEnergyImpact,
        totalSamples: result?.totalSamples,
      }],
    };
  }

  const matched = components.filter((c) => String(c.component || "").toLowerCase().includes(lower));
  return {
    template: trace.template, target,
    totalRows: components.length,
    matchingRows: matched.length,
    rows: matched.slice(0, 10),
    hint: matched.length === 0 ? `No components matching "${target}". Try "cpu", "gpu", "network", "worst", or "thermal".` : undefined,
  };
}

function drillDownLaunch(trace: StoredTrace, target: string): DrillDownResult {
  const result = trace.parsedResult as {
    phases?: Array<Record<string, unknown>>;
    totalLaunchMs?: number;
    launchType?: string;
  };
  const phases = result?.phases || [];
  const lower = target.toLowerCase();

  if (lower === "slowest") {
    // Phases are already sorted by duration desc
    const slowest = phases.slice(0, 3);
    return {
      template: trace.template, target,
      totalRows: phases.length,
      matchingRows: slowest.length,
      rows: slowest.map((p) => ({
        ...p,
        totalLaunchMs: result?.totalLaunchMs,
        launchType: result?.launchType,
      })),
    };
  }

  const matched = phases.filter((p) => String(p.name || "").toLowerCase().includes(lower));
  return {
    template: trace.template, target,
    totalRows: phases.length,
    matchingRows: matched.length,
    rows: matched.slice(0, 20),
    hint: matched.length === 0 ? `No phases matching "${target}". Try a phase name or "slowest".` : undefined,
  };
}

// ── Helpers (frame/weight extraction for call tree) ──────────────────

interface FrameInfo {
  name: string;
  module: string;
}

function extractFrames(row: Row): FrameInfo[] {
  let bt = row["backtrace"];
  if (!bt) return [];
  if (Array.isArray(bt)) bt = bt[0];
  if (!isRow(bt)) return [];

  let frames = bt["frame"];
  if (!frames) return [];
  if (!Array.isArray(frames)) frames = [frames];

  return (frames as Row[]).map((frame) => ({
    name: (frame["@_name"] as string) || "unknown",
    module: isRow(frame["binary"])
      ? ((frame["binary"] as Row)["@_name"] as string) || "unknown"
      : "unknown",
  }));
}

function extractWeight(row: Row): number | null {
  const val = row["weight"];
  if (!val) return null;
  if (isRow(val)) {
    const raw = val["#text"];
    if (raw != null) {
      const ns = Number(raw);
      if (!isNaN(ns)) return ns / 1_000_000;
    }
    const fmt = val["@_fmt"];
    if (typeof fmt === "string") {
      const match = fmt.match(/([\d.]+)\s*ms/);
      if (match) return parseFloat(match[1]);
    }
  }
  const num = Number(val);
  return isNaN(num) ? null : num;
}

function isUnsymbolicated(fn: string): boolean {
  return fn === "unknown" || fn === "<deduplicated_symbol>" || /^0x[0-9a-f]+$/i.test(fn);
}

function pct(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
