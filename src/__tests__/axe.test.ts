import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

// Mock child_process and fs before importing the module
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

const mockExecFile = vi.mocked(execFile);
const mockExistsSync = vi.mocked(existsSync);

// Helper to make execFile resolve
function mockExecFileSuccess(stdout = "", stderr = "") {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback?: any) => {
    // promisify calls execFile with a callback as last arg
    const cb = typeof _opts === "function" ? _opts : callback;
    if (cb) cb(null, stdout, stderr);
    return {} as any;
  });
}

function mockExecFileFailure(error: Error) {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback?: any) => {
    const cb = typeof _opts === "function" ? _opts : callback;
    if (cb) cb(error, "", "");
    return {} as any;
  });
}

// We need to dynamically import after mocks are set up
async function loadAxe() {
  // Clear module cache to get fresh imports with mocks
  const mod = await import("../utils/axe.js");
  mod._resetAxePathCache();
  mod._resetVerificationCache();
  return mod;
}

describe("getAxePath", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
  });

  it("uses INSTRUMENTSMCP_AXE_PATH env var when set", async () => {
    process.env.INSTRUMENTSMCP_AXE_PATH = "/custom/path/axe";
    const axe = await loadAxe();
    expect(axe.getAxePath()).toBe("/custom/path/axe");
  });

  it("uses Apple Silicon Homebrew path when it exists", async () => {
    mockExistsSync.mockImplementation((p) => p === "/opt/homebrew/bin/axe");
    const axe = await loadAxe();
    expect(axe.getAxePath()).toBe("/opt/homebrew/bin/axe");
  });

  it("uses Intel Homebrew path when it exists", async () => {
    mockExistsSync.mockImplementation((p) => p === "/usr/local/bin/axe");
    const axe = await loadAxe();
    expect(axe.getAxePath()).toBe("/usr/local/bin/axe");
  });

  it("falls back to 'axe' PATH lookup", async () => {
    mockExistsSync.mockReturnValue(false);
    const axe = await loadAxe();
    expect(axe.getAxePath()).toBe("axe");
  });

  it("caches the result", async () => {
    mockExistsSync.mockReturnValue(false);
    const axe = await loadAxe();
    const first = axe.getAxePath();
    // Change mock — should still return cached value
    mockExistsSync.mockImplementation((p) => p === "/opt/homebrew/bin/axe");
    const second = axe.getAxePath();
    expect(first).toBe(second);
    expect(second).toBe("axe");
  });

  it("resets cache with _resetAxePathCache", async () => {
    mockExistsSync.mockReturnValue(false);
    const axe = await loadAxe();
    expect(axe.getAxePath()).toBe("axe");

    axe._resetAxePathCache();
    mockExistsSync.mockImplementation((p) => p === "/opt/homebrew/bin/axe");
    expect(axe.getAxePath()).toBe("/opt/homebrew/bin/axe");
  });
});

describe("verifyAxe", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
    mockExistsSync.mockReturnValue(false);
  });

  it("returns available: true when axe runs successfully", async () => {
    mockExecFileSuccess("simulator-1\nsimulator-2\n");
    const axe = await loadAxe();
    const result = await axe.verifyAxe();
    expect(result.available).toBe(true);
  });

  it("returns available: false when axe is not found", async () => {
    mockExecFileFailure(new Error("ENOENT"));
    const axe = await loadAxe();
    const result = await axe.verifyAxe();
    expect(result.available).toBe(false);
    expect(result.error).toContain("AXe CLI not found");
    expect(result.error).toContain("brew tap");
  });
});

