import { parseXml } from "../utils/xml.js";
import { extractRows, extractStr, extractFmt, extractNum, extractFmtNum, type Row } from "../utils/extractors.js";

export interface EnergyImpactSample {
  energyImpact: number;
  cpu: number | null;
  gpu: number | null;
  networking: number | null;
  display: number | null;
  location: number | null;
  overhead: number | null;
}

export interface EnergyResult {
  template: "Energy Log";
  totalSamples: number;
  averageEnergyImpact: number;
  peakEnergyImpact: number;
  timeInHighEnergyPct: number;
  topComponents: Array<{ component: string; averageImpact: number; peakImpact: number }>;
  thermalState: string | null;
  severity: "ok" | "warning" | "critical";
  summary: string;
}

/**
 * Parse Energy Log trace export XML into a structured result.
 *
 * Apple's energy impact thresholds:
 *   0–3   = Low (ok)
 *   4–8   = Moderate (ok)
 *   9–15  = High (warning)
 *   16–20 = Very High (critical)
 */
export function parseEnergy(tocXml: string, tableXml: string): EnergyResult {
  const tableData = parseXml(tableXml);
  const rows = extractRows(tableData);

  if (rows.length === 0) {
    return {
      template: "Energy Log",
      totalSamples: 0,
      averageEnergyImpact: 0,
      peakEnergyImpact: 0,
      timeInHighEnergyPct: 0,
      topComponents: [],
      thermalState: null,
      severity: "ok",
      summary:
        "No energy data captured. Ensure the app was active during recording and the device supports energy monitoring (physical device recommended).",
    };
  }

  const samples = extractSamples(rows);
  const totalSamples = samples.length || rows.length;

  const impacts = samples.map((s) => s.energyImpact).filter((v) => v > 0);
  const averageEnergyImpact =
    impacts.length > 0
      ? Math.round((impacts.reduce((a, b) => a + b, 0) / impacts.length) * 10) / 10
      : 0;
  const peakEnergyImpact = impacts.length > 0 ? Math.max(...impacts) : 0;

  const highSamples = impacts.filter((v) => v >= 9).length;
  const timeInHighEnergyPct =
    impacts.length > 0 ? Math.round((highSamples / impacts.length) * 100) : 0;

  const topComponents = computeTopComponents(samples);
  const thermalState = detectThermalState(rows);
  const severity = classifyEnergySeverity(averageEnergyImpact, peakEnergyImpact, timeInHighEnergyPct);

  return {
    template: "Energy Log",
    totalSamples,
    averageEnergyImpact,
    peakEnergyImpact,
    timeInHighEnergyPct,
    topComponents,
    thermalState,
    severity,
    summary: buildSummary(averageEnergyImpact, peakEnergyImpact, timeInHighEnergyPct, topComponents, thermalState, severity),
  };
}

// ── Sample extraction ───────────────────────────────────────────────

function extractSamples(rows: Row[]): EnergyImpactSample[] {
  const samples: EnergyImpactSample[] = [];

  for (const row of rows) {
    const impact = extractEnergyImpact(row);
    if (impact == null) continue;

    samples.push({
      energyImpact: impact,
      cpu: extractComponentValue(row, ["cpu", "cpu-energy", "cpu-power"]),
      gpu: extractComponentValue(row, ["gpu", "gpu-energy", "gpu-power"]),
      networking: extractComponentValue(row, ["networking", "network", "net-energy", "network-power"]),
      display: extractComponentValue(row, ["display", "screen", "display-energy", "display-power"]),
      location: extractComponentValue(row, ["location", "gps", "location-energy"]),
      overhead: extractComponentValue(row, ["overhead", "system", "overhead-energy", "overhead-power"]),
    });
  }

  return samples;
}

function extractEnergyImpact(row: Row): number | null {
  for (const key of ["energy-impact", "energyImpact", "impact", "energy", "energy-level", "level", "energy-overhead"]) {
    const val = extractNum(row, key);
    if (val != null && val >= 0) return val;
  }

  for (const key of ["energy-impact", "impact", "energy"]) {
    const val = row[key];
    if (val && typeof val === "object") {
      const obj = val as Row;
      const fmt = obj["@_fmt"] as string;
      if (fmt) {
        const slashMatch = fmt.match(/^(\d+(?:\.\d+)?)\s*\/\s*\d+/);
        if (slashMatch) return parseFloat(slashMatch[1]);
        const numMatch = fmt.match(/^(\d+(?:\.\d+)?)/);
        if (numMatch) return parseFloat(numMatch[1]);
      }
      const text = obj["#text"];
      if (text != null) {
        const num = Number(text);
        if (!isNaN(num)) return num;
      }
    }
  }

  return null;
}

