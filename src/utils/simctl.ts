/**
 * Low-level wrapper around `xcrun simctl` for iOS Simulator interaction.
 * Mirrors the pattern established in xctrace.ts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";

const execFileAsync = promisify(execFile);
const XCRUN_PATH = "/usr/bin/xcrun";
const TMP_DIR = join(process.env.HOME ?? "/tmp", ".instruments-mcp", "tmp");

// ── Types ──────────────────────────────────────────────────────────

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

export interface InstalledApp {
  bundleId: string;
  displayName: string;
  applicationType: string;
}

// ── Simulator discovery ────────────────────────────────────────────

/**
 * List booted simulators using `simctl list devices booted -j`.
 */
export async function simctlListBooted(): Promise<SimDevice[]> {
  const { stdout } = await execFileAsync(XCRUN_PATH, ["simctl", "list", "devices", "booted", "-j"], {
    timeout: 30_000,
  });

  const parsed = JSON.parse(stdout);
  const devices: SimDevice[] = [];

  // Structure: { devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [...] } }
  for (const [runtimeKey, runtimeDevices] of Object.entries(parsed.devices ?? {})) {
    const runtime = runtimeKey
      .replace("com.apple.CoreSimulator.SimRuntime.", "")
      .replace(/-/g, ".")
      .replace(/\.(\d)/, " $1");

    for (const dev of runtimeDevices as Array<Record<string, unknown>>) {
      if (dev.state === "Booted") {
        devices.push({
          udid: dev.udid as string,
          name: dev.name as string,
          state: dev.state as string,
          runtime,
        });
      }
    }
  }

  return devices;
}

/**
 * List installed apps on a simulator.
 * Output is NeXTSTEP plist format — parsed with regex.
 */
export async function simctlListApps(device: string, filter: "User" | "System" | "all" = "User"): Promise<InstalledApp[]> {
  const { stdout } = await execFileAsync(XCRUN_PATH, ["simctl", "listapps", device], {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return parsePlistApps(stdout, filter);
}

/**
 * Parse NeXTSTEP plist output from `simctl listapps`.
 * Exported for testing.
 */
export function parsePlistApps(plistOutput: string, filter: "User" | "System" | "all" = "User"): InstalledApp[] {
  const apps: InstalledApp[] = [];

  // Split on top-level app entries: "com.example.App" = {
  const appBlocks = plistOutput.split(/\n\s*"([^"]+)"\s*=\s*\{/);

  // appBlocks[0] is preamble, then alternating: [bundleId, blockContent, bundleId, blockContent, ...]
  for (let i = 1; i < appBlocks.length; i += 2) {
    const bundleId = appBlocks[i];
    const block = appBlocks[i + 1] ?? "";

    const displayName = extractPlistValue(block, "CFBundleDisplayName")
      || extractPlistValue(block, "CFBundleName")
      || bundleId;

    const appType = extractPlistValue(block, "ApplicationType") || "User";

    if (filter !== "all" && appType !== filter) continue;

    apps.push({ bundleId, displayName, applicationType: appType });
  }

  return apps;
}

function extractPlistValue(block: string, key: string): string | null {
  // Matches: Key = "value"; or Key = value;
  const pattern = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))\\s*;`);
  const match = block.match(pattern);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

// ── App lifecycle ──────────────────────────────────────────────────

/**
 * Launch an app on a simulator. Returns the PID.
 * Output format: `<bundle_id>: <pid>`
 */
export async function simctlLaunch(
  device: string,
  bundleId: string,
  options?: { terminateExisting?: boolean }
): Promise<{ pid: string; bundleId: string }> {
  const args = ["simctl", "launch"];
  if (options?.terminateExisting) {
    args.push("--terminate-running-process");
  }
  args.push(device, bundleId);

  const { stdout } = await execFileAsync(XCRUN_PATH, args, { timeout: 30_000 });

  const pidMatch = stdout.match(/:\s*(\d+)/);
  const pid = pidMatch ? pidMatch[1] : "unknown";

  return { pid, bundleId };
}

/**
 * Terminate a running app on a simulator.
 */
export async function simctlTerminate(device: string, bundleId: string): Promise<void> {
  await execFileAsync(XCRUN_PATH, ["simctl", "terminate", device, bundleId], {
    timeout: 30_000,
  });
}

/**
 * Install an app from a .app bundle path.
 */
export async function simctlInstall(device: string, appPath: string): Promise<void> {
  await execFileAsync(XCRUN_PATH, ["simctl", "install", device, appPath], {
    timeout: 60_000,
  });
}

// ── Interaction ────────────────────────────────────────────────────

/**
 * Open a URL (deep link) on a simulator.
 */
export async function simctlOpenUrl(device: string, url: string): Promise<void> {
  await execFileAsync(XCRUN_PATH, ["simctl", "openurl", device, url], {
    timeout: 30_000,
  });
}

/**
 * Send a simulated push notification.
 * Writes payload to a temp file, calls simctl push, then cleans up.
 */
export async function simctlPush(
  device: string,
  bundleId: string,
  payload: Record<string, unknown>
): Promise<void> {
  mkdirSync(TMP_DIR, { recursive: true });
  const tempFile = join(TMP_DIR, `push-${Date.now()}.json`);

  try {
    writeFileSync(tempFile, JSON.stringify(payload));
    await execFileAsync(XCRUN_PATH, ["simctl", "push", device, bundleId, tempFile], {
      timeout: 30_000,
    });
  } finally {
    try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Take a screenshot of a simulator. Saves as PNG.
 */
export async function simctlScreenshot(device: string, outputPath: string): Promise<string> {
  await execFileAsync(XCRUN_PATH, ["simctl", "io", device, "screenshot", outputPath], {
    timeout: 30_000,
  });
  return outputPath;
}

/**
 * Set appearance mode (light/dark).
 */
export async function simctlSetAppearance(device: string, mode: "light" | "dark"): Promise<void> {
  await execFileAsync(XCRUN_PATH, ["simctl", "ui", device, "appearance", mode], {
    timeout: 30_000,
  });
}

/**
 * Set simulated GPS location.
 */
export async function simctlSetLocation(device: string, latitude: number, longitude: number): Promise<void> {
  await execFileAsync(XCRUN_PATH, ["simctl", "location", device, "set", `${latitude},${longitude}`], {
    timeout: 30_000,
  });
}

// ── Device resolution ──────────────────────────────────────────────

/**
 * Resolve a device identifier to a booted SimDevice.
 * - undefined or "booted" → first booted simulator
 * - UDID string → matched from booted list
 * - Device name → matched from booted list
 * Throws if no matching booted simulator found.
 */
export async function resolveDevice(device?: string): Promise<SimDevice> {
  const booted = await simctlListBooted();

  if (booted.length === 0) {
    throw new Error("No booted simulators found. Boot a simulator first with: xcrun simctl boot <device-udid>");
  }

  if (!device || device === "booted") {
    return booted[0];
  }

  // Try matching by UDID
  const byUdid = booted.find((d) => d.udid === device);
  if (byUdid) return byUdid;

  // Try matching by name (case-insensitive)
  const byName = booted.find((d) => d.name.toLowerCase() === device.toLowerCase());
  if (byName) return byName;

  // Try partial name match
  const byPartial = booted.find((d) => d.name.toLowerCase().includes(device.toLowerCase()));
  if (byPartial) return byPartial;

  throw new Error(
    `No booted simulator matching "${device}". Booted simulators: ${booted.map((d) => `${d.name} (${d.udid})`).join(", ")}`
  );
}
