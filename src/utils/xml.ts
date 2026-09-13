import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => {
    // These elements should always be arrays even if there's only one
    const arrayElements = [
      "row", "sample", "frame", "table", "run",
      "schema", "column", "node", "backtrace",
    ];
    return arrayElements.includes(name);
  },
});

/**
 * Parse xctrace XML export output into a JS object.
 * xctrace writes each repeated element once with id="" and afterwards only as
 * <element ref=""/>, so references are replaced by the element they point at.
 */
export function parseXml(xml: string): Record<string, unknown> {
  const data = parser.parse(xml) as Record<string, unknown>;
  const byId = new Map<string, Record<string, unknown>>();
  collectIds(data, byId);
  if (byId.size > 0) resolveRefs(data, byId);
  return data;
}

function collectIds(node: unknown, byId: Map<string, Record<string, unknown>>): void {
  if (node == null || typeof node !== "object") return;
  if (!Array.isArray(node)) {
    const id = (node as Record<string, unknown>)["@_id"];
    if (typeof id === "string") byId.set(id, node as Record<string, unknown>);
  }
  for (const value of Object.values(node)) collectIds(value, byId);
}

function resolveRefs(node: unknown, byId: Map<string, Record<string, unknown>>): void {
  if (node == null || typeof node !== "object") return;
  const container = node as Record<string, unknown>;
  for (const key of Object.keys(container)) {
    const value = container[key];
    const ref = value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)["@_ref"]
      : undefined;
    const target = typeof ref === "string" ? byId.get(ref) : undefined;
    // A resolved target is walked where it is defined, not again here
    if (target) container[key] = target;
    else resolveRefs(value, byId);
  }
}

/**
 * Safely navigate a nested object by dot-separated path.
 */
export function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
