import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { xctraceRecord, xctraceExport, getTraceOutputDir } from "../utils/xctrace.js";
import { findTableXpath, findTrackXpath, extractTableSchemas } from "../utils/trace-helpers.js";
import { storeTrace, getTrace, getOrBuildCallTree } from "../utils/trace-store.js";
import { formatProfileResult } from "../utils/format-output.js";
import { autoInvestigate } from "../utils/auto-investigate.js";
import { parseTimeProfiler } from "../parsers/time-profiler.js";
import { parseSwiftUI } from "../parsers/swiftui.js";
import { parseAllocations } from "../parsers/allocations.js";
import { parseHangs } from "../parsers/hangs.js";
import { parseAppLaunch } from "../parsers/app-launch.js";
import { parseEnergy } from "../parsers/energy.js";
import { parseLeaks } from "../parsers/leaks.js";
import { parseNetwork } from "../parsers/network.js";

/**
 * Resolve a trace path: use existing trace_path if provided, otherwise record a new trace.
 */
async function resolveTrace(
  template: string,
  opts: { trace_path?: string; process?: string; launch_path?: string; device?: string; duration: string }
): Promise<string> {
  if (opts.trace_path) return opts.trace_path;
  const { tracePath } = await xctraceRecord({
    template,
    attachProcess: opts.process,
    launchPath: opts.launch_path,
    device: opts.device,
    timeLimit: opts.duration,
  });
  return tracePath;
}

/**
 * Format a profile result with auto-investigation and return MCP tool output.
 */
function formatAndReturn(
  template: string,
  result: Record<string, unknown>,
  traceId: string,
  tracePath: string,
) {
  // Build call tree for CPU traces to feed auto-investigate
  const trace = getTrace(traceId);
  const callTree = trace ? getOrBuildCallTree(trace) : null;

  const investigation = autoInvestigate(template, result, callTree, traceId);
  if (trace) trace.investigation = investigation;

  const formatted = formatProfileResult(template, result, traceId, tracePath);
  const text = investigation ? `${formatted}\n\n${investigation}` : formatted;
  return { content: [{ type: "text" as const, text }] };
}

/** Common trace_path parameter for re-analysis of existing traces */
const tracePathParam = z.string().optional().describe("Path to existing .trace file to re-analyze (skips recording)");

export function registerProfileTools(server: McpServer): void {
  // ── CPU Profiling ──────────────────────────────────────────────
  server.tool(
    "profile_cpu",
    `Record and analyze CPU performance using Time Profiler.
Returns: Top CPU hotspots with severity classification and actionable summary.
Pass trace_path to re-analyze an existing trace without re-recording.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch and profile"),
      device: z.string().optional().describe("Device name or UDID (omit for host Mac)"),
      duration: z.string().default("15s").describe("Recording duration (e.g., '10s', '30s', '1m')"),
      trace_path: tracePathParam,
    },
    async ({ process, launch_path, device, duration, trace_path }) => {
      try {
        const tracePath = await resolveTrace("Time Profiler", { trace_path, process, launch_path, device, duration });
        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });

        const profileXpath = findTableXpath(tocXml, "time-profile");
        let tableXml: string | undefined;
        if (profileXpath) {
          tableXml = await xctraceExport({ inputPath: tracePath, xpath: profileXpath });
        }

        let usedXml = tableXml || tocXml;
        let result = parseTimeProfiler(tocXml, usedXml);
        // Deferred mode (xctrace 26+) often leaves time-profile nearly empty;
        // fall back to time-sample if we got suspiciously few samples
        if (result.totalSamples < 10) {
          const sampleXpath = findTableXpath(tocXml, "time-sample");
          if (sampleXpath) {
            const sampleXml = await xctraceExport({ inputPath: tracePath, xpath: sampleXpath });
            const sampleResult = parseTimeProfiler(tocXml, sampleXml);
            if (sampleResult.totalSamples > result.totalSamples) {
              result = sampleResult;
              usedXml = sampleXml;
            }
          }
        }

        const traceId = storeTrace({ tracePath, template: "Time Profiler", tableXml: usedXml, parsedResult: result as unknown as Record<string, unknown> });
        return formatAndReturn("Time Profiler", result as unknown as Record<string, unknown>, traceId, tracePath);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Profiling failed: ${e}` }], isError: true };
      }
    }
  );

  // ── SwiftUI Profiling ──────────────────────────────────────────
  server.tool(
    "profile_swiftui",
    `Record and analyze SwiftUI view performance.
Returns: View body evaluation counts, excessive re-renders, and duration per view.
Best used while navigating through the app. Pass trace_path to re-analyze an existing trace.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z.string().default("15s").describe("Recording duration"),
      trace_path: tracePathParam,
    },
    async ({ process, launch_path, device, duration, trace_path }) => {
      try {
        const tracePath = await resolveTrace("SwiftUI", { trace_path, process, launch_path, device, duration });
        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });
        const tableXpath = findTableXpath(tocXml, "view-body") || findTableXpath(tocXml, "swiftui");
        const tableXml = tableXpath ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath }) : tocXml;

        const result = parseSwiftUI(tocXml, tableXml);
        const traceId = storeTrace({ tracePath, template: "SwiftUI", tableXml, parsedResult: result as unknown as Record<string, unknown> });
        return formatAndReturn("SwiftUI", result as unknown as Record<string, unknown>, traceId, tracePath);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `SwiftUI profiling failed: ${e}` }], isError: true };
      }
    }
  );

  // ── Memory Profiling ───────────────────────────────────────────
  server.tool(
    "profile_memory",
    `Record and analyze memory allocations.
Returns: Allocation counts by category, total memory, largest allocators.
Pass trace_path to re-analyze an existing trace.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z.string().default("15s").describe("Recording duration"),
      trace_path: tracePathParam,
    },
    async ({ process, launch_path, device, duration, trace_path }) => {
      try {
        const tracePath = await resolveTrace("Allocations", { trace_path, process, launch_path, device, duration });
        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });
        const tableXpath = findTableXpath(tocXml, "alloc");
        const tableXml = tableXpath ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath }) : tocXml;

        const result = parseAllocations(tocXml, tableXml);
        const traceId = storeTrace({ tracePath, template: "Allocations", tableXml, parsedResult: result as unknown as Record<string, unknown> });
        return formatAndReturn("Allocations", result as unknown as Record<string, unknown>, traceId, tracePath);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Memory profiling failed: ${e}` }], isError: true };
      }
    }
  );

  // ── Hitch / Hang Detection ─────────────────────────────────────
  server.tool(
    "profile_hitches",
    `Record and analyze animation hitches and main thread hangs.
