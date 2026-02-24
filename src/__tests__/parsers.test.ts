import { describe, it, expect } from "vitest";
import { parseTimeProfiler } from "../parsers/time-profiler.js";
import { parseSwiftUI } from "../parsers/swiftui.js";
import { parseAllocations } from "../parsers/allocations.js";
import { parseHangs } from "../parsers/hangs.js";
import { parseAppLaunch } from "../parsers/app-launch.js";
import { parseEnergy } from "../parsers/energy.js";
import { parseLeaks } from "../parsers/leaks.js";
import { parseNetwork } from "../parsers/network.js";

const EMPTY_TOC = "<trace-toc></trace-toc>";

/**
 * Helper: wrap rows in the standard xctrace 26+ XML structure.
 * trace-query-result > node > row
 */
function wrapRows(innerRows: string): string {
  return `<trace-query-result><node>${innerRows}</node></trace-query-result>`;
}

/** Helper: empty table XML with no rows. */
const EMPTY_TABLE = "<trace-query-result></trace-query-result>";

// ── parseTimeProfiler ───────────────────────────────────────────────

describe("parseTimeProfiler", () => {
  it("parses aggregated time-profile rows with backtrace", () => {
    const tableXml = wrapRows(`
      <row>
        <weight fmt="5.00 ms">5000000</weight>
        <backtrace>
          <frame name="MyApp.heavyComputation" addr="0x1234">
            <binary name="MyApp" />
          </frame>
          <frame name="MyApp.viewDidLoad" addr="0x5678">
            <binary name="MyApp" />
          </frame>
        </backtrace>
      </row>
      <row>
        <weight fmt="3.00 ms">3000000</weight>
        <backtrace>
          <frame name="MyApp.heavyComputation" addr="0x1234">
            <binary name="MyApp" />
          </frame>
        </backtrace>
      </row>
      <row>
        <weight fmt="1.00 ms">1000000</weight>
        <backtrace>
          <frame name="MyApp.layoutSubviews" addr="0x9abc">
            <binary name="MyApp" />
          </frame>
        </backtrace>
      </row>
    `);

    const result = parseTimeProfiler(EMPTY_TOC, tableXml);

    expect(result.template).toBe("Time Profiler");
    expect(result.totalSamples).toBe(3);
    expect(result.hotspots.length).toBeGreaterThan(0);

    // heavyComputation should be top hotspot (5ms + 3ms self weight)
    const topHotspot = result.hotspots[0];
    expect(topHotspot.function).toBe("MyApp.heavyComputation");
    expect(topHotspot.module).toBe("MyApp");
    expect(topHotspot.selfWeight).toBeGreaterThan(0);
    expect(topHotspot.selfPercent).toBeGreaterThan(0);
    expect(result.summary).toBeTruthy();
  });

  it("parses time-sample rows (Deferred mode, raw addresses)", () => {
    const tableXml = wrapRows(`
      <row>
        <thread fmt="Main Thread 0x1e97f4">12345</thread>
        <thread-state fmt="Running">1</thread-state>
        <kperf-bt>0x1234</kperf-bt>
        <time-sample-kind>1</time-sample-kind>
      </row>
      <row>
        <thread fmt="Main Thread 0x1e97f4">12345</thread>
        <thread-state fmt="Blocked">2</thread-state>
        <kperf-bt>0x5678</kperf-bt>
        <time-sample-kind>1</time-sample-kind>
      </row>
      <row>
        <thread fmt="com.apple.network 0xabc">67890</thread>
        <thread-state fmt="Running">1</thread-state>
        <kperf-bt>0x9abc</kperf-bt>
        <time-sample-kind>1</time-sample-kind>
      </row>
    `);

    const result = parseTimeProfiler(EMPTY_TOC, tableXml);

    expect(result.template).toBe("Time Profiler");
    expect(result.totalSamples).toBe(3);
    expect(result.needsSymbolication).toBe(true);
    expect(result.threads).toBeDefined();
    expect(result.threads!.length).toBeGreaterThan(0);

    const mainThread = result.threads!.find((t) => t.name.includes("Main Thread"));
    expect(mainThread).toBeDefined();
    expect(mainThread!.sampleCount).toBe(2);
    expect(mainThread!.runningCount).toBe(1);
    expect(mainThread!.blockedCount).toBe(1);
    expect(result.summary).toContain("Main thread");
  });

  it("returns empty result when no rows", () => {
    const result = parseTimeProfiler(EMPTY_TOC, EMPTY_TABLE);

    expect(result.template).toBe("Time Profiler");
    expect(result.totalSamples).toBe(0);
    expect(result.hotspots).toEqual([]);
    expect(result.mainThreadBlockers).toEqual([]);
    expect(result.summary).toContain("No profiling samples");
  });
});

