import { describe, it, expect } from "vitest";
import { parseArgs } from "../cli.js";

// ── CLI parseArgs tests ───────────────────────────────────────────

describe("CLI parseArgs", () => {
  it("returns help for --help flag", () => {
    const result = parseArgs(["--help"]);
    expect(result).toEqual({ kind: "help" });
  });

  it("returns help for -h flag", () => {
    const result = parseArgs(["-h"]);
    expect(result).toEqual({ kind: "help" });
  });

  it("returns error when no process or launch path specified", () => {
    const result = parseArgs([]);
    expect(result.kind).toBe("error");
  });

  it("returns error for unknown option", () => {
    const result = parseArgs(["--unknown-flag"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("--unknown-flag");
    }
  });

  it("parses --process correctly", () => {
    const result = parseArgs(["--process", "MyApp"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.process).toBe("MyApp");
      expect(result.opts.template).toBe("Time Profiler");
    }
  });

  it("parses -p shorthand", () => {
    const result = parseArgs(["-p", "MyApp"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.process).toBe("MyApp");
    }
  });

  it("parses --template correctly", () => {
    const result = parseArgs(["--process", "MyApp", "--template", "Allocations"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.template).toBe("Allocations");
    }
  });

  it("parses -t shorthand", () => {
    const result = parseArgs(["-p", "MyApp", "-t", "Leaks"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.template).toBe("Leaks");
    }
  });

  it("parses --device correctly", () => {
    const result = parseArgs(["--process", "MyApp", "--device", "booted"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.device).toBe("booted");
    }
  });

  it("parses -d shorthand", () => {
    const result = parseArgs(["-p", "MyApp", "-d", "iPhone 16 Pro"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.device).toBe("iPhone 16 Pro");
    }
  });

  it("parses --launch correctly", () => {
    const result = parseArgs(["--launch", "/path/to/MyApp.app"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.launchPath).toBe("/path/to/MyApp.app");
      expect(result.opts.process).toBeUndefined();
    }
  });

  it("parses -l shorthand", () => {
    const result = parseArgs(["-l", "/path/to/MyApp.app"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.launchPath).toBe("/path/to/MyApp.app");
    }
  });

  it("parses all options together", () => {
    const result = parseArgs(["-p", "MyApp", "-t", "Energy Log", "-d", "booted"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.process).toBe("MyApp");
      expect(result.opts.template).toBe("Energy Log");
      expect(result.opts.device).toBe("booted");
    }
  });

  it("defaults template to Time Profiler", () => {
    const result = parseArgs(["--process", "MyApp"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.opts.template).toBe("Time Profiler");
    }
  });
});
