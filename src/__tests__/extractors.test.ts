import { describe, it, expect } from "vitest";
import {
  extractRows,
  extractStr,
  extractFmt,
  extractNum,
  extractFmtNum,
  parseFmtDuration,
  parseSizeFmt,
  formatBytes,
  extractDurationMs,
  extractTimestampMs,
  extractFirstStr,
  extractFirstStrOrFmt,
  extractFirstNum,
  type Row,
} from "../utils/extractors.js";
import { parseXml } from "../utils/xml.js";

// ── extractRows ─────────────────────────────────────────────────────

describe("extractRows", () => {
  it("extracts rows from trace-query-result > node > row (xctrace 26+)", () => {
    const xml = `
      <trace-query-result>
        <node>
          <row><name>func1</name></row>
          <row><name>func2</name></row>
        </node>
      </trace-query-result>
    `;
    const data = parseXml(xml);
    const rows = extractRows(data);
    expect(rows).toHaveLength(2);
  });

  it("extracts rows from trace-query-result > row (fallback)", () => {
    const xml = `
      <trace-query-result>
        <row><name>func1</name></row>
        <row><name>func2</name></row>
        <row><name>func3</name></row>
      </trace-query-result>
    `;
    const data = parseXml(xml);
    const rows = extractRows(data);
    expect(rows).toHaveLength(3);
  });

  it("extracts rows from table > row (pre-parsed object)", () => {
    // The XML parser wraps `table` in an array (isArray config), so
    // getPath("table.row") can't navigate through it from raw XML.
    // This fallback path handles pre-unwrapped data structures.
    const data = {
      table: {
        row: [{ value: 10 }],
      },
    };
    const rows = extractRows(data);
    expect(rows).toHaveLength(1);
  });

  it("extracts rows from run > data > table > row (pre-parsed object)", () => {
    // Same as above: `run` and `table` are arrays in the XML parser,
    // so this path handles pre-unwrapped data structures.
    const data = {
      run: {
        data: {
          table: {
            row: [{ value: "a" }, { value: "b" }],
          },
        },
      },
    };
    const rows = extractRows(data);
    expect(rows).toHaveLength(2);
  });

  it("returns empty array when no rows exist", () => {
    const xml = `<trace-query-result></trace-query-result>`;
    const data = parseXml(xml);
    const rows = extractRows(data);
    expect(rows).toEqual([]);
  });

  it("returns empty array for completely empty data", () => {
    const rows = extractRows({});
    expect(rows).toEqual([]);
  });

  it("skips nodes without rows and finds the first node that has rows", () => {
    const xml = `
      <trace-query-result>
        <node><schema><column>col1</column></schema></node>
        <node>
          <row><name>actual</name></row>
        </node>
      </trace-query-result>
    `;
    const data = parseXml(xml);
    const rows = extractRows(data);
    expect(rows).toHaveLength(1);
  });
});

// ── extractStr ──────────────────────────────────────────────────────

describe("extractStr", () => {
  it("extracts a plain string value", () => {
    const row: Row = { name: "MyFunction" };
    expect(extractStr(row, "name")).toBe("MyFunction");
  });

  it("extracts a value from @_ prefixed attribute", () => {
    const row: Row = { "@_name": "AttrValue" };
    expect(extractStr(row, "name")).toBe("AttrValue");
  });

  it("extracts from nested {#text} object", () => {
    const row: Row = { name: { "#text": "NestedText" } };
    expect(extractStr(row, "name")).toBe("NestedText");
  });

  it("returns null for missing key", () => {
    const row: Row = { other: "value" };
    expect(extractStr(row, "name")).toBeNull();
  });

  it("returns null for non-string, non-object values without #text", () => {
    const row: Row = { name: { something: "else" } };
    expect(extractStr(row, "name")).toBeNull();
  });

  it("prefers direct key over @_ prefix", () => {
    const row: Row = { name: "direct", "@_name": "attribute" };
    expect(extractStr(row, "name")).toBe("direct");
  });
});

