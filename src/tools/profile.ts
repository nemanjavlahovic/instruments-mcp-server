import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { xctraceRecord, xctraceExport, getTraceOutputDir } from "../utils/xctrace.js";
import { parseTimeProfiler } from "../parsers/time-profiler.js";
import { parseSwiftUI } from "../parsers/swiftui.js";
import { parseAllocations } from "../parsers/allocations.js";
import { parseHangs } from "../parsers/hangs.js";
import { parseAppLaunch } from "../parsers/app-launch.js";

export function registerProfileTools(server: McpServer): void {
  // ── CPU Profiling ──────────────────────────────────────────────
  server.tool(
    "profile_cpu",
    `Record and analyze CPU performance using Time Profiler.
Returns: Top CPU hotspots, main thread blockers, and actionable summary.
Requires a running app or a path to launch.`,
    {
      process: z
        .string()
        .optional()
        .describe("Process name or PID to attach to (e.g., 'rmoir-ios' or '12345')"),
      launch_path: z
        .string()
        .optional()
        .describe("Path to .app bundle to launch and profile"),
      device: z
        .string()
        .optional()
        .describe("Device name or UDID (omit for host Mac)"),
      duration: z
        .string()
        .default("15s")
        .describe("Recording duration (e.g., '10s', '30s', '1m')"),
    },
    async ({ process, launch_path, device, duration }) => {
      try {
        const { tracePath } = await xctraceRecord({
          template: "Time Profiler",
          attachProcess: process,
          launchPath: launch_path,
          device,
          timeLimit: duration,
        });

        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });

        // Try time-profile first (aggregated data with function names)
        const profileXpath = findTableXpath(tocXml, "time-profile");
        let tableXml: string | undefined;
        if (profileXpath) {
          tableXml = await xctraceExport({ inputPath: tracePath, xpath: profileXpath });
        }

        // If time-profile table was empty, fall back to time-sample (xctrace 26+ Deferred mode)
        let result = parseTimeProfiler(tocXml, tableXml || tocXml);
        if (result.totalSamples === 0) {
          const sampleXpath = findTableXpath(tocXml, "time-sample");
          if (sampleXpath) {
            const sampleXml = await xctraceExport({ inputPath: tracePath, xpath: sampleXpath });
            result = parseTimeProfiler(tocXml, sampleXml);
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, tracePath }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Profiling failed: ${e}` }],
          isError: true,
        };
      }
    }
  );

  // ── SwiftUI Profiling ──────────────────────────────────────────
  server.tool(
    "profile_swiftui",
    `Record and analyze SwiftUI view performance.
Returns: View body evaluation counts, excessive re-renders, and duration per view.
Best used while navigating through the app.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z.string().default("15s").describe("Recording duration"),
    },
    async ({ process, launch_path, device, duration }) => {
      try {
        const { tracePath } = await xctraceRecord({
          template: "SwiftUI",
          attachProcess: process,
          launchPath: launch_path,
          device,
          timeLimit: duration,
        });

        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });
        const tableXpath = findTableXpath(tocXml, "view-body") || findTableXpath(tocXml, "swiftui");
        const tableXml = tableXpath
          ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath })
          : tocXml;

        const result = parseSwiftUI(tocXml, tableXml);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, tracePath }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `SwiftUI profiling failed: ${e}` }],
          isError: true,
        };
      }
    }
  );

  // ── Memory Profiling ───────────────────────────────────────────
  server.tool(
    "profile_memory",
    `Record and analyze memory allocations.
Returns: Allocation counts by category, total memory, largest allocators.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z.string().default("15s").describe("Recording duration"),
    },
    async ({ process, launch_path, device, duration }) => {
      try {
        const { tracePath } = await xctraceRecord({
          template: "Allocations",
          attachProcess: process,
          launchPath: launch_path,
          device,
          timeLimit: duration,
        });

        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });
        const tableXpath = findTableXpath(tocXml, "alloc");
        const tableXml = tableXpath
          ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath })
          : tocXml;

        const result = parseAllocations(tocXml, tableXml);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, tracePath }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Memory profiling failed: ${e}` }],
          isError: true,
        };
      }
    }
  );

  // ── Hitch / Hang Detection ─────────────────────────────────────
  server.tool(
    "profile_hitches",
    `Record and analyze animation hitches and main thread hangs.
Returns: Hang events by severity, worst hangs with backtraces.
Best used during scrolling or animations.`,
    {
      process: z.string().optional().describe("Process name or PID to attach to"),
      launch_path: z.string().optional().describe("Path to .app bundle to launch"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z.string().default("15s").describe("Recording duration"),
    },
    async ({ process, launch_path, device, duration }) => {
      try {
        const { tracePath } = await xctraceRecord({
          template: "Animation Hitches",
          attachProcess: process,
          launchPath: launch_path,
          device,
          timeLimit: duration,
        });

        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });
        const tableXpath = findTableXpath(tocXml, "hang") || findTableXpath(tocXml, "hitch");
        const tableXml = tableXpath
          ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath })
          : tocXml;

        const result = parseHangs(tocXml, tableXml);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, tracePath }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Hitch profiling failed: ${e}` }],
          isError: true,
        };
      }
    }
  );

  // ── App Launch Profiling ──────────────────────────────────────
  server.tool(
    "profile_launch",
    `Record and analyze app launch performance.
