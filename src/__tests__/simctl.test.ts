import { describe, it, expect } from "vitest";
import { parsePlistApps } from "../utils/simctl.js";
import { findTableXpath, findTrackXpath, parseTimeLimitToMs, sleep } from "../utils/trace-helpers.js";

// ── parsePlistApps tests ───────────────────────────────────────────

describe("parsePlistApps", () => {
  const samplePlist = `{
    "com.example.MyApp" = {
        ApplicationType = User;
        CFBundleDisplayName = "My App";
        CFBundleIdentifier = "com.example.MyApp";
        Path = "/Users/test/Library/Developer/CoreSimulator/Devices/ABC/data/Containers/Bundle/Application/DEF/MyApp.app";
    };
    "com.apple.mobilesafari" = {
        ApplicationType = System;
        CFBundleDisplayName = Safari;
        CFBundleIdentifier = "com.apple.mobilesafari";
        Path = "/Applications/Simulator.app/Contents/Developer/CoreSimulator.framework/Versions/A/Resources/RuntimeRoot/Applications/MobileSafari.app";
    };
    "com.example.AnotherApp" = {
        ApplicationType = User;
        CFBundleName = "Another App";
        CFBundleIdentifier = "com.example.AnotherApp";
        Path = "/Users/test/Library/Developer/CoreSimulator/Devices/ABC/data/Containers/Bundle/Application/GHI/AnotherApp.app";
    };
}`;

  it("parses user apps from plist output", () => {
    const apps = parsePlistApps(samplePlist, "User");
    expect(apps).toHaveLength(2);
    expect(apps[0].bundleId).toBe("com.example.MyApp");
    expect(apps[0].displayName).toBe("My App");
    expect(apps[0].applicationType).toBe("User");
    expect(apps[1].bundleId).toBe("com.example.AnotherApp");
    expect(apps[1].displayName).toBe("Another App");
  });

  it("parses system apps when filtered", () => {
    const apps = parsePlistApps(samplePlist, "System");
    expect(apps).toHaveLength(1);
    expect(apps[0].bundleId).toBe("com.apple.mobilesafari");
    expect(apps[0].displayName).toBe("Safari");
    expect(apps[0].applicationType).toBe("System");
  });

  it("returns all apps with 'all' filter", () => {
    const apps = parsePlistApps(samplePlist, "all");
    expect(apps).toHaveLength(3);
  });

  it("returns empty array for empty plist", () => {
    const apps = parsePlistApps("", "User");
    expect(apps).toHaveLength(0);
  });

  it("returns empty array for plist with no matching apps", () => {
    const onlySystem = `{
    "com.apple.Preferences" = {
        ApplicationType = System;
        CFBundleDisplayName = Settings;
    };
}`;
    const apps = parsePlistApps(onlySystem, "User");
    expect(apps).toHaveLength(0);
  });

  it("falls back to CFBundleName when CFBundleDisplayName is missing", () => {
    const plist = `{
    "com.example.Test" = {
        ApplicationType = User;
        CFBundleName = "Test App";
    };
}`;
    const apps = parsePlistApps(plist, "User");
    expect(apps).toHaveLength(1);
    expect(apps[0].displayName).toBe("Test App");
  });

  it("falls back to bundle ID when both display name fields are missing", () => {
    const plist = `{
    "com.example.NoName" = {
        ApplicationType = User;
    };
}`;
    const apps = parsePlistApps(plist, "User");
    expect(apps).toHaveLength(1);
    expect(apps[0].displayName).toBe("com.example.NoName");
  });

  it("handles quoted and unquoted plist values", () => {
    const plist = `{
    "com.example.Mixed" = {
        ApplicationType = User;
        CFBundleDisplayName = "Quoted Name";
        CFBundleName = UnquotedName;
    };
}`;
    const apps = parsePlistApps(plist, "User");
    expect(apps[0].displayName).toBe("Quoted Name");
  });
});

// ── trace-helpers tests ────────────────────────────────────────────

describe("findTableXpath", () => {
  const sampleToc = `<?xml version="1.0"?>
<trace-toc>
  <run number="1">
    <data>
      <table schema="time-profile" />
      <table schema="time-sample" />
      <table schema="allocations-vm-summary" />
    </data>
  </run>
</trace-toc>`;

  it("finds table xpath by schema keyword", () => {
    const xpath = findTableXpath(sampleToc, "time-profile");
    expect(xpath).toBe('/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]');
  });

  it("finds table by partial keyword match", () => {
    const xpath = findTableXpath(sampleToc, "alloc");
    expect(xpath).toBe('/trace-toc/run[@number="1"]/data/table[@schema="allocations-vm-summary"]');
  });

  it("returns null for missing schema", () => {
    const xpath = findTableXpath(sampleToc, "energy");
    expect(xpath).toBeNull();
  });

  it("case-insensitive match", () => {
    const xpath = findTableXpath(sampleToc, "Time-Profile");
    expect(xpath).toBe('/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]');
  });

  it("defaults to run 1 when no run number found", () => {
    const noRun = `<?xml version="1.0"?><trace-toc><data><table schema="test-schema" /></data></trace-toc>`;
    const xpath = findTableXpath(noRun, "test");
    expect(xpath).toBe('/trace-toc/run[@number="1"]/data/table[@schema="test-schema"]');
  });

  it("uses correct run number", () => {
    const run2 = `<?xml version="1.0"?><trace-toc><run number="2"><data><table schema="cpu-data" /></data></run></trace-toc>`;
    const xpath = findTableXpath(run2, "cpu");
    expect(xpath).toBe('/trace-toc/run[@number="2"]/data/table[@schema="cpu-data"]');
  });
});

describe("findTrackXpath", () => {
  const trackToc = `<?xml version="1.0"?>
<trace-toc>
  <run number="1">
    <tracks>
      <track>
        <details>
          <detail schema="leak-detection" />
          <detail schema="http-traffic" />
        </details>
      </track>
    </tracks>
  </run>
</trace-toc>`;

  it("finds track detail by schema keyword", () => {
    const xpath = findTrackXpath(trackToc, "leak");
    expect(xpath).toBe('/trace-toc/run[@number="1"]/tracks/track/details/detail[@schema="leak-detection"]');
  });

  it("finds http traffic detail", () => {
    const xpath = findTrackXpath(trackToc, "http");
    expect(xpath).toBe('/trace-toc/run[@number="1"]/tracks/track/details/detail[@schema="http-traffic"]');
  });

  it("returns null for missing schema", () => {
    const xpath = findTrackXpath(trackToc, "energy");
    expect(xpath).toBeNull();
  });
});

describe("parseTimeLimitToMs", () => {
  it("parses seconds", () => {
    expect(parseTimeLimitToMs("15s")).toBe(15_000);
    expect(parseTimeLimitToMs("1s")).toBe(1_000);
  });

  it("parses minutes", () => {
    expect(parseTimeLimitToMs("1m")).toBe(60_000);
    expect(parseTimeLimitToMs("5m")).toBe(300_000);
  });

  it("parses hours", () => {
    expect(parseTimeLimitToMs("1h")).toBe(3_600_000);
  });

  it("parses milliseconds", () => {
    expect(parseTimeLimitToMs("500ms")).toBe(500);
  });

  it("returns default for invalid format", () => {
    expect(parseTimeLimitToMs("abc")).toBe(60_000);
    expect(parseTimeLimitToMs("")).toBe(60_000);
    expect(parseTimeLimitToMs("15")).toBe(60_000);
  });
});

describe("sleep", () => {
  it("resolves after the specified time", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });
});
