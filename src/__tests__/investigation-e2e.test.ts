import { describe, it, expect, beforeEach } from "vitest";
import { storeTrace, drillDown, listTraces, clearStore } from "../utils/trace-store.js";
import {
  formatCpuProfile,
  formatHangsProfile,
  formatNetworkProfile,
  formatLeaksProfile,
  formatSwiftUIProfile,
  formatAllocationsProfile,
  formatEnergyProfile,
  formatLaunchProfile,
  formatDrillDown,
  formatProfileResult,
} from "../utils/format-output.js";
import { autoInvestigate } from "../utils/auto-investigate.js";

// ── Fixtures ─────────────────────────────────────────────────────────

// CPU trace with 3 hot paths: DB, networking, layout
const CPU_TRACE_XML = `
<trace-query-result>
  <node>
    <row>
      <weight fmt="5.00 ms">5000000</weight>
      <backtrace>
        <frame name="sqlite3_step"><binary name="libsqlite3.dylib"/></frame>
        <frame name="CoreData.fetch"><binary name="CoreData"/></frame>
        <frame name="SyncManager.sync"><binary name="MyApp"/></frame>
        <frame name="AppDelegate.didFinishLaunching"><binary name="MyApp"/></frame>
        <frame name="main"><binary name="MyApp"/></frame>
      </backtrace>
    </row>
    <row>
      <weight fmt="3.00 ms">3000000</weight>
      <backtrace>
        <frame name="URLSession.dataTask"><binary name="CFNetwork"/></frame>
        <frame name="NetworkManager.fetch"><binary name="MyApp"/></frame>
        <frame name="ViewModel.loadData"><binary name="MyApp"/></frame>
        <frame name="main"><binary name="MyApp"/></frame>
      </backtrace>
    </row>
    <row>
      <weight fmt="2.00 ms">2000000</weight>
      <backtrace>
        <frame name="NSLayoutConstraint.solve"><binary name="UIKit"/></frame>
        <frame name="UIView.layoutSubviews"><binary name="UIKit"/></frame>
        <frame name="ViewController.viewDidLoad"><binary name="MyApp"/></frame>
        <frame name="main"><binary name="MyApp"/></frame>
      </backtrace>
    </row>
  </node>
</trace-query-result>
`;

const CPU_RESULT = {
  template: "Time Profiler" as const,
  totalSamples: 10,
  duration: "10s",
  hotspots: [
    { function: "sqlite3_step", module: "libsqlite3.dylib", selfWeight: 5.0, totalWeight: 5.0, selfPercent: 50.0, totalPercent: 50.0 },
    { function: "URLSession.dataTask", module: "CFNetwork", selfWeight: 3.0, totalWeight: 3.0, selfPercent: 30.0, totalPercent: 30.0 },
    { function: "NSLayoutConstraint.solve", module: "UIKit", selfWeight: 2.0, totalWeight: 2.0, selfPercent: 20.0, totalPercent: 20.0 },
  ],
  mainThreadBlockers: [
    { function: "sqlite3_step", durationMs: 5.0, severity: "critical" as const },
    { function: "URLSession.dataTask", durationMs: 3.0, severity: "warning" as const },
  ],
  severity: "critical" as const,
  summary: "Heavy CPU use from sqlite3_step",
};

// Hangs with backtraces
const HANGS_RESULT = {
  template: "Animation Hitches" as const,
  totalHangs: 5,
  microHangs: 2,
  minorHangs: 1,
  warningHangs: 1,
  criticalHangs: 1,
  hangs: [
    { duration: "1200ms", durationMs: 1200, severity: "critical" as const, startTime: "0:01.000", backtrace: ["sqlite3_step", "CoreData.executeFetchRequest", "SyncManager.sync"] },
    { duration: "500ms", durationMs: 500, severity: "warning" as const, startTime: "0:05.000", backtrace: ["URLSession.synchronousDataTask", "NetworkManager.fetch"] },
    { duration: "150ms", durationMs: 150, severity: "minor" as const, startTime: "0:08.000" },
    { duration: "80ms", durationMs: 80, severity: "micro" as const, startTime: "0:10.000" },
    { duration: "50ms", durationMs: 50, severity: "micro" as const, startTime: "0:12.000" },
  ],
  severity: "critical" as const,
  summary: "1 critical hang detected",
};

