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
 */
export function parseXml(xml: string): Record<string, unknown> {
  return parser.parse(xml) as Record<string, unknown>;
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