Returns: Hang events by severity, worst hangs with backtraces.
Best used during scrolling or animations. Pass trace_path to re-analyze an existing trace.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z.string().default("15s").describe("Recording duration"),
      trace_path: tracePathParam,
    },
    async ({ process, launch_path, device, duration, trace_path }) => {
      try {
        const tracePath = await resolveTrace("Animation Hitches", { trace_path, process, launch_path, device, duration });
        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });
        const tableXpath = findTableXpath(tocXml, "hang") || findTableXpath(tocXml, "hitch");
        const tableXml = tableXpath ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath }) : tocXml;

        const result = parseHangs(tocXml, tableXml);
        const traceId = storeTrace({ tracePath, template: "Animation Hitches", tableXml, parsedResult: result as unknown as Record<string, unknown> });
        return formatAndReturn("Animation Hitches", result as unknown as Record<string, unknown>, traceId, tracePath);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Hitch profiling failed: ${e}` }], isError: true };
      }
    }
  );

  // ── App Launch Profiling ──────────────────────────────────────
  server.tool(
    "profile_launch",
    `Record and analyze app launch performance.
Returns: Total launch time, launch type (cold/warm/resume), phase breakdown, severity against Apple's guidelines.
IMPORTANT: Use launch_path to launch the app — attaching to a running process won't capture the launch.
Pass trace_path to re-analyze an existing trace.`,
    {
      launch_path: z.string().optional().describe("Path to .app bundle to launch and profile (required unless using trace_path)"),
      device: z.string().optional().describe("Device name or UDID (omit for host Mac)"),
      duration: z.string().default("30s").describe("Recording duration"),
      trace_path: tracePathParam,
    },
    async ({ launch_path, device, duration, trace_path }) => {
      try {
        const tracePath = await resolveTrace("App Launch", { trace_path, launch_path, device, duration });
        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });

        const tableXpath =
          findTableXpath(tocXml, "app-launch") ||
          findTableXpath(tocXml, "lifecycle") ||
          findTableXpath(tocXml, "os-signpost") ||
          findTableXpath(tocXml, "signpost");
        const tableXml = tableXpath ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath }) : tocXml;

        const result = parseAppLaunch(tocXml, tableXml);
        const traceId = storeTrace({ tracePath, template: "App Launch", tableXml, parsedResult: result as unknown as Record<string, unknown> });
        return formatAndReturn("App Launch", result as unknown as Record<string, unknown>, traceId, tracePath);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `App launch profiling failed: ${e}` }], isError: true };
      }
    }
  );

  // ── Energy Profiling ──────────────────────────────────────────
  server.tool(
    "profile_energy",
    `Record and analyze energy usage using Energy Log.