// Network with mixed results
const NETWORK_RESULT = {
  template: "Network" as const,
  totalRequests: 15,
  totalBytesSent: 5000,
  totalBytesReceived: 250000,
  avgDurationMs: 450,
  errorRate: 13.3,
  domains: [
    { domain: "api.example.com", requestCount: 8, totalBytes: 180000, avgDurationMs: 300, maxDurationMs: 6000, errorCount: 1, severity: "critical" as const },
    { domain: "cdn.images.com", requestCount: 5, totalBytes: 60000, avgDurationMs: 200, maxDurationMs: 400, errorCount: 0, severity: "ok" as const },
    { domain: "analytics.tracker.io", requestCount: 2, totalBytes: 10000, avgDurationMs: 1500, maxDurationMs: 3000, errorCount: 1, severity: "warning" as const },
  ],
  slowestRequests: [
    { url: "api.example.com/heavy-endpoint", domain: "api.example.com", method: "POST", statusCode: 200, requestBytes: 500, responseBytes: 50000, durationMs: 6000, severity: "critical" as const },
    { url: "analytics.tracker.io/batch", domain: "analytics.tracker.io", method: "POST", statusCode: 500, requestBytes: 1000, responseBytes: 0, durationMs: 3000, severity: "critical" as const },
  ],
  failedRequests: [
    { url: "api.example.com/auth", domain: "api.example.com", method: "GET", statusCode: 401, requestBytes: 200, responseBytes: 100, durationMs: 150, severity: "warning" as const },
    { url: "analytics.tracker.io/batch", domain: "analytics.tracker.io", method: "POST", statusCode: 500, requestBytes: 1000, responseBytes: 0, durationMs: 3000, severity: "critical" as const },
  ],
  severity: "critical" as const,
  summary: "High error rate and slow requests",
};

// Leaks
const LEAKS_RESULT = {
  template: "Leaks" as const,
  totalLeaks: 25,
  totalLeakedBytes: 524288,
  totalLeakedKB: 512,
  leakGroups: [
    { objectType: "NSMutableArray", count: 10, totalBytes: 262144, totalKB: 256, responsibleLibrary: "MyApp", responsibleFrame: "DataManager.loadItems", severity: "critical" as const },
    { objectType: "UIImage", count: 8, totalBytes: 131072, totalKB: 128, responsibleLibrary: "UIKit", responsibleFrame: null, severity: "warning" as const },
    { objectType: "NSString", count: 7, totalBytes: 131072, totalKB: 128, responsibleLibrary: "Foundation", responsibleFrame: null, severity: "warning" as const },
  ],
  responsibleLibraries: [
    { library: "MyApp", leakCount: 10, totalBytes: 262144 },
    { library: "UIKit", leakCount: 8, totalBytes: 131072 },
    { library: "Foundation", leakCount: 7, totalBytes: 131072 },
  ],
  severity: "critical" as const,
  summary: "25 leaked objects",
};

// SwiftUI
const SWIFTUI_RESULT = {
  template: "SwiftUI" as const,
  views: [
    { viewName: "ContentView", evaluationCount: 250, averageDurationUs: 500, totalDurationUs: 125000, severity: "critical" as const },
    { viewName: "ListRowView", evaluationCount: 80, averageDurationUs: 200, totalDurationUs: 16000, severity: "warning" as const },
    { viewName: "HeaderView", evaluationCount: 10, averageDurationUs: 100, totalDurationUs: 1000, severity: "ok" as const },
  ],
  totalBodyEvaluations: 340,
  excessiveEvaluations: [
    { viewName: "ContentView", evaluationCount: 250, averageDurationUs: 500, totalDurationUs: 125000, severity: "critical" as const },
    { viewName: "ListRowView", evaluationCount: 80, averageDurationUs: 200, totalDurationUs: 16000, severity: "warning" as const },
  ],
  summary: "2 views with excessive evaluations",
};

