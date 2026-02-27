/**
 * Shared template→parser routing used by CLI, simulator tools, and stop_profiling.
 * Single source of truth — eliminates duplicated routing in cli.ts and simulator.ts.
 */

import { xctraceExport } from "./xctrace.js";
import { findTableXpath, findTrackXpath } from "./trace-helpers.js";
import type { TimeProfileResult } from "../parsers/time-profiler.js";
import type { SwiftUIProfileResult } from "../parsers/swiftui.js";
import type { AllocationsResult } from "../parsers/allocations.js";
import type { HangsResult } from "../parsers/hangs.js";
import type { AppLaunchResult } from "../parsers/app-launch.js";
import type { EnergyResult } from "../parsers/energy.js";
import type { LeaksResult } from "../parsers/leaks.js";
import type { NetworkResult } from "../parsers/network.js";

/** Fallback result for templates without a dedicated parser. */
export interface RawTraceResult {
  template: string;
  toc: string;
  hint: string;
}

/** Union of all parser result types. */
export type ParserResult =
  | TimeProfileResult
  | SwiftUIProfileResult
  | AllocationsResult
  | HangsResult
  | AppLaunchResult
  | EnergyResult
  | LeaksResult
  | NetworkResult
  | RawTraceResult;

/**
 * Route a trace file to the appropriate parser based on template name.
 * Handles TOC export, table/track xpath resolution, and Deferred mode fallback.
 */
export async function parseTraceByTemplate(
  tracePath: string,
  template: string
): Promise<ParserResult> {
  const tocXml = await xctraceExport({ inputPath: tracePath, toc: true });
  const t = template.toLowerCase();

  if (t.includes("time profiler") || t.includes("time-profiler")) {
    const { parseTimeProfiler } = await import("../parsers/time-profiler.js");
    const profileXpath = findTableXpath(tocXml, "time-profile");
    const tableXml = profileXpath ? await xctraceExport({ inputPath: tracePath, xpath: profileXpath }) : tocXml;
    let result = parseTimeProfiler(tocXml, tableXml);
    // Deferred mode fallback (xctrace 26+)
    if (result.totalSamples < 10) {
      const sampleXpath = findTableXpath(tocXml, "time-sample");
      if (sampleXpath) {
        const sampleXml = await xctraceExport({ inputPath: tracePath, xpath: sampleXpath });
        const sampleResult = parseTimeProfiler(tocXml, sampleXml);
        if (sampleResult.totalSamples > result.totalSamples) result = sampleResult;
      }
    }
    return result;
  }

  if (t.includes("swiftui")) {
    const { parseSwiftUI } = await import("../parsers/swiftui.js");
    const xpath = findTableXpath(tocXml, "view-body") || findTableXpath(tocXml, "swiftui");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseSwiftUI(tocXml, tableXml);
  }

  if (t.includes("alloc")) {
    const { parseAllocations } = await import("../parsers/allocations.js");
    const xpath = findTableXpath(tocXml, "alloc");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseAllocations(tocXml, tableXml);
  }

  if (t.includes("hitch") || t.includes("animation")) {
    const { parseHangs } = await import("../parsers/hangs.js");
    const xpath = findTableXpath(tocXml, "hang") || findTableXpath(tocXml, "hitch");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseHangs(tocXml, tableXml);
  }

  if (t.includes("launch") || t.includes("app launch")) {
    const { parseAppLaunch } = await import("../parsers/app-launch.js");
    const xpath =
      findTableXpath(tocXml, "app-launch") ||
      findTableXpath(tocXml, "lifecycle") ||
      findTableXpath(tocXml, "os-signpost") ||
      findTableXpath(tocXml, "signpost");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseAppLaunch(tocXml, tableXml);
  }

  if (t.includes("energy")) {
    const { parseEnergy } = await import("../parsers/energy.js");
    const xpath =
      findTableXpath(tocXml, "energy") ||
      findTableXpath(tocXml, "power") ||
      findTableXpath(tocXml, "battery") ||
      findTableXpath(tocXml, "diagnostics");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseEnergy(tocXml, tableXml);
  }

  if (t.includes("leak")) {
    const { parseLeaks } = await import("../parsers/leaks.js");
    const xpath =
      findTableXpath(tocXml, "leak") ||
      findTrackXpath(tocXml, "leak") ||
      findTableXpath(tocXml, "alloc");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseLeaks(tocXml, tableXml);
  }

  if (t.includes("network")) {
    const { parseNetwork } = await import("../parsers/network.js");
    const xpath =
      findTableXpath(tocXml, "http") ||
      findTableXpath(tocXml, "network") ||
      findTrackXpath(tocXml, "http") ||
      findTrackXpath(tocXml, "network");
    const tableXml = xpath ? await xctraceExport({ inputPath: tracePath, xpath }) : tocXml;
    return parseNetwork(tocXml, tableXml);
  }

  return {
    template,
    toc: tocXml,
    hint: "No dedicated parser for this template. Use analyze_trace with the tracePath to drill into specific tables.",
  };
}
