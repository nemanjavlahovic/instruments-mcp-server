import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveDevice } from "../utils/simctl.js";
import {
  axeDescribeUI,
  axeTap,
  axeType,
  axeSwipe,
  axeGesture,
  axeTouch,
  AXE_GESTURE_PRESETS,
  type AxeElement,
  type AxeAccessibilityTree,
} from "../utils/axe.js";

// ── Tree compaction ────────────────────────────────────────────────

const MAX_DEPTH = 10;
const MAX_ELEMENTS = 200;

/**
 * Normalize a raw AXe element to our clean AxeElement type.
 * Raw AXe JSON has: AXLabel, AXUniqueId, AXValue, AXFrame, role_description,
 * pid, subrole, custom_actions, content_required, help, title, enabled, etc.
 * We only keep: type, role, label, identifier, value, frame, traits, children.
 */
function normalizeElement(raw: Record<string, unknown>): AxeElement {
  const el: AxeElement = {};

  // Map AXe field names to our clean names
  const role = raw.type ?? raw.role;
  if (role) el.role = String(role);

  const label = raw.label ?? raw.AXLabel;
  if (label) el.label = String(label);

  const identifier = raw.identifier ?? raw.AXUniqueId;
  if (identifier) el.identifier = String(identifier);

  const value = raw.value ?? raw.AXValue;
  if (value) el.value = String(value);

  const frame = raw.frame as AxeElement["frame"] | undefined;
  if (frame) el.frame = frame;

  if (Array.isArray(raw.traits) && raw.traits.length > 0) {
    el.traits = raw.traits as string[];
  }

  // Recursively normalize children
  if (Array.isArray(raw.children) && raw.children.length > 0) {
    el.children = (raw.children as Record<string, unknown>[]).map(normalizeElement);
  }

  return el;
}

function isInteractive(el: AxeElement): boolean {
  return !!(el.label || el.identifier || el.value);
}

/**
 * Compact an accessibility tree for LLM consumption:
 * - Normalize raw AXe fields to clean names (strips pid, subrole, AXFrame, etc.)
 * - Remove structural containers with no label/identifier/value
 * - Truncate at depth 10
 * - Cap at 200 elements
 * - Preserve frame coordinates for tapping
 */
export function compactTree(elements: AxeElement[]): AxeAccessibilityTree {
  let count = 0;
  let truncated = false;

  function walk(nodes: AxeElement[], depth: number): AxeElement[] {
    if (depth > MAX_DEPTH) {
      truncated = true;
      return [];
    }

    const result: AxeElement[] = [];
    for (const node of nodes) {
      if (count >= MAX_ELEMENTS) {
        truncated = true;
        break;
      }

      const children = node.children ? walk(node.children, depth + 1) : [];

      // Keep if interactive or has interactive descendants
      if (isInteractive(node) || children.length > 0) {
        count++;
        const compacted: AxeElement = { ...node };
        if (children.length > 0) {
          compacted.children = children;
        } else {
          delete compacted.children;
        }
        result.push(compacted);
      }
    }
    return result;
  }

  const compacted = walk(elements, 0);
  const totalElements = count;

  const tree: AxeAccessibilityTree = {
    elements: compacted,
    totalElements,
  };

  if (truncated) {
    tree.truncated = true;
    tree.truncatedMessage = `Tree truncated (max depth: ${MAX_DEPTH}, max elements: ${MAX_ELEMENTS})`;
  }

  return tree;
}

/**
 * Try to parse raw describe-ui output as JSON, normalize fields, then compact.
 * Falls back to raw text if not JSON.
 */
export function parseAndCompact(raw: string): AxeAccessibilityTree | string {
  try {
    const parsed = JSON.parse(raw);
    const rawElements: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
    // Normalize AXe fields → clean AxeElement, then compact
    const elements = rawElements.map(normalizeElement);
    return compactTree(elements);
  } catch {
    // Not JSON — return raw text (AXe may use a different format)
    return raw.trim();
  }
}

// ── AXe install note (appended to tool descriptions) ──────────────

const AXE_NOTE =
  "\n\nRequires AXe CLI: brew tap cameroncooke/axe && brew install axe";

// ── Tool registration ──────────────────────────────────────────────

