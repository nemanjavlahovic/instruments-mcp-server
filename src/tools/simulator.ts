import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { xctraceRecord, getTraceOutputDir, spawnXctraceRecord, type ActiveRecording } from "../utils/xctrace.js";
import { sleep } from "../utils/trace-helpers.js";
import { parseTraceByTemplate } from "../utils/parse-trace.js";
import { formatProfileResult } from "../utils/format-output.js";
import {
  resolveDevice,
  simctlListBooted,
  simctlListApps,
  simctlLaunch,
  simctlTerminate,
  simctlInstall,
  simctlOpenUrl,
  simctlPush,
  simctlScreenshot,
  simctlSetAppearance,
  simctlSetLocation,
} from "../utils/simctl.js";

// ── Scenario step schema ───────────────────────────────────────────

const scenarioStepSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("launch"),
    terminate_existing: z.boolean().optional().describe("Kill existing instance before launching (default: true)"),
  }),
  z.object({
    action: z.literal("terminate"),
  }),
  z.object({
    action: z.literal("wait"),
    seconds: z.number().min(0.1).max(300).describe("Seconds to wait"),
  }),
  z.object({
    action: z.literal("open_url"),
    url: z.string().describe("URL or deep link to open (e.g., 'myapp://feed')"),
  }),
  z.object({
    action: z.literal("push"),
    title: z.string().optional().describe("Notification title"),
    body: z.string().optional().describe("Notification body"),
    payload: z.string().optional().describe("Full APS JSON payload (overrides title/body)"),
  }),
  z.object({
    action: z.literal("screenshot"),
    label: z.string().optional().describe("Label for the screenshot file"),
  }),
  z.object({
    action: z.literal("set_appearance"),
    mode: z.enum(["light", "dark"]).describe("Appearance mode"),
  }),
  z.object({
    action: z.literal("set_location"),
    latitude: z.number().describe("GPS latitude"),
    longitude: z.number().describe("GPS longitude"),
  }),
  // UI automation steps (require AXe CLI)
  z.object({
    action: z.literal("tap"),
    id: z.string().optional().describe("Accessibility identifier to tap"),
    label: z.string().optional().describe("Accessibility label to tap"),
    x: z.number().optional().describe("X coordinate to tap"),
    y: z.number().optional().describe("Y coordinate to tap"),
  }),
  z.object({
    action: z.literal("type_text"),
    text: z.string().describe("Text to type into the focused field"),
  }),
  z.object({
    action: z.literal("swipe"),
    start_x: z.number().describe("Start X coordinate"),
    start_y: z.number().describe("Start Y coordinate"),
    end_x: z.number().describe("End X coordinate"),
    end_y: z.number().describe("End Y coordinate"),
    duration: z.number().optional().describe("Swipe duration in seconds"),
  }),
  z.object({
    action: z.literal("gesture"),
    preset: z.enum([
      "scroll-up", "scroll-down", "scroll-left", "scroll-right",
      "swipe-from-left-edge", "swipe-from-right-edge",
      "swipe-from-top-edge", "swipe-from-bottom-edge",
    ]).describe("Gesture preset name"),
  }),
  z.object({
    action: z.literal("snapshot_ui"),
    label: z.string().optional().describe("Label for this snapshot in the log"),
  }),
  z.object({
    action: z.literal("long_press"),
    x: z.number().describe("X coordinate"),
    y: z.number().describe("Y coordinate"),
    duration_ms: z.number().optional().describe("Hold duration in milliseconds (default: 1000)"),
  }),
]);

// ── Active recording state (module-level, persists across tool calls) ──

let activeRecording: (ActiveRecording & {
  device?: string;
  attachProcess?: string;
}) | null = null;

// ── Tool registration ──────────────────────────────────────────────

export function registerSimulatorTools(server: McpServer): void {
  // ── Discovery ────────────────────────────────────────────────────
  server.tool(
    "sim_list_booted",
    `List all booted iOS simulators and their installed user apps.
Returns: Device names, UDIDs, runtime versions, and installed app bundle IDs.
Use this to discover what's running before profiling.`,
    {
      include_apps: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include list of installed user apps per device (default: true)"),
    },
    async ({ include_apps }) => {
      try {
        const devices = await simctlListBooted();

        if (devices.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                devices: [],
                hint: "No booted simulators. Boot one with: xcrun simctl boot <device-udid>",
              }, null, 2),
            }],
          };
        }

        const result = await Promise.all(
          devices.map(async (dev) => {
            const entry: Record<string, unknown> = {
              name: dev.name,
              udid: dev.udid,
              runtime: dev.runtime,
            };
            if (include_apps) {
              const apps = await simctlListApps(dev.udid, "User");
              entry.apps = apps.map((a) => ({ bundleId: a.bundleId, name: a.displayName }));
            }
            return entry;
          })
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ devices: result }, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to list simulators: ${e}` }], isError: true };
      }
    }
  );

  // ── App lifecycle ────────────────────────────────────────────────
  server.tool(
    "sim_launch_app",
    `Launch an app by bundle ID on a booted simulator.
