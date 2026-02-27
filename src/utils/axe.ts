/**
 * Low-level wrapper around AXe CLI for iOS Simulator UI automation.
 * Mirrors the pattern established in simctl.ts and xctrace.ts.
 *
 * AXe CLI: https://github.com/cameroncooke/AXe
 * Install: brew tap cameroncooke/axe && brew install axe
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────

export interface AxeElement {
  role?: string;
  label?: string;
  identifier?: string;
  value?: string;
  frame?: { x: number; y: number; width: number; height: number };
  traits?: string[];
  children?: AxeElement[];
}

export interface AxeAccessibilityTree {
  elements: AxeElement[];
  totalElements: number;
  truncated?: boolean;
  truncatedMessage?: string;
}

export interface AxeTapOptions {
  id?: string;
  label?: string;
  x?: number;
  y?: number;
}

export interface AxeSwipeOptions {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  duration?: number;
  delta?: number;
}

export interface AxeTouchOptions {
  x: number;
  y: number;
  durationSeconds: number;
}

export type AxeGesturePreset =
  | "scroll-up"
  | "scroll-down"
  | "scroll-left"
  | "scroll-right"
  | "swipe-from-left-edge"
  | "swipe-from-right-edge"
  | "swipe-from-top-edge"
  | "swipe-from-bottom-edge";

export const AXE_GESTURE_PRESETS: readonly AxeGesturePreset[] = [
  "scroll-up",
  "scroll-down",
  "scroll-left",
  "scroll-right",
  "swipe-from-left-edge",
  "swipe-from-right-edge",
  "swipe-from-top-edge",
  "swipe-from-bottom-edge",
] as const;

export interface AxeGestureOptions {
  screenWidth?: number;
  screenHeight?: number;
  preDelay?: number;
  postDelay?: number;
}

// ── Binary resolution ──────────────────────────────────────────────

let cachedAxePath: string | null = null;

export function getAxePath(): string {
  if (cachedAxePath) return cachedAxePath;

  // 1. Environment variable override
  if (process.env.INSTRUMENTSMCP_AXE_PATH) {
    cachedAxePath = process.env.INSTRUMENTSMCP_AXE_PATH;
    return cachedAxePath;
  }

  // 2. Apple Silicon Homebrew
  if (existsSync("/opt/homebrew/bin/axe")) {
    cachedAxePath = "/opt/homebrew/bin/axe";
    return cachedAxePath;
  }

  // 3. Intel Homebrew
  if (existsSync("/usr/local/bin/axe")) {
    cachedAxePath = "/usr/local/bin/axe";
    return cachedAxePath;
  }

  // 4. PATH fallback
  cachedAxePath = "axe";
  return cachedAxePath;
}

/** Reset cached path — exported for testing. */
export function _resetAxePathCache(): void {
  cachedAxePath = null;
}

// ── Verification ───────────────────────────────────────────────────

const AXE_INSTALL_INSTRUCTIONS =
  "AXe CLI not found. Install with:\n  brew tap cameroncooke/axe && brew install axe\n\nOr set INSTRUMENTSMCP_AXE_PATH to the binary location.";

let cachedVerification: { available: boolean; error?: string } | null = null;

export async function verifyAxe(): Promise<{ available: boolean; error?: string }> {
  try {
    await execFileAsync(getAxePath(), ["list-simulators"], { timeout: 15_000 });
    return { available: true };
  } catch {
    return { available: false, error: AXE_INSTALL_INSTRUCTIONS };
  }
}

async function ensureAxe(): Promise<void> {
  if (cachedVerification === null) {
    cachedVerification = await verifyAxe();
  }
  if (!cachedVerification.available) {
    throw new Error(cachedVerification.error ?? AXE_INSTALL_INSTRUCTIONS);
  }
}

/** Reset cached verification — exported for testing. */
export function _resetVerificationCache(): void {
  cachedVerification = null;
}

// ── AXe commands ───────────────────────────────────────────────────

/**
 * Describe the UI accessibility hierarchy of a simulator.
 */
export async function axeDescribeUI(udid: string): Promise<string> {
  await ensureAxe();

  const args = ["describe-ui", "--udid", udid];

  const { stdout } = await execFileAsync(getAxePath(), args, {
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
  });

  return stdout;
}

/**
 * Tap an element by accessibility id, label, or coordinates.
 * At least one targeting method must be provided.
 */
export async function axeTap(udid: string, opts: AxeTapOptions): Promise<void> {
  await ensureAxe();

  if (!opts.id && !opts.label && (opts.x == null || opts.y == null)) {
    throw new Error("axeTap requires at least one targeting method: id, label, or x/y coordinates");
  }

  const args = ["tap", "--udid", udid];

  if (opts.id) {
    args.push("--id", opts.id);
  } else if (opts.label) {
    args.push("--label", opts.label);
  } else if (opts.x != null && opts.y != null) {
    args.push("-x", String(opts.x), "-y", String(opts.y));
  }

  await execFileAsync(getAxePath(), args, { timeout: 15_000 });
}

/**
 * Type text into the currently focused field.
 * Timeout scales with text length.
 */
export async function axeType(udid: string, text: string): Promise<void> {
  await ensureAxe();

  const args = ["type", text, "--udid", udid];
  const timeout = 15_000 + text.length * 100;

  await execFileAsync(getAxePath(), args, { timeout });
}

/**
 * Swipe between two points.
 */
export async function axeSwipe(udid: string, opts: AxeSwipeOptions): Promise<void> {
  await ensureAxe();

  const args = [
    "swipe",
    "--start-x", String(opts.startX),
    "--start-y", String(opts.startY),
    "--end-x", String(opts.endX),
    "--end-y", String(opts.endY),
    "--udid", udid,
  ];

  if (opts.duration != null) {
    args.push("--duration", String(opts.duration));
  }
  if (opts.delta != null) {
    args.push("--delta", String(opts.delta));
  }

  await execFileAsync(getAxePath(), args, { timeout: 15_000 });
}

/**
 * Perform a preset gesture (scroll, edge swipe).
 */
export async function axeGesture(
  udid: string,
  preset: AxeGesturePreset,
  opts?: AxeGestureOptions
): Promise<void> {
  await ensureAxe();

  const args = ["gesture", preset, "--udid", udid];

  if (opts?.screenWidth != null) {
    args.push("--screen-width", String(opts.screenWidth));
  }
  if (opts?.screenHeight != null) {
    args.push("--screen-height", String(opts.screenHeight));
  }
  if (opts?.preDelay != null) {
    args.push("--pre-delay", String(opts.preDelay));
  }
  if (opts?.postDelay != null) {
    args.push("--post-delay", String(opts.postDelay));
  }

  await execFileAsync(getAxePath(), args, { timeout: 15_000 });
}

/**
 * Long press (touch-and-hold) at coordinates.
 */
export async function axeTouch(udid: string, opts: AxeTouchOptions): Promise<void> {
  await ensureAxe();

  const args = [
    "touch",
    "-x", String(opts.x),
    "-y", String(opts.y),
    "--down", "--up",
    "--delay", String(opts.durationSeconds),
    "--udid", udid,
  ];

  const timeout = 15_000 + opts.durationSeconds * 1000;
  await execFileAsync(getAxePath(), args, { timeout });
}