// Allocations
const ALLOCATIONS_RESULT = {
  template: "Allocations" as const,
  totalAllocations: 50000,
  totalBytesAllocated: 104857600,
  totalMB: 100,
  categories: [
    { category: "malloc 64", count: 20000, totalBytes: 52428800, totalKB: 51200, persistent: 18000, transient: 2000, severity: "critical" as const },
    { category: "NSConcreteData", count: 15000, totalBytes: 31457280, totalKB: 30720, persistent: 3000, transient: 12000, severity: "warning" as const },
    { category: "VM: ImageIO", count: 15000, totalBytes: 20971520, totalKB: 20480, persistent: 5000, transient: 10000, severity: "warning" as const },
  ],
  largestAllocations: [],
  summary: "100 MB allocated",
};

// Energy
const ENERGY_RESULT = {
  template: "Energy Log" as const,
  totalSamples: 30,
  averageEnergyImpact: 14.5,
  peakEnergyImpact: 19.0,
  timeInHighEnergyPct: 60,
  topComponents: [
    { component: "CPU", averageImpact: 8.0, peakImpact: 15.0 },
    { component: "Networking", averageImpact: 4.0, peakImpact: 10.0 },
    { component: "GPU", averageImpact: 2.5, peakImpact: 5.0 },
  ],
  thermalState: "serious",
  severity: "critical" as const,
  summary: "High energy impact",
};

// Launch
const LAUNCH_RESULT = {
  template: "App Launch" as const,
  totalLaunchMs: 1500,
  launchType: "cold" as const,
  severity: "critical" as const,
  phases: [
    { name: "dylib loading", durationMs: 600, severity: "critical" as const },
    { name: "main() to first frame", durationMs: 500, severity: "critical" as const },
    { name: "static initializers", durationMs: 400, severity: "warning" as const },
  ],
  summary: "Slow cold launch",
};

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  clearStore();
});

// ── Format Output Tests ──────────────────────────────────────────────

