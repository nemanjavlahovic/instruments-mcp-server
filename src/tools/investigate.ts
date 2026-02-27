/**
 * Investigation tools for multi-turn trace exploration.
 * Enables the LLM to drill deeper into profiling data instead of getting one flat summary.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { drillDown, listTraces } from "../utils/trace-store.js";
import { formatDrillDown } from "../utils/format-output.js";

export function registerInvestigateTools(server: McpServer): void {
  server.tool(
    "drill_down",
    `Navigate deeper into profiling data from a previous profile result.
Use the traceId returned by any profile_* tool to investigate further.

CPU traces: Pass a function name to see its callers (who calls it), callees (what it calls), and the heaviest execution path. Use "hottest" to auto-select the most expensive function.

Other templates: Pass a search term (category, domain, view name, leak type) to see full detail for matching rows that were truncated in the initial summary.

Examples:
  drill_down(trace_id: "t_abc123", target: "CoreData.executeFetchRequest")
  drill_down(trace_id: "t_abc123", target: "hottest")
  drill_down(trace_id: "t_abc123", target: "api.example.com")`,
    {
      trace_id: z.string().describe("Trace ID from a previous profile_* result"),
      target: z
        .string()
        .describe(
          'Function name for CPU traces, "hottest" for auto-select, or search term for other templates'
        ),
    },
    async ({ trace_id, target }) => {
      try {
        const result = drillDown(trace_id, target);
        if (!result) {
          const traces = listTraces();
          const available =
            traces.length > 0
              ? `Available traces:\n${traces.map((t) => `  ${t.traceId} — ${t.template} (${t.storedAt})`).join("\n")}`
              : "No traces stored. Run a profile_* tool first.";
          return {
            content: [
              {
                type: "text" as const,
                text: `Trace "${trace_id}" not found. ${available}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text" as const, text: formatDrillDown(result) },
          ],
        };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: `Drill down failed: ${e}` },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_traces",
    `List profiling traces available for investigation with drill_down.
Shows trace IDs, templates, and timestamps from this session's profile_* calls.`,
    {},
    async () => {
      const traces = listTraces();
      if (traces.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No traces stored yet. Run a profile_* tool to record and store trace data.",
            },
          ],
        };
      }
      const lines: string[] = [`=== Stored Traces (${traces.length}) ===`, ""];
      for (const t of traces) {
        const preview = t.investigationPreview ? `  ${t.investigationPreview}` : "";
        lines.push(`  ${t.traceId}  ${t.template}  ${t.storedAt}${preview}`);
      }
      lines.push("");
      lines.push("Use drill_down(trace_id, target) to investigate further.");
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
        ],
      };
    }
  );
}