describe("axeTap", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
    mockExistsSync.mockReturnValue(false);
  });

  it("builds correct args for id targeting", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await axe.axeTap("UDID-123", { id: "myButton" });

    // Second call is the tap (first is verifyAxe)
    const calls = mockExecFile.mock.calls;
    const tapCall = calls[calls.length - 1];
    expect(tapCall[1]).toEqual(["tap", "--udid", "UDID-123", "--id", "myButton"]);
  });

  it("builds correct args for label targeting", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await axe.axeTap("UDID-123", { label: "Submit" });

    const calls = mockExecFile.mock.calls;
    const tapCall = calls[calls.length - 1];
    expect(tapCall[1]).toEqual(["tap", "--udid", "UDID-123", "--label", "Submit"]);
  });

  it("builds correct args for coordinate targeting", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await axe.axeTap("UDID-123", { x: 100, y: 200 });

    const calls = mockExecFile.mock.calls;
    const tapCall = calls[calls.length - 1];
    expect(tapCall[1]).toEqual(["tap", "--udid", "UDID-123", "-x", "100", "-y", "200"]);
  });

  it("throws when no targeting method provided", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await expect(axe.axeTap("UDID-123", {})).rejects.toThrow("at least one targeting method");
  });
});

describe("axeType", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
    mockExistsSync.mockReturnValue(false);
  });

  it("builds correct args", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await axe.axeType("UDID-123", "hello world");

    const calls = mockExecFile.mock.calls;
    const typeCall = calls[calls.length - 1];
    expect(typeCall[1]).toEqual(["type", "hello world", "--udid", "UDID-123"]);
  });
});

describe("axeSwipe", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
    mockExistsSync.mockReturnValue(false);
  });

  it("builds correct args with all coordinates", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await axe.axeSwipe("UDID-123", { startX: 10, startY: 20, endX: 30, endY: 40 });

    const calls = mockExecFile.mock.calls;
    const swipeCall = calls[calls.length - 1];
    expect(swipeCall[1]).toEqual([
      "swipe",
      "--start-x", "10", "--start-y", "20",
      "--end-x", "30", "--end-y", "40",
      "--udid", "UDID-123",
    ]);
  });

  it("includes optional duration and delta", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await axe.axeSwipe("UDID-123", { startX: 0, startY: 0, endX: 100, endY: 100, duration: 0.5, delta: 10 });

    const calls = mockExecFile.mock.calls;
    const swipeCall = calls[calls.length - 1];
    expect(swipeCall[1]).toContain("--duration");
    expect(swipeCall[1]).toContain("0.5");
    expect(swipeCall[1]).toContain("--delta");
    expect(swipeCall[1]).toContain("10");
  });
});

describe("axeGesture", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
    mockExistsSync.mockReturnValue(false);
  });

  it("builds correct args for scroll-down", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await axe.axeGesture("UDID-123", "scroll-down");

    const calls = mockExecFile.mock.calls;
    const gestureCall = calls[calls.length - 1];
    expect(gestureCall[1]).toEqual(["gesture", "scroll-down", "--udid", "UDID-123"]);
  });

  it("includes optional screen dimensions", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await axe.axeGesture("UDID-123", "scroll-up", { screenWidth: 390, screenHeight: 844 });

    const calls = mockExecFile.mock.calls;
    const gestureCall = calls[calls.length - 1];
    expect(gestureCall[1]).toContain("--screen-width");
    expect(gestureCall[1]).toContain("390");
    expect(gestureCall[1]).toContain("--screen-height");
    expect(gestureCall[1]).toContain("844");
  });
});

describe("axeTouch", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
    mockExistsSync.mockReturnValue(false);
  });

  it("builds correct args for long press", async () => {
    mockExecFileSuccess();
    const axe = await loadAxe();
    await axe.axeTouch("UDID-123", { x: 100, y: 200, durationSeconds: 1.5 });

    const calls = mockExecFile.mock.calls;
    const touchCall = calls[calls.length - 1];
    expect(touchCall[1]).toEqual([
      "touch",
      "-x", "100", "-y", "200",
      "--down", "--up",
      "--delay", "1.5",
      "--udid", "UDID-123",
    ]);
  });
});

describe("axeDescribeUI", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
    mockExistsSync.mockReturnValue(false);
  });

  it("builds correct args", async () => {
    mockExecFileSuccess('{"role": "Application"}');
    const axe = await loadAxe();
    await axe.axeDescribeUI("UDID-123");

    const calls = mockExecFile.mock.calls;
    const describeCall = calls[calls.length - 1];
    expect(describeCall[1]).toEqual(["describe-ui", "--udid", "UDID-123"]);
  });
});

