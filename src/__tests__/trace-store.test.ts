import { describe, it, expect, beforeEach } from "vitest";
import { storeTrace, drillDown, listTraces, clearStore } from "../utils/trace-store.js";

// Sample CPU trace XML with 3 samples and backtraces.
// Stack layout per sample (frames[0]=leaf, frames[N]=root):
//   Sample 1 (5ms): sqlite3_step ← CoreData.fetch ← SyncManager.sync ← main
//   Sample 2 (3ms): NSPredicate.evaluate ← CoreData.fetch ← SyncManager.sync ← main
//   Sample 3 (2ms): JSONDecoder.decode ← NetworkManager.parse ← main
const CPU_TRACE_XML = `
<trace-query-result>
  <node>
    <row>
      <weight fmt="5.00 ms">5000000</weight>
      <backtrace>
        <frame name="sqlite3_step"><binary name="libsqlite3.dylib"/></frame>
        <frame name="CoreData.fetch"><binary name="CoreData"/></frame>
        <frame name="SyncManager.sync"><binary name="MyApp"/></frame>
        <frame name="main"><binary name="MyApp"/></frame>
      </backtrace>
    </row>
    <row>
      <weight fmt="3.00 ms">3000000</weight>
      <backtrace>
        <frame name="NSPredicate.evaluate"><binary name="Foundation"/></frame>
        <frame name="CoreData.fetch"><binary name="CoreData"/></frame>
        <frame name="SyncManager.sync"><binary name="MyApp"/></frame>
        <frame name="main"><binary name="MyApp"/></frame>
      </backtrace>
    </row>
    <row>
      <weight fmt="2.00 ms">2000000</weight>
      <backtrace>
        <frame name="JSONDecoder.decode"><binary name="Foundation"/></frame>
        <frame name="NetworkManager.parse"><binary name="MyApp"/></frame>
        <frame name="main"><binary name="MyApp"/></frame>
      </backtrace>
    </row>
  </node>
</trace-query-result>
`;

// Simple non-CPU trace for generic drill-down testing
const HANGS_TRACE_XML = `
<trace-query-result>
  <node>
    <row>
      <duration fmt="800 ms">800000000</duration>
      <start>1000</start>
      <name>Main Thread Hang</name>
    </row>
    <row>
      <duration fmt="200 ms">200000000</duration>
      <start>5000</start>
      <name>Background Thread Delay</name>
    </row>
    <row>
      <duration fmt="50 ms">50000000</duration>
      <start>8000</start>
      <name>Short Hitch</name>
    </row>
  </node>
</trace-query-result>
`;

beforeEach(() => {
  clearStore();
});

// ── Store basics ─────────────────────────────────────────────────────

describe("storeTrace / listTraces", () => {
  it("stores a trace and lists it", () => {
    const id = storeTrace({ tracePath: "/tmp/test.trace", template: "Time Profiler", tableXml: CPU_TRACE_XML });
    expect(id).toMatch(/^t_[a-z0-9]+$/);

    const traces = listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].traceId).toBe(id);
    expect(traces[0].template).toBe("Time Profiler");
  });

  it("evicts oldest trace when at capacity", () => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      ids.push(storeTrace({ tracePath: `/tmp/t${i}.trace`, template: "Time Profiler", tableXml: "<empty/>" }));
    }
    const traces = listTraces();
    expect(traces).toHaveLength(20);
    // First trace should have been evicted
    expect(traces.find((t) => t.traceId === ids[0])).toBeUndefined();
    // Last trace should still be there
    expect(traces.find((t) => t.traceId === ids[20])).toBeDefined();
  });
});

// ── CPU call tree drill-down ─────────────────────────────────────────

