import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { xctraceExport, xctraceSymbolicate, xctraceRecord } from "../utils/xctrace.js";
import { findTableXpath as findSchema, findTrackXpath } from "../utils/trace-helpers.js";
import { parseXml } from "../utils/xml.js";
import { storeTrace, getTrace, getOrBuildCallTree } from "../utils/trace-store.js";
import { formatProfileResult } from "../utils/format-output.js";
import { autoInvestigate } from "../utils/auto-investigate.js";

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
      const traceIds: Record<string, string> = {};

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

        const profileXpath = findSchema(tocXml, "time-profile");
        let cpuTableXml = profileXpath
          ? await xctraceExport({ inputPath: cpuTrace, xpath: profileXpath })
          : tocXml;

        let cpuResult = parseTimeProfiler(tocXml, cpuTableXml);
        if (cpuResult.totalSamples < 10) {
          const sampleXpath = findSchema(tocXml, "time-sample");
          if (sampleXpath) {
            const sampleXml = await xctraceExport({ inputPath: cpuTrace, xpath: sampleXpath });
            const sampleResult = parseTimeProfiler(tocXml, sampleXml);
            if (sampleResult.totalSamples > cpuResult.totalSamples) {
              cpuResult = sampleResult;
              cpuTableXml = sampleXml;
            }
          }
        }
        results.cpu = cpuResult;
        traceIds.cpu = storeTrace({ tracePath: cpuTrace, template: "Time Profiler", tableXml: cpuTableXml, parsedResult: cpuResult as unknown as Record<string, unknown> });
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
        const hitchTableXml = tableXpath
          ? await xctraceExport({ inputPath: hitchTrace, xpath: tableXpath })
          : tocXml;

        const { parseHangs } = await import("../parsers/hangs.js");
        results.hitches = parseHangs(tocXml, hitchTableXml);
        traceIds.hitches = storeTrace({ tracePath: hitchTrace, template: "Animation Hitches", tableXml: hitchTableXml, parsedResult: results.hitches as Record<string, unknown> });
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
        const leaksTableXml = tableXpath
          ? await xctraceExport({ inputPath: leaksTrace, xpath: tableXpath })
          : tocXml;

        const { parseLeaks } = await import("../parsers/leaks.js");
        results.leaks = parseLeaks(tocXml, leaksTableXml);
        traceIds.leaks = storeTrace({ tracePath: leaksTrace, template: "Leaks", tableXml: leaksTableXml, parsedResult: results.leaks as Record<string, unknown> });
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
        const energyTableXml = tableXpath
          ? await xctraceExport({ inputPath: energyTrace, xpath: tableXpath })
          : tocXml;

        const { parseEnergy } = await import("../parsers/energy.js");
        results.energy = parseEnergy(tocXml, energyTableXml);
        traceIds.energy = storeTrace({ tracePath: energyTrace, template: "Energy Log", tableXml: energyTableXml, parsedResult: results.energy as Record<string, unknown> });
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
        const networkTableXml = tableXpath
          ? await xctraceExport({ inputPath: networkTrace, xpath: tableXpath })
          : tocXml;

        const { parseNetwork } = await import("../parsers/network.js");
        results.network = parseNetwork(tocXml, networkTableXml);
        traceIds.network = storeTrace({ tracePath: networkTrace, template: "Network", tableXml: networkTableXml, parsedResult: results.network as Record<string, unknown> });
      } catch (e) {
        results.network = { error: String(e) };
      }

      const overallSeverity = computeOverallSeverity(results);

      // Build compact audit report
      const templateMap: Record<string, { template: string; tracePath: string }> = {
        cpu: { template: "Time Profiler", tracePath: "" },
        hitches: { template: "Animation Hitches", tracePath: "" },
        leaks: { template: "Leaks", tracePath: "" },
        energy: { template: "Energy Log", tracePath: "" },
        network: { template: "Network", tracePath: "" },
      };

      const sections: string[] = [];
      sections.push(`=== Performance Audit ===  process: ${process}  duration/profile: ${duration}  overall: ${overallSeverity.toUpperCase()}`);
      sections.push("");

      for (const [key, info] of Object.entries(templateMap)) {
        const r = results[key];
        if (!r || (r as { error?: string }).error) {
          sections.push(`--- ${info.template}: ERROR ---`);
          sections.push((r as { error?: string })?.error || "Failed to record");
          sections.push("");
          continue;
        }

        const traceId = traceIds[key];
        const trace = traceId ? getTrace(traceId) : null;
        const tracePath = trace?.tracePath || "";

        // Format the profile section
        sections.push(formatProfileResult(info.template, r as Record<string, unknown>, traceId || "?", tracePath));
        sections.push("");

        // Add investigation
        const callTree = trace ? getOrBuildCallTree(trace) : null;
        const investigation = autoInvestigate(info.template, r as Record<string, unknown>, callTree, traceId);
        if (investigation) {
          sections.push(investigation);
          if (trace) trace.investigation = investigation;
        }
        sections.push("");
      }

      // Trace IDs summary
      sections.push("=== Trace IDs ===");
      for (const [key, id] of Object.entries(traceIds)) {
        sections.push(`  ${key}: ${id}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: sections.join("\n"),
          },
        ],
      };
    }
  );
}


/**
 * Determine the worst severity across all audit results.
 * Checks top-level `severity` field on each parser result.
 * Skips error entries (profiles that failed to record/parse).
 * Returns "critical" if any result is critical, "warning" if any is warning, otherwise "ok".
 */
function computeOverallSeverity(
  results: Record<string, unknown>
): "ok" | "warning" | "critical" {
  const severityOrder: Record<string, number> = { ok: 0, warning: 1, critical: 2 };
  let worst = 0;

  for (const value of Object.values(results)) {
    if (!value || typeof value !== "object") continue;
    // Skip error entries — a failed profile shouldn't mask real issues
    if ("error" in value) continue;

    if ("severity" in value) {
      const severity = (value as { severity: string }).severity;
      const level = severityOrder[severity] ?? 0;
      if (level > worst) worst = level;
    }
  }

  if (worst >= 2) return "critical";
  if (worst >= 1) return "warning";
  return "ok";
}