// ── extractFmt ──────────────────────────────────────────────────────

describe("extractFmt", () => {
  it("extracts @_fmt from an object value", () => {
    const row: Row = { thread: { "@_fmt": "Main Thread 0x1e97f4" } };
    expect(extractFmt(row, "thread")).toBe("Main Thread 0x1e97f4");
  });

  it("returns null when key is a plain string", () => {
    const row: Row = { thread: "Main Thread" };
    expect(extractFmt(row, "thread")).toBeNull();
  });

  it("returns null when object has no @_fmt", () => {
    const row: Row = { thread: { "#text": "12345" } };
    expect(extractFmt(row, "thread")).toBeNull();
  });

  it("returns null for missing key", () => {
    const row: Row = {};
    expect(extractFmt(row, "thread")).toBeNull();
  });
});

// ── extractNum ──────────────────────────────────────────────────────

describe("extractNum", () => {
  it("extracts a plain number", () => {
    const row: Row = { size: 1024 };
    expect(extractNum(row, "size")).toBe(1024);
  });

  it("extracts a number from a numeric string", () => {
    const row: Row = { size: "1024" };
    expect(extractNum(row, "size")).toBe(1024);
  });

  it("extracts from @_ prefixed attribute", () => {
    const row: Row = { "@_size": 2048 };
    expect(extractNum(row, "size")).toBe(2048);
  });

  it("extracts from nested {#text} object", () => {
    const row: Row = { weight: { "#text": 5000000, "@_fmt": "5.00 ms" } };
    expect(extractNum(row, "weight")).toBe(5000000);
  });

  it("returns null for missing key", () => {
    const row: Row = {};
    expect(extractNum(row, "size")).toBeNull();
  });

  it("returns null for non-numeric value", () => {
    const row: Row = { size: "not-a-number" };
    expect(extractNum(row, "size")).toBeNull();
  });

  it("handles zero correctly", () => {
    const row: Row = { size: 0 };
    expect(extractNum(row, "size")).toBe(0);
  });
});

// ── extractFmtNum ───────────────────────────────────────────────────

describe("extractFmtNum", () => {
  it("extracts number from '12/20' style fmt string", () => {
    const row: Row = { "energy-impact": { "@_fmt": "12/20", "#text": 12 } };
    expect(extractFmtNum(row, "energy-impact")).toBe(12);
  });

  it("extracts number from a decimal fmt string", () => {
    const row: Row = { level: { "@_fmt": "3.5/20" } };
    expect(extractFmtNum(row, "level")).toBe(3.5);
  });

  it("extracts leading number from fmt with units", () => {
    const row: Row = { impact: { "@_fmt": "128 KB" } };
    expect(extractFmtNum(row, "impact")).toBe(128);
  });

  it("returns null when value is not an object", () => {
    const row: Row = { impact: 5 };
    expect(extractFmtNum(row, "impact")).toBeNull();
  });

  it("returns null when object has no @_fmt", () => {
    const row: Row = { impact: { "#text": 5 } };
    expect(extractFmtNum(row, "impact")).toBeNull();
  });

  it("returns null for missing key", () => {
    const row: Row = {};
    expect(extractFmtNum(row, "impact")).toBeNull();
  });
});

// ── parseFmtDuration ────────────────────────────────────────────────