function extractComponentValue(row: Row, keys: string[]): number | null {
  for (const key of keys) {
    const val = extractNum(row, key);
    if (val != null) return val;
    const fmtVal = extractFmtNum(row, key);
    if (fmtVal != null) return fmtVal;
  }
  return null;
}

// ── Component ranking ───────────────────────────────────────────────

function computeTopComponents(
  samples: EnergyImpactSample[]
): Array<{ component: string; averageImpact: number; peakImpact: number }> {
  if (samples.length === 0) return [];

  const components: Array<{ name: string; key: keyof EnergyImpactSample }> = [
    { name: "CPU", key: "cpu" },
    { name: "GPU", key: "gpu" },
    { name: "Networking", key: "networking" },
    { name: "Display", key: "display" },
    { name: "Location", key: "location" },
    { name: "Overhead", key: "overhead" },
  ];

  const results: Array<{ component: string; averageImpact: number; peakImpact: number }> = [];

  for (const comp of components) {
    const values = samples
      .map((s) => s[comp.key] as number | null)
      .filter((v): v is number => v != null && v > 0);

    if (values.length === 0) continue;

    results.push({
      component: comp.name,
      averageImpact: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
      peakImpact: Math.max(...values),
    });
  }

  return results.sort((a, b) => b.averageImpact - a.averageImpact);
}

// ── Thermal state detection ─────────────────────────────────────────

function detectThermalState(rows: Row[]): string | null {
  let worstState: string | null = null;
  let worstLevel = -1;

  const stateOrder: Record<string, number> = { nominal: 0, fair: 1, serious: 2, critical: 3 };

  for (const row of rows) {
    for (const key of ["thermal-state", "thermalState", "thermal", "thermal-pressure"]) {
      const val = extractStr(row, key) || extractFmt(row, key);
      if (val) {
        const lower = val.toLowerCase();
        for (const [state, level] of Object.entries(stateOrder)) {
          if (lower.includes(state) && level > worstLevel) {
            worstState = state;
            worstLevel = level;
          }
        }
      }
    }
  }

  return worstState;
}

// ── Severity classification ─────────────────────────────────────────

function classifyEnergySeverity(avg: number, peak: number, highPct: number): "ok" | "warning" | "critical" {
  if (avg >= 13 || peak >= 20 || highPct > 50) return "critical";
  if (avg >= 8 || peak >= 16 || highPct > 25) return "warning";
  return "ok";
}

// ── Summary ─────────────────────────────────────────────────────────

function buildSummary(
  avg: number,
  peak: number,
  highPct: number,
  topComponents: Array<{ component: string; averageImpact: number; peakImpact: number }>,
  thermalState: string | null,
  severity: "ok" | "warning" | "critical"
): string {
  if (avg === 0 && peak === 0) {
    return "No measurable energy impact. The app may have been idle during recording.";
  }

  const parts: string[] = [];
  parts.push(`Energy impact: avg ${avg}/20, peak ${peak}/20 — ${severity.toUpperCase()}`);

  if (highPct > 0) {
    parts.push(`${highPct}% of recording time spent in high energy state (impact >= 9)`);
  }

  if (severity === "critical") {
    parts.push("Excessive energy usage will drain battery rapidly and may trigger thermal throttling");
  } else if (severity === "warning") {
    parts.push("Elevated energy usage — review top consumers to improve battery life");
  }

  if (topComponents.length > 0) {
    const top = topComponents
      .slice(0, 3)
      .map((c) => `${c.component} (avg ${c.averageImpact}, peak ${c.peakImpact})`)
      .join(", ");
    parts.push(`Top consumers: ${top}`);
  }

  if (thermalState && thermalState !== "nominal") {
    const label = thermalState.charAt(0).toUpperCase() + thermalState.slice(1);
    parts.push(`Thermal state reached: ${label}`);
  }

  return parts.join(". ") + ".";
}