// ── parseSwiftUI ────────────────────────────────────────────────────

describe("parseSwiftUI", () => {
  it("parses view-body evaluation rows", () => {
    // Generate many rows for ContentView to trigger "critical" severity (count > 100)
    const contentViewRows = Array.from({ length: 105 }, () =>
      `<row><view-name>ContentView</view-name><duration>50</duration></row>`
    ).join("\n");

    const tableXml = wrapRows(`
      ${contentViewRows}
      <row><view-name>HeaderView</view-name><duration>20</duration></row>
      <row><view-name>HeaderView</view-name><duration>25</duration></row>
    `);

    const result = parseSwiftUI(EMPTY_TOC, tableXml);

    expect(result.template).toBe("SwiftUI");
    expect(result.totalBodyEvaluations).toBe(107);
    expect(result.views.length).toBe(2);

    // ContentView should be sorted first (most evaluations)
    const contentView = result.views.find((v) => v.viewName === "ContentView");
    expect(contentView).toBeDefined();
    expect(contentView!.evaluationCount).toBe(105);
    expect(contentView!.severity).toBe("critical");

    const headerView = result.views.find((v) => v.viewName === "HeaderView");
    expect(headerView).toBeDefined();
    expect(headerView!.evaluationCount).toBe(2);
    expect(headerView!.severity).toBe("ok");

    expect(result.excessiveEvaluations.length).toBeGreaterThan(0);
    expect(result.summary).toContain("107 total body evaluations");
  });

  it("returns empty result with no rows", () => {
    const result = parseSwiftUI(EMPTY_TOC, EMPTY_TABLE);

    expect(result.template).toBe("SwiftUI");
    expect(result.totalBodyEvaluations).toBe(0);
    expect(result.views).toEqual([]);
    expect(result.excessiveEvaluations).toEqual([]);
    expect(result.summary).toContain("0 total body evaluations");
  });
});

// ── parseAllocations ────────────────────────────────────────────────

describe("parseAllocations", () => {
  it("parses allocation rows with categories", () => {
    const tableXml = wrapRows(`
      <row>
        <category>malloc</category>
        <size>4096</size>
        <event-type>malloc alloc</event-type>
      </row>
      <row>
        <category>malloc</category>
        <size>2048</size>
        <event-type>malloc alloc</event-type>
      </row>
      <row>
        <category>NSObject</category>
        <size>256</size>
        <event-type>alloc then free</event-type>
      </row>
    `);

    const result = parseAllocations(EMPTY_TOC, tableXml);

    expect(result.template).toBe("Allocations");
    expect(result.totalAllocations).toBe(3);
    expect(result.totalBytesAllocated).toBe(4096 + 2048 + 256);
    expect(result.categories.length).toBe(2);

    // malloc should be first (largest by bytes)
    const mallocCat = result.categories.find((c) => c.category === "malloc");
    expect(mallocCat).toBeDefined();
    expect(mallocCat!.count).toBe(2);
    expect(mallocCat!.totalBytes).toBe(4096 + 2048);
    expect(mallocCat!.persistent).toBe(2); // "malloc alloc" doesn't include "free"

    const nsCat = result.categories.find((c) => c.category === "NSObject");
    expect(nsCat).toBeDefined();
    expect(nsCat!.count).toBe(1);

    expect(result.summary).toContain("3 allocations");
  });

  it("returns empty result with no rows", () => {
    const result = parseAllocations(EMPTY_TOC, EMPTY_TABLE);

    expect(result.template).toBe("Allocations");
    expect(result.totalAllocations).toBe(0);
    expect(result.totalBytesAllocated).toBe(0);
    expect(result.categories).toEqual([]);
    expect(result.summary).toContain("0 allocations");
  });
});

// ── parseHangs ──────────────────────────────────────────────────────