describe("parseFmtDuration", () => {
  it("parses milliseconds: '123ms'", () => {
    expect(parseFmtDuration("123ms")).toBe(123);
  });

  it("parses milliseconds with space: '123 ms'", () => {
    expect(parseFmtDuration("123 ms")).toBe(123);
  });

  it("parses decimal milliseconds: '1.5ms'", () => {
    expect(parseFmtDuration("1.5ms")).toBe(1.5);
  });

  it("parses seconds: '1.5 s'", () => {
    expect(parseFmtDuration("1.5 s")).toBe(1500);
  });

  it("parses seconds without space: '2.3s'", () => {
    expect(parseFmtDuration("2.3s")).toBe(2300);
  });

  it("parses microseconds with mu: '500 \u03bcs'", () => {
    expect(parseFmtDuration("500 \u03bcs")).toBe(0.5);
  });

  it("parses microseconds with u: '500 us'", () => {
    expect(parseFmtDuration("500 us")).toBe(0.5);
  });

  it("returns 0 for unrecognized format", () => {
    expect(parseFmtDuration("unknown")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseFmtDuration("")).toBe(0);
  });
});

// ── parseSizeFmt ────────────────────────────────────────────────────

describe("parseSizeFmt", () => {
  it("parses '128 KB'", () => {
    expect(parseSizeFmt("128 KB")).toBe(128 * 1024);
  });

  it("parses '1.5 MB'", () => {
    expect(parseSizeFmt("1.5 MB")).toBe(1.5 * 1024 * 1024);
  });

  it("parses '2 GB'", () => {
    expect(parseSizeFmt("2 GB")).toBe(2 * 1024 * 1024 * 1024);
  });

  it("parses '4096 bytes'", () => {
    expect(parseSizeFmt("4096 bytes")).toBe(4096);
  });

  it("parses plain number string '4096'", () => {
    expect(parseSizeFmt("4096")).toBe(4096);
  });

  it("parses case insensitive: '128 kb'", () => {
    expect(parseSizeFmt("128 kb")).toBe(128 * 1024);
  });

  it("parses '512 B'", () => {
    expect(parseSizeFmt("512 B")).toBe(512);
  });

  it("returns 0 for unrecognized format", () => {
    expect(parseSizeFmt("unknown")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseSizeFmt("")).toBe(0);
  });
});

// ── formatBytes ─────────────────────────────────────────────────────

