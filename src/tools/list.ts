import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { verifyXctrace, xctraceList } from "../utils/xctrace.js";

export function registerListTools(server: McpServer): void {
  server.tool(
    "instruments_status",
    "Check if Instruments (xctrace) is available on this system and return version info",
    {},
    async () => {
      const result = await verifyXctrace();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "instruments_list_templates",
    "List all available Instruments profiling templates (Time Profiler, SwiftUI, Allocations, etc.)",
    {},
    async () => {
      try {
        const output = await xctraceList("templates");
        const templates = parseListOutput(output);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                count: templates.length,
                templates,
                recommended: [
                  "Time Profiler - CPU hotspots and slow functions (profile_cpu)",
                  "SwiftUI - View body re-evaluation performance (profile_swiftui)",
                  "Animation Hitches - Dropped frames, scroll jank (profile_hitches)",
                  "Allocations - Heap memory usage (profile_memory)",
                  "Leaks - Memory leak detection (profile_leaks)",
                  "Energy Log - Battery drain and thermal analysis (profile_energy)",
                  "App Launch - Startup time breakdown (profile_launch)",
                  "Network - HTTP traffic analysis (profile_network)",
                ],
              }, null, 2),
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
      }
    }
  );

  server.tool(
    "instruments_list_devices",
    "List all available devices and simulators that can be profiled",
    {},
    async () => {
      try {
        const output = await xctraceList("devices");
        return {
          content: [{ type: "text" as const, text: output }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
      }
    }
  );

  server.tool(
    "instruments_list_instruments",
    "List all available individual instruments that can be combined into custom recordings",
    {},
    async () => {
      try {
        const output = await xctraceList("instruments");
        return {
          content: [{ type: "text" as const, text: output }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
      }
    }
  );
}

function parseListOutput(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("=="));
}
