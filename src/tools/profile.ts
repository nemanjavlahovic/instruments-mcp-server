import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { xctraceRecord, xctraceExport, getTraceOutputDir } from "../utils/xctrace.js";
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

/** Common trace_path parameter for re-analysis of existing traces */
const tracePathParam = z.string().optional().describe("Path to existing .trace file to re-analyze (skips recording)");

export function registerProfileTools(server: McpServer): void {
  // ── CPU Profiling ──────────────────────────────────────────────
  server.tool(
    "profile_cpu",
    `Record and analyze CPU performance using Time Profiler.
Returns: Top CPU hotspots, main thread blockers, and actionable summary.
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

        let result = parseTimeProfiler(tocXml, tableXml || tocXml);
        if (result.totalSamples === 0) {
          const sampleXpath = findTableXpath(tocXml, "time-sample");
          if (sampleXpath) {
            const sampleXml = await xctraceExport({ inputPath: tracePath, xpath: sampleXpath });
            result = parseTimeProfiler(tocXml, sampleXml);
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, tracePath }, null, 2) }],
        };
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, tracePath }, null, 2) }],
        };
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, tracePath }, null, 2) }],
        };
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, tracePath }, null, 2) }],
        };
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, tracePath }, null, 2) }],
        };
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, tracePath }, null, 2) }],
        };
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, tracePath }, null, 2) }],
        };
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, tracePath }, null, 2) }],
        };
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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  template,
                  tracePath,
                  toc: tocXml,
                  hint: "Use analyze_trace with the tracePath and an xpath from the TOC to drill into specific tables.",
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

/**
 * Search the TOC XML for a table matching a schema keyword and return its xpath.
 */
function findTableXpath(tocXml: string, schemaKeyword: string): string | null {
  const schemaPattern = new RegExp(`schema="([^"]*${schemaKeyword}[^"]*)"`, "i");
  const match = tocXml.match(schemaPattern);
  if (!match) return null;

  const schema = match[1];
  const runMatch = tocXml.match(/run\[@number="(\d+)"\]/);
  const runNumber = runMatch ? runMatch[1] : "1";

  return `/trace-toc/run[@number="${runNumber}"]/data/table[@schema="${schema}"]`;
}

/**
 * Search the TOC XML for a track detail matching a schema keyword (e.g., Leaks uses tracks).
 */
function findTrackXpath(tocXml: string, schemaKeyword: string): string | null {
  const detailPattern = new RegExp(`<detail[^>]*schema="([^"]*${schemaKeyword}[^"]*)"`, "i");
  const match = tocXml.match(detailPattern);
  if (!match) return null;

  const schema = match[1];
  const runMatch = tocXml.match(/run\[@number="(\d+)"\]/);
  const runNumber = runMatch ? runMatch[1] : "1";

  return `/trace-toc/run[@number="${runNumber}"]/tracks/track/details/detail[@schema="${schema}"]`;
}