describe("formatProfileResult", () => {
  it("formats CPU profile with severity and hotspots", () => {
    const text = formatCpuProfile(CPU_RESULT, "t_test1", "/tmp/cpu.trace");
    expect(text).toContain("=== Time Profiler ===");
    expect(text).toContain("[CRITICAL]");
    expect(text).toContain("sqlite3_step");
    expect(text).toContain("t_test1");
    expect(text).toContain("/tmp/cpu.trace");
  });

  it("formats Hangs profile with events", () => {
    const text = formatHangsProfile(HANGS_RESULT, "t_test2", "/tmp/hangs.trace");
    expect(text).toContain("=== Animation Hitches ===");
    expect(text).toContain("1200ms");
    expect(text).toContain("[CRITICAL]");
    expect(text).toContain("sqlite3_step");
  });

  it("formats Network profile with domains", () => {
    const text = formatNetworkProfile(NETWORK_RESULT, "t_test3", "/tmp/net.trace");
    expect(text).toContain("=== Network ===");
    expect(text).toContain("api.example.com");
    expect(text).toContain("13.3%");
  });

  it("formats Leaks profile", () => {
    const text = formatLeaksProfile(LEAKS_RESULT, "t_test4", "/tmp/leaks.trace");
    expect(text).toContain("=== Leaks ===");
    expect(text).toContain("NSMutableArray");
    expect(text).toContain("512.0 KB");
  });

  it("formats SwiftUI profile", () => {
    const text = formatSwiftUIProfile(SWIFTUI_RESULT, "t_test5", "/tmp/swiftui.trace");
    expect(text).toContain("=== SwiftUI ===");
    expect(text).toContain("ContentView");
    expect(text).toContain("×250");
  });

  it("formats Allocations profile", () => {
    const text = formatAllocationsProfile(ALLOCATIONS_RESULT, "t_test6", "/tmp/alloc.trace");
    expect(text).toContain("=== Allocations ===");
    expect(text).toContain("malloc 64");
    expect(text).toContain("100.0 MB");
  });

  it("formats Energy profile", () => {
    const text = formatEnergyProfile(ENERGY_RESULT, "t_test7", "/tmp/energy.trace");
    expect(text).toContain("=== Energy Log ===");
    expect(text).toContain("14.5/20");
    expect(text).toContain("Thermal state: serious");
  });

  it("formats Launch profile", () => {
    const text = formatLaunchProfile(LAUNCH_RESULT, "t_test8", "/tmp/launch.trace");
    expect(text).toContain("=== App Launch ===");
    expect(text).toContain("1500ms");
    expect(text).toContain("cold");
    expect(text).toContain("dylib loading");
  });

  it("dispatcher routes correctly by template name", () => {
    expect(formatProfileResult("Time Profiler", CPU_RESULT, "t1", "/tmp/t")).toContain("=== Time Profiler ===");
    expect(formatProfileResult("Animation Hitches", HANGS_RESULT as unknown as Record<string, unknown>, "t2", "/tmp/t")).toContain("=== Animation Hitches ===");
    expect(formatProfileResult("Network", NETWORK_RESULT as unknown as Record<string, unknown>, "t3", "/tmp/t")).toContain("=== Network ===");
    expect(formatProfileResult("Leaks", LEAKS_RESULT as unknown as Record<string, unknown>, "t4", "/tmp/t")).toContain("=== Leaks ===");
    expect(formatProfileResult("SwiftUI", SWIFTUI_RESULT as unknown as Record<string, unknown>, "t5", "/tmp/t")).toContain("=== SwiftUI ===");
    expect(formatProfileResult("Allocations", ALLOCATIONS_RESULT as unknown as Record<string, unknown>, "t6", "/tmp/t")).toContain("=== Allocations ===");
    expect(formatProfileResult("Energy Log", ENERGY_RESULT as unknown as Record<string, unknown>, "t7", "/tmp/t")).toContain("=== Energy Log ===");
    expect(formatProfileResult("App Launch", LAUNCH_RESULT as unknown as Record<string, unknown>, "t8", "/tmp/t")).toContain("=== App Launch ===");
  });

  it("compact format is smaller than JSON", () => {
    const jsonSize = JSON.stringify(CPU_RESULT, null, 2).length;
    const compactSize = formatCpuProfile(CPU_RESULT, "t_test", "/tmp/t").length;
    expect(compactSize).toBeLessThan(jsonSize);
  });
});

// ── Auto-Investigate Tests ───────────────────────────────────────────