describe("parseHangs", () => {
  it("parses hang events with severity classification", () => {
    // The hangs parser treats values > 1000 as nanoseconds (divides by 1_000_000).
    // So to get durations in ms: use values <= 1000 directly, or use large ns values.
    // 50 => 50ms (micro), 300 => 300ms (warning), 1500000000 => 1500ms (critical)
    const tableXml = wrapRows(`
      <row>
        <duration>50</duration>
        <start>0:00.100</start>
      </row>
      <row>
        <duration>300</duration>
        <start>0:01.500</start>
      </row>
      <row>
        <hang-duration>1500000000</hang-duration>
        <start>0:05.000</start>
      </row>
    `);

    const result = parseHangs(EMPTY_TOC, tableXml);

    expect(result.template).toBe("Animation Hitches");
    expect(result.totalHangs).toBe(3);

    // 50ms = micro, 300ms = warning, 1500ms = critical
    expect(result.microHangs).toBe(1);
    expect(result.warningHangs).toBe(1);
    expect(result.criticalHangs).toBe(1);

    // Sorted by duration descending
    expect(result.hangs[0].durationMs).toBe(1500);
    expect(result.hangs[0].severity).toBe("critical");
    expect(result.hangs[1].durationMs).toBe(300);
    expect(result.hangs[1].severity).toBe("warning");
    expect(result.hangs[2].durationMs).toBe(50);
    expect(result.hangs[2].severity).toBe("micro");

    expect(result.summary).toContain("3 hang events");
    expect(result.summary).toContain("CRITICAL");
  });

  it("classifies minor hangs (100-250ms)", () => {
    const tableXml = wrapRows(`
      <row>
        <duration>150</duration>
        <start>0:00.500</start>
      </row>
    `);

    const result = parseHangs(EMPTY_TOC, tableXml);
    expect(result.minorHangs).toBe(1);
    expect(result.hangs[0].severity).toBe("minor");
  });

  it("returns empty result with no rows", () => {
    const result = parseHangs(EMPTY_TOC, EMPTY_TABLE);

    expect(result.template).toBe("Animation Hitches");
    expect(result.totalHangs).toBe(0);
    expect(result.hangs).toEqual([]);
    expect(result.summary).toContain("No hangs");
  });
});

// ── parseAppLaunch ──────────────────────────────────────────────────

describe("parseAppLaunch", () => {
  it("parses launch phases with cold launch classification", () => {
    const tableXml = wrapRows(`
      <row>
        <name>App Launch (cold)</name>
        <duration fmt="800 ms">800000000</duration>
      </row>
      <row>
        <name>dylib loading</name>
        <duration fmt="100 ms">100000000</duration>
      </row>
      <row>
        <name>runtime init</name>
        <duration fmt="50 ms">50000000</duration>
      </row>
    `);

    const result = parseAppLaunch(EMPTY_TOC, tableXml);

    expect(result.template).toBe("App Launch");
    expect(result.launchType).toBe("cold");
    expect(result.totalLaunchMs).toBeGreaterThan(0);
    expect(result.phases.length).toBeGreaterThan(0);
    // 800ms cold launch = warning (400-1000ms)
    expect(result.severity).toBe("warning");
    expect(result.summary).toContain("App launch");
  });

  it("classifies critical cold launch (>1000ms)", () => {
    const tableXml = wrapRows(`
      <row>
        <name>App Launch (cold)</name>
        <duration fmt="1.5 s">1500000000</duration>
      </row>
    `);

    const result = parseAppLaunch(EMPTY_TOC, tableXml);
    expect(result.severity).toBe("critical");
    expect(result.launchType).toBe("cold");
  });

  it("classifies ok cold launch (<400ms)", () => {
    const tableXml = wrapRows(`
      <row>
        <name>App Launch</name>
        <duration fmt="200 ms">200000000</duration>
      </row>
    `);

    const result = parseAppLaunch(EMPTY_TOC, tableXml);
    expect(result.severity).toBe("ok");
  });

  it("returns empty result with no rows", () => {
    const result = parseAppLaunch(EMPTY_TOC, EMPTY_TABLE);

    expect(result.template).toBe("App Launch");
    expect(result.totalLaunchMs).toBe(0);
    expect(result.launchType).toBe("unknown");
    expect(result.severity).toBe("ok");
    expect(result.phases).toEqual([]);
    expect(result.summary).toContain("No launch events");
  });
});

// ── parseEnergy ─────────────────────────────────────────────────────