Returns: Total launch time, launch type (cold/warm/resume), phase breakdown, severity against Apple's guidelines.
IMPORTANT: Use launch_path to launch the app — attaching to a running process won't capture the launch.`,
    {
      launch_path: z
        .string()
        .describe("Path to .app bundle to launch and profile (required for launch profiling)"),
      device: z
        .string()
        .optional()
        .describe("Device name or UDID (omit for host Mac)"),
      duration: z
        .string()
        .default("30s")
        .describe("Recording duration — should be long enough for the app to finish launching (default 30s)"),
    },
    async ({ launch_path, device, duration }) => {
      try {
        const { tracePath } = await xctraceRecord({
          template: "App Launch",
          launchPath: launch_path,
          device,
          timeLimit: duration,
        });

        const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });

        // App Launch data may be in various tables: lifecycle, os-signpost, app-launch
        const tableXpath =
          findTableXpath(tocXml, "app-launch") ||
          findTableXpath(tocXml, "lifecycle") ||
          findTableXpath(tocXml, "os-signpost") ||
          findTableXpath(tocXml, "signpost");
        const tableXml = tableXpath
          ? await xctraceExport({ inputPath: tracePath, xpath: tableXpath })
          : tocXml;

        const result = parseAppLaunch(tocXml, tableXml);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, tracePath }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `App launch profiling failed: ${e}` }],
          isError: true,
        };
      }
    }
  );

  // ── Raw Recording (any template) ───────────────────────────────
  server.tool(
    "profile_raw",
    `Record a trace with any Instruments template and return the raw table of contents.
Use this for templates without a dedicated parser (Network, App Launch, Leaks, etc.).
You can then use analyze_trace to export specific tables.`,
    {
      template: z.string().describe("Instruments template name (e.g., 'Network', 'App Launch', 'Leaks')"),
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
        return {
          content: [{ type: "text" as const, text: `Recording failed: ${e}` }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Search the TOC XML for a table matching a schema keyword and return its xpath.
 */
function findTableXpath(tocXml: string, schemaKeyword: string): string | null {
  // Simple regex search for schema names containing the keyword
  const schemaPattern = new RegExp(`schema="([^"]*${schemaKeyword}[^"]*)"`, "i");
  const match = tocXml.match(schemaPattern);
  if (!match) return null;

  const schema = match[1];

  // Find which run this belongs to (default to run 1)
  const runMatch = tocXml.match(/run\[@number="(\d+)"\]/);
  const runNumber = runMatch ? runMatch[1] : "1";

  return `/trace-toc/run[@number="${runNumber}"]/data/table[@schema="${schema}"]`;
}