describe("autoInvestigate", () => {
  it("CPU: mentions top hotspot and classification", () => {
    const text = autoInvestigate("Time Profiler", CPU_RESULT);
    expect(text).toContain("-- Investigation --");
    expect(text).toContain("sqlite3_step");
    expect(text).toContain("Database I/O");
  });

  it("CPU: includes suggested drill-down when traceId provided", () => {
    const text = autoInvestigate("Time Profiler", CPU_RESULT, null, "t_abc");
    expect(text).toContain('drill_down("t_abc"');
  });

  it("Hangs: identifies worst hang and pattern", () => {
    const text = autoInvestigate("Animation Hitches", HANGS_RESULT as unknown as Record<string, unknown>);
    expect(text).toContain("1200ms");
    expect(text).toContain("DB on main thread");
  });

  it("Network: flags critical domains", () => {
    const text = autoInvestigate("Network", NETWORK_RESULT as unknown as Record<string, unknown>);
    expect(text).toContain("api.example.com");
  });

  it("Leaks: shows top leak groups", () => {
    const text = autoInvestigate("Leaks", LEAKS_RESULT as unknown as Record<string, unknown>);
    expect(text).toContain("NSMutableArray");
  });

  it("SwiftUI: identifies excessive re-renders", () => {
    const text = autoInvestigate("SwiftUI", SWIFTUI_RESULT as unknown as Record<string, unknown>);
    expect(text).toContain("ContentView");
    expect(text).toContain("Equatable");
  });

  it("Allocations: flags high persistent ratio", () => {
    const text = autoInvestigate("Allocations", ALLOCATIONS_RESULT as unknown as Record<string, unknown>);
    expect(text).toContain("malloc 64");
    expect(text).toContain("persistent");
  });

  it("Energy: identifies worst component", () => {
    const text = autoInvestigate("Energy Log", ENERGY_RESULT as unknown as Record<string, unknown>);
    expect(text).toContain("CPU");
    expect(text).toContain("serious");
  });

  it("Launch: identifies slowest phase with hint", () => {
    const text = autoInvestigate("App Launch", LAUNCH_RESULT as unknown as Record<string, unknown>);
    expect(text).toContain("dylib loading");
    expect(text).toContain("static linking");
  });

  it("returns empty string for unknown template", () => {
    const text = autoInvestigate("Unknown Template", {});
    expect(text).toBe("");
  });
});

// ── Template-Specific Drill-Down Tests ───────────────────────────────

describe("template-specific drill-down — Hangs", () => {
  let traceId: string;

  beforeEach(() => {
    traceId = storeTrace({
      tracePath: "/tmp/hangs.trace",
      template: "Animation Hitches",
      tableXml: "<empty/>",
      parsedResult: HANGS_RESULT as unknown as Record<string, unknown>,
    });
  });

  it('"worst" returns critical/warning hangs', () => {
    const result = drillDown(traceId, "worst")!;
    expect(result).not.toBeNull();
    expect(result.matchingRows).toBeGreaterThan(0);
    // Should include the critical and warning hangs
    const durations = result.rows!.map((r) => r.durationMs);
    expect(durations).toContain(1200);
    expect(durations).toContain(500);
  });

  it('"critical" returns critical hangs', () => {
    const result = drillDown(traceId, "critical")!;
    expect(result.matchingRows).toBeGreaterThan(0);
  });

  it("duration filter works", () => {
    const result = drillDown(traceId, "500ms")!;
    expect(result.matchingRows).toBeGreaterThan(0);
    result.rows!.forEach((r) => {
      expect(r.durationMs as number).toBeGreaterThanOrEqual(500);
    });
  });

  it("index lookup works", () => {
    const result = drillDown(traceId, "0")!;
    expect(result.matchingRows).toBe(1);
    expect(result.rows![0].durationMs).toBe(1200);
  });
});

describe("template-specific drill-down — Network", () => {
  let traceId: string;

  beforeEach(() => {
    traceId = storeTrace({
      tracePath: "/tmp/net.trace",
      template: "Network",
      tableXml: "<empty/>",
      parsedResult: NETWORK_RESULT as unknown as Record<string, unknown>,
    });
  });

  it('"errors" returns failed requests', () => {
    const result = drillDown(traceId, "errors")!;
    expect(result.matchingRows).toBe(2);
  });

  it('"slow" returns slowest requests', () => {
    const result = drillDown(traceId, "slow")!;
    expect(result.matchingRows).toBe(2);
  });

  it("domain name search returns matching domain", () => {
    const result = drillDown(traceId, "cdn.images.com")!;
    expect(result.matchingRows).toBe(1);
    expect(result.rows![0].domain).toBe("cdn.images.com");
  });
});

