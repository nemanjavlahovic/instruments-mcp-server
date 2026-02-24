import { describe, it, expect } from "vitest";
import { matchDevice, type SimDevice } from "../utils/simctl.js";

const devices: SimDevice[] = [
  { udid: "AAAA-1111", name: "iPhone 16 Pro", state: "Booted", runtime: "iOS 18.0" },
  { udid: "BBBB-2222", name: "iPhone 15", state: "Booted", runtime: "iOS 17.5" },
];

describe("matchDevice", () => {
  it("returns first device for 'booted'", () => {
    const result = matchDevice(devices, "booted");
    expect(result.udid).toBe("AAAA-1111");
  });

  it("returns first device for undefined", () => {
    const result = matchDevice(devices, undefined);
    expect(result.udid).toBe("AAAA-1111");
  });

  it("matches by exact UDID", () => {
    const result = matchDevice(devices, "BBBB-2222");
    expect(result.name).toBe("iPhone 15");
  });

  it("matches by exact name (case-insensitive)", () => {
    const result = matchDevice(devices, "iphone 16 pro");
    expect(result.udid).toBe("AAAA-1111");
  });

  it("matches by partial name", () => {
    const result = matchDevice(devices, "iPhone 15");
    expect(result.udid).toBe("BBBB-2222");
  });

  it("prefers exact name match over partial", () => {
    const devs: SimDevice[] = [
      { udid: "A", name: "iPhone 16", state: "Booted", runtime: "iOS 18.0" },
      { udid: "B", name: "iPhone 16 Pro", state: "Booted", runtime: "iOS 18.0" },
    ];
    const result = matchDevice(devs, "iPhone 16");
    expect(result.udid).toBe("A");
  });

  it("throws when no simulators are booted", () => {
    expect(() => matchDevice([], "booted")).toThrow("No booted simulators");
  });

  it("throws when no simulator matches the identifier", () => {
    expect(() => matchDevice(devices, "iPad Air")).toThrow('No booted simulator matching "iPad Air"');
  });

  it("includes available simulators in error message", () => {
    try {
      matchDevice(devices, "iPad Air");
    } catch (e) {
      expect(String(e)).toContain("iPhone 16 Pro");
      expect(String(e)).toContain("iPhone 15");
    }
  });
});