describe("parseEnergy", () => {
  it("parses energy impact samples with component breakdown", () => {
    const tableXml = wrapRows(`
      <row>
        <energy-impact>12</energy-impact>
        <cpu>8</cpu>
        <gpu>2</gpu>
        <networking>1</networking>
        <display>1</display>
      </row>
      <row>
        <energy-impact>15</energy-impact>
        <cpu>10</cpu>
        <gpu>3</gpu>
        <networking>1</networking>
        <display>1</display>
      </row>
      <row>
        <energy-impact>5</energy-impact>
        <cpu>3</cpu>
        <gpu>1</gpu>
        <networking>0</networking>
        <display>1</display>
      </row>
    `);

    const result = parseEnergy(EMPTY_TOC, tableXml);

    expect(result.template).toBe("Energy Log");
    expect(result.totalSamples).toBe(3);
    expect(result.averageEnergyImpact).toBeGreaterThan(0);
    expect(result.peakEnergyImpact).toBe(15);

    // 2 of 3 samples >= 9 => 66.7% high energy time
    expect(result.timeInHighEnergyPct).toBeGreaterThan(50);

    // CPU should be top component
    expect(result.topComponents.length).toBeGreaterThan(0);
    expect(result.topComponents[0].component).toBe("CPU");

    // avg ~10.7, peak 15, highPct > 50 => critical
    expect(result.severity).toBe("critical");
    expect(result.summary).toContain("Energy impact");
  });

  it("classifies warning severity", () => {
    const tableXml = wrapRows(`
      <row><energy-impact>9</energy-impact><cpu>5</cpu></row>
      <row><energy-impact>6</energy-impact><cpu>3</cpu></row>
      <row><energy-impact>7</energy-impact><cpu>4</cpu></row>
    `);

    const result = parseEnergy(EMPTY_TOC, tableXml);
    // avg ~7.3, peak 9 => warning (avg >= 8 or peak >= 16)
    // Actually avg 7.3 < 8 but peak 9 < 16, highPct = 33% > 25 => warning
    expect(result.severity).toBe("warning");
  });

  it("returns empty result with no rows", () => {
    const result = parseEnergy(EMPTY_TOC, EMPTY_TABLE);

    expect(result.template).toBe("Energy Log");
    expect(result.totalSamples).toBe(0);
    expect(result.averageEnergyImpact).toBe(0);
    expect(result.peakEnergyImpact).toBe(0);
    expect(result.topComponents).toEqual([]);
    expect(result.severity).toBe("ok");
    expect(result.summary).toContain("No energy data");
  });
});

// ── parseLeaks ──────────────────────────────────────────────────────

describe("parseLeaks", () => {
  it("parses leaked object rows with grouping", () => {
    const tableXml = wrapRows(`
      <row>
        <leaked-object>NSMutableArray</leaked-object>
        <size>128</size>
        <responsible-library>MyApp</responsible-library>
        <responsible-frame>-[MyController loadData]</responsible-frame>
      </row>
      <row>
        <leaked-object>NSMutableArray</leaked-object>
        <size>256</size>
        <responsible-library>MyApp</responsible-library>
      </row>
      <row>
        <leaked-object>CFString</leaked-object>
        <size>64</size>
        <responsible-library>CoreFoundation</responsible-library>
        <responsible-frame>CFStringCreate</responsible-frame>
      </row>
    `);

    const result = parseLeaks(EMPTY_TOC, tableXml);

    expect(result.template).toBe("Leaks");
    expect(result.totalLeaks).toBe(3);
    expect(result.totalLeakedBytes).toBe(128 + 256 + 64);
    expect(result.leakGroups.length).toBe(2);

    // NSMutableArray group (largest by bytes)
    const nsGroup = result.leakGroups.find((g) => g.objectType === "NSMutableArray");
    expect(nsGroup).toBeDefined();
    expect(nsGroup!.count).toBe(2);
    expect(nsGroup!.totalBytes).toBe(384);
    expect(nsGroup!.responsibleLibrary).toBe("MyApp");
    expect(nsGroup!.responsibleFrame).toBe("-[MyController loadData]");

    // Responsible libraries
    expect(result.responsibleLibraries.length).toBe(2);

    // 3 leaks < 10 and bytes small => ok
    expect(result.severity).toBe("ok");
    expect(result.summary).toContain("3 leaked object");
  });

  it("classifies warning severity (> 10 leaks)", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      `<row><leaked-object>Obj${i}</leaked-object><size>64</size></row>`
    ).join("\n");
    const tableXml = wrapRows(rows);

    const result = parseLeaks(EMPTY_TOC, tableXml);
    expect(result.totalLeaks).toBe(15);
    expect(result.severity).toBe("warning");
  });

  it("classifies critical severity (> 100 leaks)", () => {
    const rows = Array.from({ length: 105 }, (_, i) =>
      `<row><leaked-object>Obj${i % 5}</leaked-object><size>64</size></row>`
    ).join("\n");
    const tableXml = wrapRows(rows);

    const result = parseLeaks(EMPTY_TOC, tableXml);
    expect(result.totalLeaks).toBe(105);
    expect(result.severity).toBe("critical");
  });

  it("returns empty result with no rows", () => {
    const result = parseLeaks(EMPTY_TOC, EMPTY_TABLE);

    expect(result.template).toBe("Leaks");
    expect(result.totalLeaks).toBe(0);
    expect(result.totalLeakedBytes).toBe(0);
    expect(result.leakGroups).toEqual([]);
    expect(result.severity).toBe("ok");
    expect(result.summary).toContain("No leaks detected");
  });
});