describe("template-specific drill-down — Leaks", () => {
  let traceId: string;

  beforeEach(() => {
    traceId = storeTrace({
      tracePath: "/tmp/leaks.trace",
      template: "Leaks",
      tableXml: "<empty/>",
      parsedResult: LEAKS_RESULT as unknown as Record<string, unknown>,
    });
  });

  it('"largest" returns groups sorted by size', () => {
    const result = drillDown(traceId, "largest")!;
    expect(result.matchingRows).toBeGreaterThan(0);
    expect(result.rows![0].objectType).toBe("NSMutableArray");
  });

  it("type name search works", () => {
    const result = drillDown(traceId, "UIImage")!;
    expect(result.matchingRows).toBe(1);
    expect(result.rows![0].objectType).toBe("UIImage");
  });

  it("library name search works", () => {
    const result = drillDown(traceId, "Foundation")!;
    expect(result.matchingRows).toBe(1);
  });
});

describe("template-specific drill-down — Allocations", () => {
  let traceId: string;

  beforeEach(() => {
    traceId = storeTrace({
      tracePath: "/tmp/alloc.trace",
      template: "Allocations",
      tableXml: "<empty/>",
      parsedResult: ALLOCATIONS_RESULT as unknown as Record<string, unknown>,
    });
  });

  it('"persistent" returns high-persistent-ratio categories', () => {
    const result = drillDown(traceId, "persistent")!;
    expect(result.matchingRows).toBeGreaterThan(0);
    // malloc 64 has 90% persistent ratio
    expect(result.rows!.some((r) => r.category === "malloc 64")).toBe(true);
  });

  it('"largest" returns top categories by size', () => {
    const result = drillDown(traceId, "largest")!;
    expect(result.rows![0].category).toBe("malloc 64");
  });

  it("category name search works", () => {
    const result = drillDown(traceId, "NSConcreteData")!;
    expect(result.matchingRows).toBe(1);
  });
});

describe("template-specific drill-down — SwiftUI", () => {
  let traceId: string;

  beforeEach(() => {
    traceId = storeTrace({
      tracePath: "/tmp/swiftui.trace",
      template: "SwiftUI",
      tableXml: "<empty/>",
      parsedResult: SWIFTUI_RESULT as unknown as Record<string, unknown>,
    });
  });

  it('"excessive" returns flagged views', () => {
    const result = drillDown(traceId, "excessive")!;
    expect(result.matchingRows).toBe(2);
  });

  it("view name search works", () => {
    const result = drillDown(traceId, "HeaderView")!;
    expect(result.matchingRows).toBe(1);
    expect(result.rows![0].viewName).toBe("HeaderView");
  });
});

describe("template-specific drill-down — Energy", () => {
  let traceId: string;

  beforeEach(() => {
    traceId = storeTrace({
      tracePath: "/tmp/energy.trace",
      template: "Energy Log",
      tableXml: "<empty/>",
      parsedResult: ENERGY_RESULT as unknown as Record<string, unknown>,
    });
  });

  it('"worst" returns top components with metadata', () => {
    const result = drillDown(traceId, "worst")!;
    expect(result.matchingRows).toBeGreaterThan(0);
    expect(result.rows![0].component).toBe("CPU");
  });

  it('"thermal" returns thermal state info', () => {
    const result = drillDown(traceId, "thermal")!;
    expect(result.rows![0].thermalState).toBe("serious");
  });

  it("component search works", () => {
    const result = drillDown(traceId, "gpu")!;
    expect(result.matchingRows).toBe(1);
  });
});

describe("template-specific drill-down — Launch", () => {
  let traceId: string;

  beforeEach(() => {
    traceId = storeTrace({
      tracePath: "/tmp/launch.trace",
      template: "App Launch",
      tableXml: "<empty/>",
      parsedResult: LAUNCH_RESULT as unknown as Record<string, unknown>,
    });
  });

  it('"slowest" returns top phases with launch metadata', () => {
    const result = drillDown(traceId, "slowest")!;
    expect(result.matchingRows).toBe(3);
    expect(result.rows![0].name).toBe("dylib loading");
    expect(result.rows![0].totalLaunchMs).toBe(1500);
  });

  it("phase name search works", () => {
    const result = drillDown(traceId, "static")!;
    expect(result.matchingRows).toBe(1);
    expect(result.rows![0].name).toBe("static initializers");
  });
});