describe("formatBytes", () => {
  it("formats bytes under 1 KB", () => {
    expect(formatBytes(512)).toBe("512 bytes");
  });

  it("formats 0 bytes", () => {
    expect(formatBytes(0)).toBe("0 bytes");
  });

  it("formats bytes in KB range", () => {
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("formats 1024 bytes as 1 KB", () => {
    expect(formatBytes(1024)).toBe("1 KB");
  });

  it("formats bytes in MB range", () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("formats exact MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("formats large MB values", () => {
    expect(formatBytes(100 * 1024 * 1024)).toBe("100.0 MB");
  });
});

// ── extractDurationMs ────────────────────────────────────────────────

describe("extractDurationMs", () => {
  const keys = ["duration", "elapsed-time"];

  it("extracts from @_fmt formatted string (preferred)", () => {
    const row: Row = { duration: { "@_fmt": "500 ms", "#text": 500000000 } };
    expect(extractDurationMs(row, keys)).toBe(500);
  });

  it("falls back to #text nanoseconds when @_fmt fails", () => {
    const row: Row = { duration: { "#text": 250000000 } };
    expect(extractDurationMs(row, keys)).toBe(250);
  });

  it("converts plain nanosecond values (>= 1_000_000)", () => {
    const row: Row = { duration: 5000000 };
    expect(extractDurationMs(row, keys)).toBe(5);
  });

  it("treats plain values < 1_000_000 as milliseconds", () => {
    const row: Row = { duration: 150 };
    expect(extractDurationMs(row, keys)).toBe(150);
  });

  it("tries second key when first is missing", () => {
    const row: Row = { "elapsed-time": { "@_fmt": "1.5 s" } };
    expect(extractDurationMs(row, keys)).toBe(1500);
  });

  it("tries @_-prefixed attribute keys", () => {
    const row: Row = { "@_duration": 2000000 };
    expect(extractDurationMs(row, keys)).toBe(2);
  });

  it("returns 0 when no keys match", () => {
    const row: Row = { other: 100 };
    expect(extractDurationMs(row, keys)).toBe(0);
  });

  it("parses microseconds from @_fmt", () => {
    const row: Row = { duration: { "@_fmt": "500 \u03bcs" } };
    expect(extractDurationMs(row, keys)).toBe(0.5);
  });
});

// ── extractTimestampMs ───────────────────────────────────────────────

describe("extractTimestampMs", () => {
  it("extracts from #text nanoseconds", () => {
    const row: Row = { "start-time": { "#text": 1000000000 } };
    expect(extractTimestampMs(row, "start-time")).toBe(1000);
  });

  it("converts plain nanosecond values", () => {
    const row: Row = { "start-time": 5000000 };
    expect(extractTimestampMs(row, "start-time")).toBe(5);
  });

  it("treats plain values <= 1_000_000 as milliseconds", () => {
    const row: Row = { "start-time": 500 };
    expect(extractTimestampMs(row, "start-time")).toBe(500);
  });

  it("returns null for missing key", () => {
    const row: Row = {};
    expect(extractTimestampMs(row, "start-time")).toBeNull();
  });

  it("returns null for non-numeric value", () => {
    const row: Row = { "start-time": "not-a-number" };
    expect(extractTimestampMs(row, "start-time")).toBeNull();
  });
});

// ── extractFirstStr ──────────────────────────────────────────────────

describe("extractFirstStr", () => {
  it("returns value from first matching key", () => {
    const row: Row = { name: "func1" };
    expect(extractFirstStr(row, ["symbol", "name"])).toBe("func1");
  });

  it("skips missing keys and returns first match", () => {
    const row: Row = { type: "MyView" };
    expect(extractFirstStr(row, ["view-name", "symbol", "type"])).toBe("MyView");
  });

  it("returns null when no keys match", () => {
    const row: Row = { other: "value" };
    expect(extractFirstStr(row, ["name", "symbol"])).toBeNull();
  });

  it("returns first match even if later keys also match", () => {
    const row: Row = { symbol: "first", name: "second" };
    expect(extractFirstStr(row, ["symbol", "name"])).toBe("first");
  });
});

// ── extractFirstStrOrFmt ─────────────────────────────────────────────

describe("extractFirstStrOrFmt", () => {
  it("returns extractStr value when available", () => {
    const row: Row = { name: "plain" };
    expect(extractFirstStrOrFmt(row, ["name"])).toBe("plain");
  });

  it("falls back to extractFmt when extractStr returns null", () => {
    const row: Row = { name: { "@_fmt": "formatted" } };
    expect(extractFirstStrOrFmt(row, ["name"])).toBe("formatted");
  });

  it("tries multiple keys", () => {
    const row: Row = { library: { "@_fmt": "MyLib" } };
    expect(extractFirstStrOrFmt(row, ["binary", "library"])).toBe("MyLib");
  });

  it("returns null when no keys match", () => {
    const row: Row = {};
    expect(extractFirstStrOrFmt(row, ["name", "type"])).toBeNull();
  });
});

// ── extractFirstNum ──────────────────────────────────────────────────

describe("extractFirstNum", () => {
  it("returns extractNum value when available", () => {
    const row: Row = { count: 42 };
    expect(extractFirstNum(row, ["count"])).toBe(42);
  });

  it("falls back to extractFmtNum when extractNum returns null", () => {
    const row: Row = { impact: { "@_fmt": "12/20" } };
    expect(extractFirstNum(row, ["impact"])).toBe(12);
  });

  it("tries multiple keys in order", () => {
    const row: Row = { "gpu-energy": 5 };
    expect(extractFirstNum(row, ["cpu-energy", "gpu-energy"])).toBe(5);
  });

  it("returns null when no keys match", () => {
    const row: Row = {};
    expect(extractFirstNum(row, ["count", "instances"])).toBeNull();
  });

  it("returns zero correctly", () => {
    const row: Row = { count: 0 };
    expect(extractFirstNum(row, ["count"])).toBe(0);
  });
});