describe("ensureAxe (error propagation)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INSTRUMENTSMCP_AXE_PATH;
    mockExistsSync.mockReturnValue(false);
  });

  it("all functions throw with install message when AXe unavailable", async () => {
    mockExecFileFailure(new Error("ENOENT"));
    const axe = await loadAxe();

    await expect(axe.axeTap("X", { id: "btn" })).rejects.toThrow("brew tap");
    await expect(axe.axeType("X", "text")).rejects.toThrow("brew tap");
    await expect(axe.axeSwipe("X", { startX: 0, startY: 0, endX: 1, endY: 1 })).rejects.toThrow("brew tap");
    await expect(axe.axeGesture("X", "scroll-down")).rejects.toThrow("brew tap");
    await expect(axe.axeTouch("X", { x: 0, y: 0, durationSeconds: 1 })).rejects.toThrow("brew tap");
    await expect(axe.axeDescribeUI("X")).rejects.toThrow("brew tap");
  });
});

// ── compactTree + parseAndCompact tests (pure functions) ───────────

import { compactTree, parseAndCompact } from "../tools/ui.js";
import { shortenName } from "../utils/format-output.js";
import type { AxeElement } from "../utils/axe.js";

describe("compactTree", () => {
  it("removes structural elements with no label/identifier/value", () => {
    const elements: AxeElement[] = [
      { role: "Group", children: [
        { role: "Button", label: "Submit", frame: { x: 10, y: 20, width: 80, height: 40 } },
        { role: "Other" }, // no label/id/value — should be removed
      ]},
    ];

    const result = compactTree(elements);
    // Group is kept because it has interactive descendants
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].children).toHaveLength(1);
    expect(result.elements[0].children![0].label).toBe("Submit");
  });

  it("preserves elements with identifiers", () => {
    const elements: AxeElement[] = [
      { role: "TextField", identifier: "email-input", frame: { x: 0, y: 0, width: 300, height: 44 } },
    ];

    const result = compactTree(elements);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].identifier).toBe("email-input");
  });

  it("preserves elements with values", () => {
    const elements: AxeElement[] = [
      { role: "StaticText", value: "Hello World" },
    ];

    const result = compactTree(elements);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].value).toBe("Hello World");
  });

  it("respects depth limit", () => {
    // Create a deeply nested tree (depth > 10)
    let current: AxeElement = { role: "Leaf", label: "deep" };
    for (let i = 0; i < 15; i++) {
      current = { role: "Group", label: `level-${i}`, children: [current] };
    }

    const result = compactTree([current]);
    expect(result.truncated).toBe(true);
    expect(result.truncatedMessage).toContain("max depth");
  });

  it("caps at 200 elements", () => {
    const elements: AxeElement[] = Array.from({ length: 250 }, (_, i) => ({
      role: "Button",
      label: `btn-${i}`,
    }));

    const result = compactTree(elements);
    expect(result.totalElements).toBeLessThanOrEqual(200);
    expect(result.truncated).toBe(true);
  });

  it("handles empty input", () => {
    const result = compactTree([]);
    expect(result.elements).toHaveLength(0);
    expect(result.totalElements).toBe(0);
    expect(result.truncated).toBeUndefined();
  });

  it("preserves frame coordinates", () => {
    const elements: AxeElement[] = [
      { role: "Button", label: "Tap Me", frame: { x: 50, y: 100, width: 200, height: 44 } },
    ];

    const result = compactTree(elements);
    expect(result.elements[0].frame).toEqual({ x: 50, y: 100, width: 200, height: 44 });
  });

  it("removes children array when all children are pruned", () => {
    const elements: AxeElement[] = [
      {
        role: "Button",
        label: "Parent",
        children: [
          { role: "Other" }, // no label/id/value
          { role: "Group" }, // no label/id/value
        ],
      },
    ];

    const result = compactTree(elements);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].children).toBeUndefined();
  });
});