// ── parseNetwork ────────────────────────────────────────────────────

describe("parseNetwork", () => {
  it("parses HTTP transaction rows with domain aggregation", () => {
    const tableXml = wrapRows(`
      <row>
        <url>https://api.example.com/users</url>
        <method>GET</method>
        <status-code>200</status-code>
        <request-size>128</request-size>
        <response-size>4096</response-size>
        <duration>150</duration>
      </row>
      <row>
        <url>https://api.example.com/posts</url>
        <method>POST</method>
        <status-code>201</status-code>
        <request-size>512</request-size>
        <response-size>256</response-size>
        <duration>300</duration>
      </row>
      <row>
        <url>https://cdn.other.io/image.png</url>
        <method>GET</method>
        <status-code>200</status-code>
        <request-size>0</request-size>
        <response-size>102400</response-size>
        <duration>500</duration>
      </row>
    `);

    const result = parseNetwork(EMPTY_TOC, tableXml);

    expect(result.template).toBe("Network");
    expect(result.totalRequests).toBe(3);
    expect(result.totalBytesSent).toBe(128 + 512 + 0);
    expect(result.totalBytesReceived).toBe(4096 + 256 + 102400);
    expect(result.avgDurationMs).toBeGreaterThan(0);
    expect(result.errorRate).toBe(0);

    // Two domains
    expect(result.domains.length).toBe(2);
    const exampleDomain = result.domains.find((d) => d.domain === "api.example.com");
    expect(exampleDomain).toBeDefined();
    expect(exampleDomain!.requestCount).toBe(2);

    expect(result.severity).toBe("ok");
    expect(result.summary).toContain("3 HTTP request");
  });

  it("detects failed requests and error rate", () => {
    const tableXml = wrapRows(`
      <row>
        <url>https://api.example.com/data</url>
        <method>GET</method>
        <status-code>500</status-code>
        <duration>100</duration>
      </row>
      <row>
        <url>https://api.example.com/other</url>
        <method>GET</method>
        <status-code>200</status-code>
        <duration>100</duration>
      </row>
    `);

    const result = parseNetwork(EMPTY_TOC, tableXml);

    expect(result.failedRequests.length).toBe(1);
    expect(result.errorRate).toBe(50);

    // error rate 50% > 10% => critical
    expect(result.severity).toBe("critical");
  });

  it("classifies slow requests", () => {
    // Mix fast and slow requests so slowPct doesn't exceed 50% (which would trigger critical).
    // 1 slow request out of 3 total = 33% slow => warning (not critical).
    const tableXml = wrapRows(`
      <row>
        <url>https://slow.example.com/api</url>
        <method>GET</method>
        <status-code>200</status-code>
        <duration>3000</duration>
      </row>
      <row>
        <url>https://fast.example.com/a</url>
        <method>GET</method>
        <status-code>200</status-code>
        <duration>100</duration>
      </row>
      <row>
        <url>https://fast.example.com/b</url>
        <method>GET</method>
        <status-code>200</status-code>
        <duration>100</duration>
      </row>
    `);

    const result = parseNetwork(EMPTY_TOC, tableXml);
    // maxDuration=3000 > 2000 => warning, slowPct=33% < 50 => not critical
    expect(result.severity).toBe("warning");
    expect(result.slowestRequests[0].durationMs).toBe(3000);
  });

  it("classifies critical slow requests (>5s)", () => {
    const tableXml = wrapRows(`
      <row>
        <url>https://veryslow.example.com/api</url>
        <method>GET</method>
        <status-code>200</status-code>
        <duration>6000</duration>
      </row>
    `);

    const result = parseNetwork(EMPTY_TOC, tableXml);
    expect(result.severity).toBe("critical");
  });

  it("returns empty result with no rows", () => {
    const result = parseNetwork(EMPTY_TOC, EMPTY_TABLE);

    expect(result.template).toBe("Network");
    expect(result.totalRequests).toBe(0);
    expect(result.totalBytesSent).toBe(0);
    expect(result.totalBytesReceived).toBe(0);
    expect(result.domains).toEqual([]);
    expect(result.severity).toBe("ok");
    expect(result.summary).toContain("No network requests");
  });
});
