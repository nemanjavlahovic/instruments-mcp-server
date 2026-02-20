import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { xctraceExport, xctraceSymbolicate, xctraceRecord } from "../utils/xctrace.js";
import { parseXml } from "../utils/xml.js";

export function registerAnalyzeTools(server: McpServer): void {
  // ── Analyze existing trace ─────────────────────────────────────
  server.tool(
    "analyze_trace",
    `Export and analyze a specific table from an existing .trace file.
Use after profile_raw to drill into specific data tables.
First call with toc=true to see available tables, then call with xpath to get data.`,
    {
      trace_path: z.string().describe("Path to the .trace file"),
      xpath: z
        .string()
        .optional()
        .describe("XPath to export specific table (from TOC output)"),
      toc: z
        .boolean()
        .optional()
        .default(false)
        .describe("Set to true to export the table of contents instead of a specific table"),
      summarize: z
        .boolean()
        .optional()
        .default(true)
        .describe("Parse XML into a structured summary (default true). Set false for raw XML."),
    },
    async ({ trace_path, xpath, toc, summarize }) => {
      try {
        const xml = await xctraceExport({
          inputPath: trace_path,
          xpath: toc ? undefined : xpath,
          toc,
        });

        if (!summarize || toc) {
          return {
            content: [{ type: "text" as const, text: xml }],
          };
        }

        // Parse XML into structured data for easier agent consumption
        const parsed = parseXml(xml);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(parsed, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Analysis failed: ${e}` }],
          isError: true,
        };
      }
    }
  );

  // ── Symbolicate trace ──────────────────────────────────────────
  server.tool(
    "symbolicate_trace",
    `Add debug symbols to a trace file so function names are readable instead of memory addresses.
Run this if profile results show hex addresses instead of function names.`,
    {
      trace_path: z.string().describe("Path to the .trace file"),
      dsym_path: z
        .string()
        .optional()
        .describe("Path to .dSYM bundle. If omitted, searches system paths automatically."),
    },
    async ({ trace_path, dsym_path }) => {
      try {
        const output = await xctraceSymbolicate(trace_path, dsym_path);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                tracePath: trace_path,
                output: output || "Symbolication complete.",
              }, null, 2),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Symbolication failed: ${e}` }],
          isError: true,
        };
      }
    }
  );

  // ── Full performance audit ─────────────────────────────────────
  server.tool(
    "performance_audit",
    `Run a comprehensive performance audit by recording multiple profiles in sequence.
Records: Time Profiler + Animation Hitches for a quick health check.
Returns a combined report with actionable findings.`,
    {
      process: z.string().describe("Process name or PID to attach to (must be running)"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z
        .string()
        .default("10s")
        .describe("Duration per profile (e.g., '10s'). Total time = 2x this value."),
    },
    async ({ process, device, duration }) => {
      const results: Record<string, unknown> = {};

      // Run Time Profiler
      try {
        const { tracePath: cpuTrace } = await xctraceRecord({
          template: "Time Profiler",
          attachProcess: process,
          device,
          timeLimit: duration,
        });
        const tocXml = await xctraceExport({ inputPath: cpuTrace, toc: true });
        const tableXpath = findSchema(tocXml, "time-profile");
        const tableXml = tableXpath
          ? await xctraceExport({ inputPath: cpuTrace, xpath: tableXpath })
          : tocXml;

        const { parseTimeProfiler } = await import("../parsers/time-profiler.js");
        results.cpu = parseTimeProfiler(tocXml, tableXml);
      } catch (e) {
        results.cpu = { error: String(e) };
      }

      // Run Animation Hitches
      try {
        const { tracePath: hitchTrace } = await xctraceRecord({
          template: "Animation Hitches",
          attachProcess: process,
          device,
          timeLimit: duration,
        });
        const tocXml = await xctraceExport({ inputPath: hitchTrace, toc: true });
        const tableXpath = findSchema(tocXml, "hang") || findSchema(tocXml, "hitch");
        const tableXml = tableXpath
          ? await xctraceExport({ inputPath: hitchTrace, xpath: tableXpath })
          : tocXml;

        const { parseHangs } = await import("../parsers/hangs.js");
        results.hitches = parseHangs(tocXml, tableXml);
      } catch (e) {
        results.hitches = { error: String(e) };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                audit: "performance",
                process,
                durationPerProfile: duration,
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

function findSchema(tocXml: string, keyword: string): string | null {
  const match = tocXml.match(new RegExp(`schema="([^"]*${keyword}[^"]*)"`, "i"));
  if (!match) return null;
  const schema = match[1];
  return `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`;
}