export function registerUITools(server: McpServer): void {
  // ── ui_snapshot ─────────────────────────────────────────────────
  server.tool(
    "ui_snapshot",
    `Get the accessibility hierarchy of a simulator screen.
This is the key tool for understanding what's on screen — returns element roles,
labels, identifiers, values, and frame coordinates. Use it to find elements
before tapping or swiping.${AXE_NOTE}`,
    {
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
    },
    async ({ device }) => {
      try {
        const sim = await resolveDevice(device);
        const raw = await axeDescribeUI(sim.udid);
        const result = parseAndCompact(raw);
        return {
          content: [{
            type: "text" as const,
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `ui_snapshot failed: ${e}` }], isError: true };
      }
    }
  );

  // ── ui_tap ──────────────────────────────────────────────────────
  server.tool(
    "ui_tap",
    `Tap a UI element on the simulator by accessibility id (most reliable),
label, or x/y coordinates. At least one targeting method must be provided.
Prefer accessibility id when available — use ui_snapshot to discover them.${AXE_NOTE}`,
    {
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
      id: z.string().optional().describe("Accessibility identifier to tap"),
      label: z.string().optional().describe("Accessibility label to tap"),
      x: z.number().optional().describe("X coordinate to tap"),
      y: z.number().optional().describe("Y coordinate to tap"),
    },
    async ({ device, id, label, x, y }) => {
      try {
        if (!id && !label && (x == null || y == null)) {
          return {
            content: [{
              type: "text" as const,
              text: "ui_tap requires at least one targeting method: id, label, or x/y coordinates",
            }],
            isError: true,
          };
        }
        const sim = await resolveDevice(device);
        await axeTap(sim.udid, { id, label, x, y });
        const target = id ? `id="${id}"` : label ? `label="${label}"` : `(${x}, ${y})`;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ tapped: target, device: sim.name }, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `ui_tap failed: ${e}` }], isError: true };
      }
    }
  );

  // ── ui_type ─────────────────────────────────────────────────────
  server.tool(
    "ui_type",
    `Type text into the currently focused field on the simulator.
Tap a text field first with ui_tap to focus it, then use this to type.${AXE_NOTE}`,
    {
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
      text: z.string().describe("Text to type"),
    },
    async ({ device, text }) => {
      try {
        const sim = await resolveDevice(device);
        await axeType(sim.udid, text);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ typed: text, device: sim.name }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `ui_type failed: ${e}` }], isError: true };
      }
    }
  );

  // ── ui_swipe ────────────────────────────────────────────────────
  server.tool(
    "ui_swipe",
    `Swipe between two points on the simulator screen.
Use ui_snapshot to get coordinates, then swipe between them.
For common gestures like scrolling, prefer ui_gesture instead.${AXE_NOTE}`,
    {
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
      start_x: z.number().describe("Start X coordinate"),
      start_y: z.number().describe("Start Y coordinate"),
      end_x: z.number().describe("End X coordinate"),
      end_y: z.number().describe("End Y coordinate"),
      duration: z.number().optional().describe("Swipe duration in seconds"),
    },
    async ({ device, start_x, start_y, end_x, end_y, duration }) => {
      try {
        const sim = await resolveDevice(device);
        await axeSwipe(sim.udid, {
          startX: start_x,
          startY: start_y,
          endX: end_x,
          endY: end_y,
          duration,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              swiped: { from: [start_x, start_y], to: [end_x, end_y] },
              device: sim.name,
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `ui_swipe failed: ${e}` }], isError: true };
      }
    }
  );

  // ── ui_gesture ──────────────────────────────────────────────────
  server.tool(
    "ui_gesture",
    `Perform a preset gesture on the simulator.
Available presets: scroll-up, scroll-down, scroll-left, scroll-right,
swipe-from-left-edge, swipe-from-right-edge, swipe-from-top-edge, swipe-from-bottom-edge.${AXE_NOTE}`,
    {
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
      preset: z.enum(AXE_GESTURE_PRESETS as unknown as [string, ...string[]]).describe("Gesture preset name"),
    },
    async ({ device, preset }) => {
      try {
        const sim = await resolveDevice(device);
        await axeGesture(sim.udid, preset as import("../utils/axe.js").AxeGesturePreset);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ gesture: preset, device: sim.name }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `ui_gesture failed: ${e}` }], isError: true };
      }
    }
  );

  // ── ui_long_press ───────────────────────────────────────────────
  server.tool(
    "ui_long_press",
    `Long press (touch-and-hold) at coordinates on the simulator.
Use ui_snapshot to find the target element's frame coordinates.${AXE_NOTE}`,
    {
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      duration_ms: z.number().optional().default(1000).describe("Hold duration in milliseconds (default: 1000)"),
    },
    async ({ device, x, y, duration_ms }) => {
      try {
        const sim = await resolveDevice(device);
        await axeTouch(sim.udid, { x, y, durationSeconds: duration_ms / 1000 });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              longPressed: { x, y, durationMs: duration_ms },
              device: sim.name,
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `ui_long_press failed: ${e}` }], isError: true };
      }
    }
  );
}