Returns the process ID (PID) of the launched app.`,
    {
      bundle_id: z.string().describe("App bundle identifier (e.g., 'com.example.MyApp')"),
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
      terminate_existing: z
        .boolean()
        .optional()
        .default(true)
        .describe("Kill existing instance before launching (default: true)"),
    },
    async ({ bundle_id, device, terminate_existing }) => {
      try {
        const sim = await resolveDevice(device);
        const { pid } = await simctlLaunch(sim.udid, bundle_id, { terminateExisting: terminate_existing });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              bundleId: bundle_id,
              pid,
              device: { name: sim.name, udid: sim.udid },
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to launch app: ${e}` }], isError: true };
      }
    }
  );

  server.tool(
    "sim_terminate_app",
    `Terminate a running app on a simulator.`,
    {
      bundle_id: z.string().describe("App bundle identifier"),
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
    },
    async ({ bundle_id, device }) => {
      try {
        const sim = await resolveDevice(device);
        await simctlTerminate(sim.udid, bundle_id);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ terminated: bundle_id, device: sim.name }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to terminate app: ${e}` }], isError: true };
      }
    }
  );

  // ── Navigation ───────────────────────────────────────────────────
  server.tool(
    "sim_open_url",
    `Open a URL or deep link on a simulator.
Use this for app navigation — simctl does not support direct tap/swipe.
The app must register the URL scheme in its Info.plist.`,
    {
      url: z.string().describe("URL to open (e.g., 'myapp://settings' or 'https://example.com')"),
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
    },
    async ({ url, device }) => {
      try {
        const sim = await resolveDevice(device);
        await simctlOpenUrl(sim.udid, url);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ opened: url, device: sim.name }, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to open URL: ${e}` }], isError: true };
      }
    }
  );

  // ── Push notifications ───────────────────────────────────────────
  server.tool(
    "sim_push_notification",
    `Send a simulated push notification to an app on a simulator.
Constructs an APS payload from title/body, or accepts a full custom payload.`,
    {
      bundle_id: z.string().describe("Target app bundle identifier"),
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
      title: z.string().optional().describe("Notification title"),
      body: z.string().optional().describe("Notification body text"),
      payload: z
        .string()
        .optional()
        .describe("Full APS JSON payload string (overrides title/body if provided)"),
    },
    async ({ bundle_id, device, title, body, payload }) => {
      try {
        const sim = await resolveDevice(device);
        const apsPayload = payload
          ? JSON.parse(payload) as Record<string, unknown>
          : { aps: { alert: { title: title || "Test Notification", body: body || "" } } };

        await simctlPush(sim.udid, bundle_id, apsPayload);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ pushed: true, bundleId: bundle_id, device: sim.name }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to send push: ${e}` }], isError: true };
      }
    }
  );

  // ── Screenshot ───────────────────────────────────────────────────
  server.tool(
    "sim_screenshot",
    `Take a screenshot of a simulator's screen. Saves as PNG.
Returns the file path to the saved screenshot.`,
    {
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
      label: z.string().optional().describe("Label for the screenshot file (e.g., 'home-screen')"),
    },
    async ({ device, label }) => {
      try {
        const sim = await resolveDevice(device);
        const filename = `screenshot-${label || "capture"}-${Date.now()}.png`;
        const outputPath = join(getTraceOutputDir(), filename);
        const { mkdirSync } = await import("node:fs");
        mkdirSync(getTraceOutputDir(), { recursive: true });
        await simctlScreenshot(sim.udid, outputPath);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ screenshot: outputPath, device: sim.name }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Screenshot failed: ${e}` }], isError: true };
      }
    }
  );

  // ── Appearance ───────────────────────────────────────────────────
  server.tool(
    "sim_set_appearance",
    `Toggle the simulator between light and dark mode.
Useful for testing appearance-sensitive performance (e.g., dark mode rendering).`,
    {
      mode: z.enum(["light", "dark"]).describe("Appearance mode"),
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
    },
    async ({ mode, device }) => {
      try {
        const sim = await resolveDevice(device);
        await simctlSetAppearance(sim.udid, mode);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ appearance: mode, device: sim.name }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to set appearance: ${e}` }], isError: true };
      }
    }
  );

  // ── Location ─────────────────────────────────────────────────────
  server.tool(
    "sim_set_location",
    `Set simulated GPS coordinates on a simulator.
Useful for profiling location-dependent features.`,
    {
      latitude: z.number().describe("Latitude (e.g., 37.7749 for San Francisco)"),
      longitude: z.number().describe("Longitude (e.g., -122.4194 for San Francisco)"),
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
    },
    async ({ latitude, longitude, device }) => {
      try {
        const sim = await resolveDevice(device);
        await simctlSetLocation(sim.udid, latitude, longitude);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ location: { latitude, longitude }, device: sim.name }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to set location: ${e}` }], isError: true };
      }
    }
  );

  // ── Start/Stop Profiling (user-controlled) ───────────────────────
  server.tool(
    "start_profiling",
    `Start recording an Instruments trace and return immediately.
The user interacts with the app manually while recording runs in the background.
Call stop_profiling when done to end the recording and get parsed results.

This is the recommended workflow for profiling real user interactions:
1. start_profiling → agent starts recording
2. User scrolls, taps, navigates in the app
3. stop_profiling → agent stops recording, parses trace, returns performance data

Max recording time is 5 minutes (safety limit). Recording stops automatically if not stopped manually.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch and profile"),
      device: z.string().optional().describe("Device name, UDID, or 'booted' for simulator"),
      template: z
        .string()
        .optional()
        .default("Time Profiler")
        .describe("Instruments template (e.g., 'Time Profiler', 'Allocations', 'Leaks')"),
      max_duration: z
        .string()
        .optional()
        .default("5m")
        .describe("Safety time limit (default: '5m'). Recording stops automatically after this."),
    },
    async ({ process, launch_path, device, template, max_duration }) => {
      try {
        if (activeRecording) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "A recording is already active",
                template: activeRecording.template,
                startedAt: new Date(activeRecording.startTime).toISOString(),
                elapsed: `${((Date.now() - activeRecording.startTime) / 1000).toFixed(0)}s`,
                hint: "Call stop_profiling first to end the current recording.",
              }, null, 2),
            }],
            isError: true,
          };
        }

        // Resolve device identifier to UDID for xctrace
        let resolvedDevice = device;
        if (device) {
          try {
            const sim = await resolveDevice(device);
            resolvedDevice = sim.udid;
          } catch {
            // If resolution fails (e.g., profiling a physical device or Mac),
            // pass the original value through to xctrace
          }
        }

        const recording = spawnXctraceRecord({
          template,
          attachProcess: process,
          launchPath: launch_path,
          device: resolvedDevice,
          timeLimit: max_duration,
        });

        activeRecording = {
          ...recording,
          device: resolvedDevice,
          attachProcess: process,
        };

        // Auto-clear activeRecording when the recording completes on its own
        // (e.g., max duration reached or xctrace exits unexpectedly)
        const recordingRef = recording;
        recording.completion.finally(() => {
          if (activeRecording && activeRecording.startTime === recordingRef.startTime) {
            activeRecording = null;
          }
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "recording",
              template,
              process: process || launch_path || "all processes",
              device: resolvedDevice || "host Mac",
              tracePath: recording.tracePath,
              maxDuration: max_duration,
              hint: "Recording started. The user should interact with the app now. Call stop_profiling when done.",
            }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to start recording: ${e}` }], isError: true };
      }
    }
  );

  server.tool(
    "stop_profiling",
    `Stop an active recording started by start_profiling.
Sends SIGINT to xctrace, waits for the trace to be saved, then parses and returns structured results.
Returns the same parsed performance data as the profile_* tools.`,
    {},
    async () => {
      try {
        if (!activeRecording) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "No active recording",
                hint: "Call start_profiling first to begin a recording session.",
              }, null, 2),
            }],
            isError: true,
          };
        }

        const recording = activeRecording;
        activeRecording = null;

        // Gracefully stop xctrace — it saves the trace on SIGINT
        recording.childProcess.kill("SIGINT");

        // Wait for xctrace to finalize and save the trace
        const { tracePath, stderr } = await recording.completion;

        const elapsed = ((Date.now() - recording.startTime) / 1000).toFixed(1);

        // Parse results based on the template used
        const results = await parseTraceByTemplate(tracePath, recording.template);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                ...results,
                tracePath,
                recordingDuration: `${elapsed}s`,
                template: recording.template,
              },
              null,
              2
            ),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to stop recording: ${e}` }], isError: true };
      }
    }
  );

  // ── Scenario Profiling (orchestration) ───────────────────────────
  server.tool(
    "profile_scenario",
    `Record an Instruments trace WHILE executing a scenario on a simulator.