Returns: Energy impact scores (0–20 scale), per-component breakdown (CPU, GPU, network, display), thermal state.
Best results on physical devices. Pass trace_path to re-analyze an existing trace.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID (physical device recommended)"),
      duration: z.string().default("30s").describe("Recording duration"),
      trace_path: tracePathParam,
    },
    async ({ process, launch_path, device, duration, trace_path }) => {
      try {
        const tracePath = await resolveTrace("Energy Log", { trace_path, process, launch_path, device, duration });
        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });

        const tableXpath =
          findTableXpath(tocXml, "energy") ||
          findTableXpath(tocXml, "power") ||
          findTableXpath(tocXml, "battery") ||
          findTableXpath(tocXml, "diagnostics");
        const tableXml = tableXpath ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath }) : tocXml;

        const result = parseEnergy(tocXml, tableXml);
        const traceId = storeTrace({ tracePath, template: "Energy Log", tableXml, parsedResult: result as unknown as Record<string, unknown> });
        return formatAndReturn("Energy Log", result as unknown as Record<string, unknown>, traceId, tracePath);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Energy profiling failed: ${e}` }], isError: true };
      }
    }
  );

  // ── Leaks Detection ─────────────────────────────────────────────
  server.tool(
    "profile_leaks",
    `Record and detect memory leaks using the Leaks template.
Returns: Leaked object types, sizes, responsible libraries, and backtraces.
The Leaks instrument takes periodic heap snapshots — longer recordings improve detection.
Pass trace_path to re-analyze an existing trace.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z.string().default("30s").describe("Recording duration — 30s+ recommended"),
      trace_path: tracePathParam,
    },
    async ({ process, launch_path, device, duration, trace_path }) => {
      try {
        const tracePath = await resolveTrace("Leaks", { trace_path, process, launch_path, device, duration });
        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });

        const tableXpath =
          findTableXpath(tocXml, "leak") ||
          findTrackXpath(tocXml, "leak") ||
          findTableXpath(tocXml, "alloc");
        const tableXml = tableXpath ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath }) : tocXml;

        const result = parseLeaks(tocXml, tableXml);
        const traceId = storeTrace({ tracePath, template: "Leaks", tableXml, parsedResult: result as unknown as Record<string, unknown> });
        return formatAndReturn("Leaks", result as unknown as Record<string, unknown>, traceId, tracePath);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Leak detection failed: ${e}` }], isError: true };
      }
    }
  );

  // ── Network Profiling ────────────────────────────────────────────
  server.tool(
    "profile_network",
    `Record and analyze HTTP network traffic using the Network template.
Returns: Request counts, response times, error rates, per-domain breakdown, slowest requests.
Pass trace_path to re-analyze an existing trace.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z.string().default("30s").describe("Recording duration"),
      trace_path: tracePathParam,
    },
    async ({ process, launch_path, device, duration, trace_path }) => {
      try {
        const tracePath = await resolveTrace("Network", { trace_path, process, launch_path, device, duration });
        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });

        const tableXpath =
          findTableXpath(tocXml, "http") ||
          findTableXpath(tocXml, "network") ||
          findTrackXpath(tocXml, "http") ||
          findTrackXpath(tocXml, "network");
        const tableXml = tableXpath ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath }) : tocXml;

        const result = parseNetwork(tocXml, tableXml);
        const traceId = storeTrace({ tracePath, template: "Network", tableXml, parsedResult: result as unknown as Record<string, unknown> });
        return formatAndReturn("Network", result as unknown as Record<string, unknown>, traceId, tracePath);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Network profiling failed: ${e}` }], isError: true };
      }
    }
  );

  // ── Raw Recording (any template) ───────────────────────────────
  server.tool(
    "profile_raw",
    `Record a trace with any Instruments template and return the raw table of contents.
Use this for templates without a dedicated parser (System Trace, File Activity, etc.).
You can then use analyze_trace to export specific tables.`,
    {
      template: z.string().describe("Instruments template name (e.g., 'System Trace', 'File Activity')"),
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z.string().default("15s").describe("Recording duration"),
    },
    async ({ template, process, launch_path, device, duration }) => {
      try {
        const { tracePath } = await xctraceRecord({
          template,
          attachProcess: process,
          launchPath: launch_path,
          device,
          timeLimit: duration,
        });

        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });
        const schemas = extractTableSchemas(tocXml);
        const traceId = storeTrace({ tracePath, template, tableXml: tocXml });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  template,
                  tracePath,
                  traceId,
                  availableSchemas: schemas,
                  hint: "Use analyze_trace with tracePath and an xpath to export specific tables, or drill_down with traceId to search the data.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Recording failed: ${e}` }], isError: true };
      }
    }
  );
}