describe("drillDown — CPU call tree", () => {
  let traceId: string;

  beforeEach(() => {
    traceId = storeTrace({ tracePath: "/tmp/cpu.trace", template: "Time Profiler", tableXml: CPU_TRACE_XML });
  });

  it("returns null for unknown trace ID", () => {
    expect(drillDown("t_nonexistent", "main")).toBeNull();
  });

  it("drills into a function by exact name", () => {
    const result = drillDown(traceId, "CoreData.fetch")!;
    expect(result).not.toBeNull();
    expect(result.function).toBe("CoreData.fetch");
    expect(result.module).toBe("CoreData");

    // CoreData.fetch appears in 2 samples (5ms + 3ms) — totalWeight = 8ms, selfWeight = 0ms
    expect(result.selfWeight).toBe(0);
    expect(result.totalWeight).toBe(8);

    // Total trace weight = 10ms → totalPct = 80%
    expect(result.totalPct).toBe(80);
    expect(result.selfPct).toBe(0);

    // Only caller is SyncManager.sync (100% of CoreData.fetch's time)
    expect(result.callers).toHaveLength(1);
    expect(result.callers![0].function).toBe("SyncManager.sync");
    expect(result.callers![0].pct).toBe(100);

    // Callees: sqlite3_step (5ms=62.5%) and NSPredicate.evaluate (3ms=37.5%)
    expect(result.callees).toHaveLength(2);
    expect(result.callees![0].function).toBe("sqlite3_step");
    expect(result.callees![0].pct).toBe(62.5);
    expect(result.callees![1].function).toBe("NSPredicate.evaluate");
    expect(result.callees![1].pct).toBe(37.5);

    // Heaviest path follows sqlite3_step (heaviest callee)
    expect(result.heaviestPath).toEqual(["CoreData.fetch", "sqlite3_step"]);
  });

  it("handles 'hottest' target — selects function with highest self weight", () => {
    const result = drillDown(traceId, "hottest")!;
    expect(result).not.toBeNull();
    // sqlite3_step has highest selfWeight (5ms)
    expect(result.function).toBe("sqlite3_step");
    expect(result.selfWeight).toBe(5);
    expect(result.selfPct).toBe(50);
    expect(result.callers).toHaveLength(1);
    expect(result.callers![0].function).toBe("CoreData.fetch");
    expect(result.callees).toHaveLength(0);
  });

  it("handles 'heaviest' target (alias for hottest)", () => {
    const result = drillDown(traceId, "heaviest")!;
    expect(result.function).toBe("sqlite3_step");
  });

  it("finds function by substring match", () => {
    const result = drillDown(traceId, "SyncManager")!;
    expect(result.function).toBe("SyncManager.sync");
    expect(result.totalWeight).toBe(8);
    // SyncManager.sync's caller is main
    expect(result.callers![0].function).toBe("main");
    // SyncManager.sync's callee is CoreData.fetch
    expect(result.callees![0].function).toBe("CoreData.fetch");
  });

  it("returns available functions when target not found", () => {
    const result = drillDown(traceId, "NonExistentFunction")!;
    expect(result.hint).toContain("not found");
    expect(result.hint).toContain("sqlite3_step"); // should list top functions
  });

  it("builds heaviest path through multiple levels", () => {
    const result = drillDown(traceId, "main")!;
    expect(result.function).toBe("main");
    expect(result.totalWeight).toBe(10);
    expect(result.selfWeight).toBe(0);
    // Heaviest path from main: SyncManager.sync(8) → CoreData.fetch(8) → sqlite3_step(5)
    expect(result.heaviestPath).toEqual([
      "main",
      "SyncManager.sync",
      "CoreData.fetch",
      "sqlite3_step",
    ]);
  });

  it("shows leaf function with no callees correctly", () => {
    const result = drillDown(traceId, "JSONDecoder.decode")!;
    expect(result.function).toBe("JSONDecoder.decode");
    expect(result.selfWeight).toBe(2);
    expect(result.totalWeight).toBe(2);
    expect(result.selfPct).toBe(20);
    expect(result.callees).toHaveLength(0);
    expect(result.callers).toHaveLength(1);
    expect(result.callers![0].function).toBe("NetworkManager.parse");
  });
});

// ── Generic drill-down (non-CPU) ────────────────────────────────────

describe("drillDown — generic (non-CPU)", () => {
  let traceId: string;

  beforeEach(() => {
    traceId = storeTrace({ tracePath: "/tmp/hangs.trace", template: "Animation Hitches", tableXml: HANGS_TRACE_XML });
  });

  it("finds rows matching a search term", () => {
    const result = drillDown(traceId, "Main Thread")!;
    expect(result.template).toBe("Animation Hitches");
    expect(result.totalRows).toBe(3);
    expect(result.matchingRows).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("returns all rows for a broad search", () => {
    const result = drillDown(traceId, "Thread")!;
    // Matches "Main Thread Hang" and "Background Thread Delay"
    expect(result.matchingRows).toBe(2);
  });

  it("returns hint when no rows match", () => {
    const result = drillDown(traceId, "NonexistentTerm")!;
    expect(result.matchingRows).toBe(0);
    expect(result.hint).toContain("No rows matching");
  });

  it("extracts readable field values from matched rows", () => {
    const result = drillDown(traceId, "Short Hitch")!;
    expect(result.matchingRows).toBe(1);
    const row = result.rows![0];
    expect(row["name"]).toBe("Short Hitch");
  });
});

// ── Call tree caching ────────────────────────────────────────────────

describe("call tree caching", () => {
  it("reuses call tree across multiple drill_down calls", () => {
    const traceId = storeTrace({ tracePath: "/tmp/cpu.trace", template: "Time Profiler", tableXml: CPU_TRACE_XML });

    // First call builds the tree
    const r1 = drillDown(traceId, "main")!;
    expect(r1.function).toBe("main");

    // Second call reuses it (same results)
    const r2 = drillDown(traceId, "sqlite3_step")!;
    expect(r2.function).toBe("sqlite3_step");
    expect(r2.selfWeight).toBe(5);
  });
});