// ── End-to-End Flow ──────────────────────────────────────────────────

describe("end-to-end flow", () => {
  it("store → investigate → drill_down → list_traces", () => {
    // Store with parsed result and investigation
    const investigation = autoInvestigate("Animation Hitches", HANGS_RESULT as unknown as Record<string, unknown>, null, "t_placeholder");
    const traceId = storeTrace({
      tracePath: "/tmp/hangs.trace",
      template: "Animation Hitches",
      tableXml: "<empty/>",
      parsedResult: HANGS_RESULT as unknown as Record<string, unknown>,
      investigation,
    });

    // Investigation was computed
    expect(investigation).toContain("1200ms");

    // Drill-down returns structured result
    const result = drillDown(traceId, "worst")!;
    expect(result).not.toBeNull();
    expect(result.matchingRows).toBeGreaterThan(0);

    // listTraces shows investigation preview
    const traces = listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].investigationPreview).toBeDefined();
    expect(traces[0].investigationPreview!.length).toBeGreaterThan(0);
  });

  it("formatDrillDown produces readable output", () => {
    const traceId = storeTrace({
      tracePath: "/tmp/cpu.trace",
      template: "Time Profiler",
      tableXml: CPU_TRACE_XML,
    });
    const result = drillDown(traceId, "sqlite3_step")!;
    const text = formatDrillDown(result);

    expect(text).toContain("=== Drill Down: sqlite3_step ===");
    expect(text).toContain("self:");
    expect(text).toContain("Callers");
    expect(text).toContain("CoreData.fetch");
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────

describe("edge cases", () => {
  it("empty hangs result drill-down returns hint", () => {
    const traceId = storeTrace({
      tracePath: "/tmp/empty.trace",
      template: "Animation Hitches",
      tableXml: "<empty/>",
      parsedResult: { ...HANGS_RESULT, hangs: [], totalHangs: 0 } as unknown as Record<string, unknown>,
    });
    const result = drillDown(traceId, "worst")!;
    expect(result.matchingRows).toBe(0);
  });

  it("empty network result returns hint", () => {
    const traceId = storeTrace({
      tracePath: "/tmp/empty.trace",
      template: "Network",
      tableXml: "<empty/>",
      parsedResult: { ...NETWORK_RESULT, domains: [], slowestRequests: [], failedRequests: [], totalRequests: 0 } as unknown as Record<string, unknown>,
    });
    const result = drillDown(traceId, "errors")!;
    expect(result.matchingRows).toBe(0);
  });

  it("auto-investigate handles empty results gracefully", () => {
    const emptyHangs = { ...HANGS_RESULT, totalHangs: 0, hangs: [] };
    const text = autoInvestigate("Animation Hitches", emptyHangs as unknown as Record<string, unknown>);
    expect(text).toContain("No hangs detected");
  });

  it("trace without parsedResult falls back to generic drill-down", () => {
    const traceId = storeTrace({
      tracePath: "/tmp/hangs.trace",
      template: "Animation Hitches",
      tableXml: `<trace-query-result><node><row><name>test</name></row></node></trace-query-result>`,
      // No parsedResult — should fall back to generic
    });
    const result = drillDown(traceId, "test")!;
    expect(result.matchingRows).toBe(1);
  });

  it("single-row CPU trace works", () => {
    const singleRowXml = `
    <trace-query-result>
      <node>
        <row>
          <weight fmt="1.00 ms">1000000</weight>
          <backtrace>
            <frame name="main"><binary name="MyApp"/></frame>
          </backtrace>
        </row>
      </node>
    </trace-query-result>`;
    const traceId = storeTrace({
      tracePath: "/tmp/single.trace",
      template: "Time Profiler",
      tableXml: singleRowXml,
    });
    const result = drillDown(traceId, "main")!;
    expect(result.function).toBe("main");
    expect(result.selfWeight).toBe(1);
  });
});