This is the primary tool for profiling real user flows — it launches your app,
runs interaction steps, and records performance data throughout.

Steps execute sequentially after xctrace starts recording.
Supports both simctl steps (deep links, push, appearance, location) and
UI automation steps (tap, type_text, swipe, gesture, long_press, snapshot_ui)
powered by AXe CLI. UI steps require AXe: brew tap cameroncooke/axe && brew install axe

Returns: Parsed profile results + screenshots taken + scenario execution log.`,
    {
      bundle_id: z.string().describe("App bundle identifier to profile"),
      device: z.string().optional().default("booted").describe("Device UDID, name, or 'booted'"),
      template: z
        .string()
        .optional()
        .default("Time Profiler")
        .describe("Instruments template (e.g., 'Time Profiler', 'Allocations', 'Animation Hitches', 'Leaks')"),
      duration: z.string().default("15s").describe("Total recording duration (e.g., '10s', '30s', '1m')"),
      app_path: z
        .string()
        .optional()
        .describe("Path to .app bundle — installs on simulator before launching if provided"),
      scenario: z
        .array(scenarioStepSchema)
        .min(1)
        .describe("Ordered list of interaction steps to execute during profiling"),
    },
    async ({ bundle_id, device, template, duration, app_path, scenario }) => {
      try {
        const log: Array<{ step: string; timestamp: number; result?: string; error?: string }> = [];
        const screenshots: string[] = [];

        // 1. Resolve device
        const sim = await resolveDevice(device);
        log.push({ step: "resolve_device", timestamp: Date.now(), result: `${sim.name} (${sim.udid})` });

        // 2. Optionally install app
        if (app_path) {
          await simctlInstall(sim.udid, app_path);
          log.push({ step: "install_app", timestamp: Date.now(), result: app_path });
        }

        // 3. Determine attachment strategy
        //    If scenario has launch/terminate steps, process lifecycle changes
        //    mean we can't reliably attach to a single PID. Use --all-processes.
        //    Otherwise, pre-launch to get a stable PID for cleaner traces.
        const hasLifecycleStep = scenario.some((s) => s.action === "launch" || s.action === "terminate");
        let attachProcess: string | undefined;

        if (!hasLifecycleStep) {
          const { pid } = await simctlLaunch(sim.udid, bundle_id, { terminateExisting: true });
          attachProcess = pid;
          log.push({ step: "pre_launch", timestamp: Date.now(), result: `PID ${pid}` });
        }

        // 4. Start xctrace recording (runs async for `duration`)
        const recordPromise = xctraceRecord({
          template,
          attachProcess,
          device: sim.udid,
          timeLimit: duration,
          allProcesses: hasLifecycleStep,
        });
        log.push({
          step: "start_recording",
          timestamp: Date.now(),
          result: `template=${template}, duration=${duration}, attach=${attachProcess || "all-processes"}`,
        });

        // 5. Wait for xctrace to initialize before running scenario
        await sleep(2000);

        // 6. Execute scenario steps sequentially
        const { mkdirSync } = await import("node:fs");
        mkdirSync(getTraceOutputDir(), { recursive: true });

        for (const step of scenario) {
          const stepStart = Date.now();
          try {
            switch (step.action) {
              case "launch": {
                const terminate = step.terminate_existing !== false;
                const { pid } = await simctlLaunch(sim.udid, bundle_id, { terminateExisting: terminate });
                log.push({ step: "launch", timestamp: stepStart, result: `PID ${pid}` });
                break;
              }
              case "terminate":
                await simctlTerminate(sim.udid, bundle_id);
                log.push({ step: "terminate", timestamp: stepStart });
                break;
              case "wait":
                await sleep(step.seconds * 1000);
                log.push({ step: `wait(${step.seconds}s)`, timestamp: stepStart });
                break;
              case "open_url":
                await simctlOpenUrl(sim.udid, step.url);
                log.push({ step: "open_url", timestamp: stepStart, result: step.url });
                break;
              case "push": {
                const payload = step.payload
                  ? (JSON.parse(step.payload) as Record<string, unknown>)
                  : { aps: { alert: { title: step.title || "Test", body: step.body || "" } } };
                await simctlPush(sim.udid, bundle_id, payload);
                log.push({ step: "push", timestamp: stepStart, result: JSON.stringify(payload).slice(0, 100) });
                break;
              }
              case "screenshot": {
                const screenshotLabel = step.label || `step-${log.length}`;
                const path = join(getTraceOutputDir(), `screenshot-${screenshotLabel}-${Date.now()}.png`);
                await simctlScreenshot(sim.udid, path);
                screenshots.push(path);
                log.push({ step: `screenshot(${screenshotLabel})`, timestamp: stepStart, result: path });
                break;
              }
              case "set_appearance":
                await simctlSetAppearance(sim.udid, step.mode);
                log.push({ step: `set_appearance(${step.mode})`, timestamp: stepStart });
                break;
              case "set_location":
                await simctlSetLocation(sim.udid, step.latitude, step.longitude);
                log.push({ step: `set_location(${step.latitude},${step.longitude})`, timestamp: stepStart });
                break;
              // UI automation steps (lazy-load AXe)
              case "tap": {
                const axe = await import("../utils/axe.js");
                await axe.axeTap(sim.udid, { id: step.id, label: step.label, x: step.x, y: step.y });
                const target = step.id ? `id="${step.id}"` : step.label ? `label="${step.label}"` : `(${step.x},${step.y})`;
                log.push({ step: `tap(${target})`, timestamp: stepStart });
                break;
              }
              case "type_text": {
                const axe = await import("../utils/axe.js");
                await axe.axeType(sim.udid, step.text);
                log.push({ step: `type_text("${step.text.slice(0, 50)}")`, timestamp: stepStart });
                break;
              }
              case "swipe": {
                const axe = await import("../utils/axe.js");
                await axe.axeSwipe(sim.udid, {
                  startX: step.start_x, startY: step.start_y,
                  endX: step.end_x, endY: step.end_y,
                  duration: step.duration,
                });
                log.push({ step: `swipe(${step.start_x},${step.start_y}→${step.end_x},${step.end_y})`, timestamp: stepStart });
                break;
              }
              case "gesture": {
                const axe = await import("../utils/axe.js");
                await axe.axeGesture(sim.udid, step.preset as import("../utils/axe.js").AxeGesturePreset);
                log.push({ step: `gesture(${step.preset})`, timestamp: stepStart });
                break;
              }
              case "snapshot_ui": {
                const axe = await import("../utils/axe.js");
                const { parseAndCompact } = await import("./ui.js");
                const snapshot = await axe.axeDescribeUI(sim.udid);
                const compacted = parseAndCompact(snapshot);
                const snapshotLabel = step.label || `step-${log.length}`;
                const summary = typeof compacted === "string"
                  ? compacted.slice(0, 300)
                  : `${compacted.totalElements} elements${compacted.truncated ? " (truncated)" : ""}`;
                log.push({ step: `snapshot_ui(${snapshotLabel})`, timestamp: stepStart, result: summary });
                break;
              }
              case "long_press": {
                const axe = await import("../utils/axe.js");
                const durationSec = (step.duration_ms ?? 1000) / 1000;
                await axe.axeTouch(sim.udid, { x: step.x, y: step.y, durationSeconds: durationSec });
                log.push({ step: `long_press(${step.x},${step.y},${step.duration_ms ?? 1000}ms)`, timestamp: stepStart });
                break;
              }
            }
          } catch (e) {
            log.push({ step: step.action, timestamp: stepStart, error: String(e) });
          }
        }

        // 7. Wait for recording to complete
        const { tracePath } = await recordPromise;
        log.push({ step: "recording_complete", timestamp: Date.now(), result: tracePath });

        // 8. Parse results based on template
        const results = await parseTraceByTemplate(tracePath, template);

        // 9. Format as compact text (not raw JSON)
        const profileText = formatProfileResult(template, results as unknown as Record<string, unknown>, "scenario", tracePath);

        // Build compact scenario log with relative timestamps
        const scenarioStart = log[0]?.timestamp ?? Date.now();
        const logLines = log.map((entry) => {
          const relMs = entry.timestamp - scenarioStart;
          const rel = relMs < 1000 ? `${relMs}ms` : `${(relMs / 1000).toFixed(1)}s`;
          const parts = [`+${rel} ${entry.step}`];
          if (entry.result) parts.push(entry.result);
          if (entry.error) parts.push(`ERROR: ${entry.error}`);
          return parts.join("  ");
        });

        const scenarioText = [
          `--- Scenario ---  device: ${sim.name}  steps: ${scenario.length}${screenshots.length ? `  screenshots: ${screenshots.length}` : ""}`,
          ...logLines,
        ].join("\n");

        return {
          content: [{
            type: "text" as const,
            text: `${profileText}\n\n${scenarioText}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Scenario profiling failed: ${e}` }], isError: true };
      }
    }
  );
}