describe("parseAndCompact (AXe field normalization)", () => {
  it("strips AXe noise fields and normalizes to clean names", () => {
    const rawAxeJson = JSON.stringify([{
      AXFrame: "{{0, 0}, {402, 874}}",
      AXUniqueId: "submitBtn",
      frame: { x: 10, y: 20, width: 80, height: 40 },
      role_description: "button",
      AXLabel: "Submit",
      content_required: false,
      type: "Button",
      title: null,
      help: null,
      custom_actions: [],
      AXValue: null,
      enabled: true,
      role: "AXButton",
      children: [],
      subrole: null,
      pid: 12345,
    }]);

    const result = parseAndCompact(rawAxeJson);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(result.elements).toHaveLength(1);
    const el = result.elements[0];
    // Should have clean fields
    expect(el.role).toBe("Button");
    expect(el.label).toBe("Submit");
    expect(el.identifier).toBe("submitBtn");
    expect(el.frame).toEqual({ x: 10, y: 20, width: 80, height: 40 });
    // Should NOT have noise fields
    expect((el as Record<string, unknown>).AXFrame).toBeUndefined();
    expect((el as Record<string, unknown>).role_description).toBeUndefined();
    expect((el as Record<string, unknown>).pid).toBeUndefined();
    expect((el as Record<string, unknown>).subrole).toBeUndefined();
    expect((el as Record<string, unknown>).custom_actions).toBeUndefined();
    expect((el as Record<string, unknown>).content_required).toBeUndefined();
    expect((el as Record<string, unknown>).help).toBeUndefined();
    expect((el as Record<string, unknown>).title).toBeUndefined();
    expect((el as Record<string, unknown>).enabled).toBeUndefined();
  });

  it("normalizes nested children recursively", () => {
    const rawAxeJson = JSON.stringify([{
      type: "Application",
      AXLabel: "MyApp",
      frame: { x: 0, y: 0, width: 400, height: 800 },
      children: [{
        type: "Button",
        AXLabel: "Login",
        AXUniqueId: "loginBtn",
        frame: { x: 50, y: 100, width: 200, height: 44 },
        pid: 999,
        role_description: "button",
        children: [],
      }],
    }]);

    const result = parseAndCompact(rawAxeJson);
    if (typeof result === "string") return;

    expect(result.elements).toHaveLength(1);
    const app = result.elements[0];
    expect(app.label).toBe("MyApp");
    expect(app.children).toHaveLength(1);
    expect(app.children![0].label).toBe("Login");
    expect(app.children![0].identifier).toBe("loginBtn");
    expect((app.children![0] as Record<string, unknown>).pid).toBeUndefined();
  });

  it("returns raw text for non-JSON input", () => {
    const result = parseAndCompact("some raw text output");
    expect(result).toBe("some raw text output");
  });
});

describe("shortenName", () => {
  it("strips C++ template parameters", () => {
    expect(shortenName("swift::RefCounts<swift::RefCountBitsT<(swift::RefCountInlinedness)1>>::doDecrementSlow<(swift::PerformDeinit)1>"))
      .toBe("RefCounts::doDecrementSlow");
  });

  it("keeps last two namespace segments", () => {
    expect(shortenName("a::b::c::method")).toBe("c::method");
  });

  it("strips 'specialized' prefix", () => {
    expect(shortenName("specialized MyView.body.getter")).toBe("MyView.body.getter");
  });

  it("strips closure noise", () => {
    expect(shortenName("specialized implicit closure #1 in closure #1 in Attribute.init(_:)"))
      .toBe("Attribute.init(_:)");
  });

  it("caps at 80 characters", () => {
    const long = "a".repeat(100);
    expect(shortenName(long).length).toBeLessThanOrEqual(80);
  });

  it("leaves short names unchanged", () => {
    expect(shortenName("objc_msgSend")).toBe("objc_msgSend");
    expect(shortenName("main")).toBe("main");
  });

  it("handles AG::Graph functions", () => {
    expect(shortenName("AG::Graph::UpdateStack::update()")).toBe("UpdateStack::update()");
  });
});
