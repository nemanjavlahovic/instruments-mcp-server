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
Records: Time Profiler + Animation Hitches + Leaks + Energy Log + Network for a full health check.
Returns a combined report with actionable findings and an overall severity.
Total recording time = 5x duration.`,
    {
      process: z.string().describe("Process name or PID to attach to (must be running)"),
      device: z.string().optional().describe("Device name or UDID"),
      duration: z
        .string()
        .default("10s")
        .describe("Duration per profile (e.g., '10s'). Total time = 5x this value."),
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
        const { parseTimeProfiler } = await import("../parsers/time-profiler.js");

        // Try time-profile first, fall back to time-sample
        const profileXpath = findSchema(tocXml, "time-profile");
        const tableXml = profileXpath
          ? await xctraceExport({ inputPath: cpuTrace, xpath: profileXpath })
          : tocXml;

        let cpuResult = parseTimeProfiler(tocXml, tableXml);
        if (cpuResult.totalSamples === 0) {
          const sampleXpath = findSchema(tocXml, "time-sample");
          if (sampleXpath) {
            const sampleXml = await xctraceExport({ inputPath: cpuTrace, xpath: sampleXpath });
            cpuResult = parseTimeProfiler(tocXml, sampleXml);
          }
        }
        results.cpu = cpuResult;
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

      // Run Leaks
      try {
        const { tracePath: leaksTrace } = await xctraceRecord({
          template: "Leaks",
          attachProcess: process,
          device,
          timeLimit: duration,
        });
        const tocXml = await xctraceExport({ inputPath: leaksTrace, toc: true });
        const tableXpath =
          findSchema(tocXml, "leak") ||
          findTrackXpath(tocXml, "leak") ||
          findSchema(tocXml, "alloc");
        const tableXml = tableXpath
          ? await xctraceExport({ inputPath: leaksTrace, xpath: tableXpath })
          : tocXml;

        const { parseLeaks } = await import("../parsers/leaks.js");
        results.leaks = parseLeaks(tocXml, tableXml);
      } catch (e) {
        results.leaks = { error: String(e) };
      }

      // Run Energy Log
      try {
        const { tracePath: energyTrace } = await xctraceRecord({
          template: "Energy Log",
          attachProcess: process,
          device,
          timeLimit: duration,
        });
        const tocXml = await xctraceExport({ inputPath: energyTrace, toc: true });
        const tableXpath =
          findSchema(tocXml, "energy") ||
          findSchema(tocXml, "power") ||
          findSchema(tocXml, "battery") ||
          findSchema(tocXml, "diagnostics");
        const tableXml = tableXpath
          ? await xctraceExport({ inputPath: energyTrace, xpath: tableXpath })
          : tocXml;

        const { parseEnergy } = await import("../parsers/energy.js");
        results.energy = parseEnergy(tocXml, tableXml);
      } catch (e) {
        results.energy = { error: String(e) };
      }

      // Run Network
      try {
        const { tracePath: networkTrace } = await xctraceRecord({
          template: "Network",
          attachProcess: process,
          device,
          timeLimit: duration,
        });
        const tocXml = await xctraceExport({ inputPath: networkTrace, toc: true });
        const tableXpath =
          findSchema(tocXml, "http") ||
          findSchema(tocXml, "network") ||
          findTrackXpath(tocXml, "http") ||
          findTrackXpath(tocXml, "network");
        const tableXml = tableXpath
          ? await xctraceExport({ inputPath: networkTrace, xpath: tableXpath })
          : tocXml;

        const { parseNetwork } = await import("../parsers/network.js");
        results.network = parseNetwork(tocXml, tableXml);
      } catch (e) {
        results.network = { error: String(e) };
      }

      // Compute overall severity across all results
      const overallSeverity = computeOverallSeverity(results);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                audit: "performance",
                process,
                durationPerProfile: duration,
                overallSeverity,
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

/**
 * Search the TOC XML for a track detail matching a schema keyword.
 * Leaks and Network data may live under tracks/track/details/detail instead of data/table.
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

/**
 * Determine the worst severity across all audit results.
 * Returns "critical" if any result is critical, "warning" if any is warning, otherwise "ok".
 */
function computeOverallSeverity(
  results: Record<string, unknown>
): "ok" | "warning" | "critical" {
  const severityOrder: Record<string, number> = { ok: 0, warning: 1, critical: 2 };
  let worst = 0;

  for (const value of Object.values(results)) {
    if (value && typeof value === "object" && "severity" in value) {
      const severity = (value as { severity: string }).severity;
      const level = severityOrder[severity] ?? 0;
      if (level > worst) worst = level;
    }
  }

  if (worst >= 2) return "critical";
  if (worst >= 1) return "warning";
  return "ok";
}
